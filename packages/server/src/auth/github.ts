import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createSession } from './sessions.js'

export type GithubExchange = (code: string) => Promise<{ githubId: number; handle: string }>

export function makeGithubExchange(clientId: string, clientSecret: string): GithubExchange {
  return async (code) => {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    const { access_token } = (await tokenRes.json()) as { access_token: string }
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${access_token}` },
    })
    const gh = (await userRes.json()) as { id: number; login: string }
    return { githubId: gh.id, handle: gh.login }
  }
}

export function registerGithubAuth(
  app: FastifyInstance,
  deps: { db: Db; clientId: string; exchange: GithubExchange },
): void {
  const pending = new Map<string, string>() // state -> redirect_uri

  app.get<{ Querystring: { redirect_uri: string } }>('/auth/github/start', async (req, reply) => {
    const state = randomBytes(16).toString('base64url')
    pending.set(state, req.query.redirect_uri)
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', deps.clientId)
    url.searchParams.set('state', state)
    return reply.redirect(url.toString(), 302)
  })

  app.get<{ Querystring: { code: string; state: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const redirectUri = pending.get(req.query.state)
      if (!redirectUri) return reply.code(400).send({ error: 'unknown state' })
      pending.delete(req.query.state)

      const gh = await deps.exchange(req.query.code)
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
