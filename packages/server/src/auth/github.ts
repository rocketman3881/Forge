import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createSession } from './sessions.js'

export class GithubExchangeError extends Error {}

export type GithubExchange = (
  code: string,
) => Promise<{ githubId: number; handle: string; accessToken: string }>

const STATE_TTL_MS = 10 * 60 * 1000

function isLoopbackRedirect(uri: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

export function makeGithubExchange(clientId: string, clientSecret: string): GithubExchange {
  return async (code) => {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    if (!tokenRes.ok) throw new GithubExchangeError(`token exchange failed: ${tokenRes.status}`)
    const { access_token } = (await tokenRes.json()) as { access_token?: string }
    if (!access_token) throw new GithubExchangeError('no access_token in exchange response')
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${access_token}` },
    })
    if (!userRes.ok) throw new GithubExchangeError(`user fetch failed: ${userRes.status}`)
    const gh = (await userRes.json()) as { id?: number; login?: string }
    if (typeof gh.id !== 'number' || !gh.login) throw new GithubExchangeError('malformed user response')
    return { githubId: gh.id, handle: gh.login, accessToken: access_token }
  }
}

export function registerGithubAuth(
  app: FastifyInstance,
  deps: { db: Db; clientId: string; exchange: GithubExchange },
): void {
  const pending = new Map<string, { redirectUri: string; expiresAt: number }>()

  app.get<{ Querystring: { redirect_uri?: string } }>('/auth/github/start', async (req, reply) => {
    if (!req.query.redirect_uri || !isLoopbackRedirect(req.query.redirect_uri)) {
      return reply.code(400).send({ error: 'redirect_uri must be a loopback address' })
    }

    // Sweep expired entries
    for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k)

    const state = randomBytes(16).toString('base64url')
    pending.set(state, { redirectUri: req.query.redirect_uri, expiresAt: Date.now() + STATE_TTL_MS })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', deps.clientId)
    url.searchParams.set('state', state)
    return reply.redirect(url.toString(), 302)
  })

  app.get<{ Querystring: { code: string; state: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const entry = pending.get(req.query.state)
      if (!entry || entry.expiresAt < Date.now()) {
        pending.delete(req.query.state)
        return reply.code(400).send({ error: 'unknown state' })
      }
      const redirectUri = entry.redirectUri
      pending.delete(req.query.state)

      let gh: Awaited<ReturnType<GithubExchange>>
      try {
        gh = await deps.exchange(req.query.code)
      } catch (err) {
        if (err instanceof GithubExchangeError) {
          return reply.code(502).send({ error: 'github exchange failed' })
        }
        throw err
      }

      const { rows } = await deps.db.query<{ id: string | number }>(
        `INSERT INTO users (github_id, handle) VALUES ($1, $2)
         ON CONFLICT (github_id) DO UPDATE SET handle = EXCLUDED.handle
         RETURNING id`,
        [gh.githubId, gh.handle],
      )
      const token = await createSession(deps.db, Number(rows[0]!.id))
      return reply.redirect(`${redirectUri}#token=${token}`, 302)
    },
  )
}
