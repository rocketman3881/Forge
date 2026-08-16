import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'
import { registerProjects } from './projects/routes.js'
import { registerClans } from './clans/routes.js'
import { registerCheckins } from './checkins/routes.js'
import { registerIntegrations, type PlausibleValidate, type StripeValidate, type WebhookCreate } from './integrations/routes.js'
import { registerGithubWebhook } from './workers/github-webhook.js'
import { listProjectEvents, listClanFeed } from './events/log.js'
import { userFromRequest } from './auth/sessions.js'
import { parseId } from './lib/params.js'
import { type Notifier, nullNotifier } from './events/emit.js'
import { registerClanSocket, type ClanBroadcaster } from './realtime/broadcaster.js'

export interface AppDeps {
  db: Db
  /** Public base URL substituted into the web page and installer script. */
  publicUrl?: string
  secretKey?: Buffer
  notifier?: Notifier
  github?: { clientId: string; exchange: GithubExchange }
  integrations?: { stripeValidate: StripeValidate; webhookCreate: WebhookCreate; plausibleValidate?: PlausibleValidate }
  githubWebhookSecret?: string
  broadcaster?: ClanBroadcaster
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  const notifier = deps.notifier ?? deps.broadcaster ?? nullNotifier
  if (deps.broadcaster) registerClanSocket(app, { db: deps.db, broadcaster: deps.broadcaster })
  app.get('/health', async () => ({ ok: true }))
  registerWebPages(app, deps.publicUrl ?? 'http://localhost:3000')
  registerProjects(app, { db: deps.db })
  registerClans(app, { db: deps.db })
  registerCheckins(app, { db: deps.db })
  if (deps.github) registerGithubAuth(app, { db: deps.db, secretKey: deps.secretKey, ...deps.github })
  if (deps.secretKey && deps.integrations) {
    registerIntegrations(app, {
      db: deps.db,
      secretKey: deps.secretKey,
      notifier,
      ...deps.integrations,
    })
  }
  if (deps.githubWebhookSecret) {
    registerGithubWebhook(app, {
      db: deps.db, notifier, secret: deps.githubWebhookSecret,
    })
  }

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/events', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const projectId = parseId(req.params.projectId)
    if (projectId === null) return reply.code(400).send({ error: 'invalid id' })
    const owner = await deps.db.query(
      `SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2`,
      [projectId, user.id],
    )
    if (!owner.rows[0]) return reply.code(403).send({ error: 'not your project' })
    return reply.send({ events: await listProjectEvents(deps.db, projectId) })
  })

  app.get<{ Params: { clanId: string } }>('/clans/:clanId/feed', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = parseId(req.params.clanId)
    if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
    return reply.send({ events: await listClanFeed(deps.db, clanId) })
  })

  // Presence: who in the clan has a live sidebar socket right now.
  app.get<{ Params: { clanId: string } }>('/clans/:clanId/presence', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = parseId(req.params.clanId)
    if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
    return reply.send({ online: deps.broadcaster?.online(clanId) ?? [] })
  })

  // Nudge a clanmate. Delivered live over the clan socket and kept for 24h pickup.
  app.post<{ Params: { clanId: string }; Body: { to: string; message: string } }>(
    '/clans/:clanId/ping',
    {
      schema: {
        body: {
          type: 'object', required: ['to', 'message'],
          properties: {
            to: { type: 'string', minLength: 1, maxLength: 60 },
            message: { type: 'string', minLength: 1, maxLength: 120 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const clanId = parseId(req.params.clanId)
      if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
      const member = await deps.db.query(
        `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [clanId, user.id],
      )
      if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
      const target = await deps.db.query<{ id: number }>(
        `SELECT u.id FROM users u JOIN clan_members cm ON cm.user_id = u.id
         WHERE cm.clan_id = $1 AND u.handle = $2`,
        [clanId, req.body.to],
      )
      if (!target.rows[0]) return reply.code(404).send({ error: 'no such clanmate' })
      const recent = await deps.db.query(
        `SELECT 1 FROM pings WHERE clan_id = $1 AND from_user = $2 AND to_user = $3
         AND created_at > now() - interval '2 minutes'`,
        [clanId, user.id, target.rows[0].id],
      )
      if (recent.rows[0]) return reply.code(429).send({ error: 'easy — one ping per person every 2 minutes' })
      await deps.db.query(
        `INSERT INTO pings (clan_id, from_user, to_user, message) VALUES ($1, $2, $3, $4)`,
        [clanId, user.id, target.rows[0].id, req.body.message],
      )
      deps.broadcaster?.ping(clanId, user.handle, req.body.to, req.body.message)
      return reply.send({ sent: true })
    },
  )

  // Pings addressed to me in the last 24h (offline pickup).
  app.get<{ Params: { clanId: string } }>('/clans/:clanId/pings', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = parseId(req.params.clanId)
    if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
    const { rows } = await deps.db.query<{ handle: string; message: string; created_at: string }>(
      `SELECT f.handle, p.message, p.created_at FROM pings p
       JOIN users f ON f.id = p.from_user
       WHERE p.clan_id = $1 AND p.to_user = $2 AND p.created_at > now() - interval '24 hours'
       ORDER BY p.created_at DESC LIMIT 10`,
      [clanId, user.id],
    )
    return reply.send({
      pings: rows.map((r) => ({ from: r.handle, message: r.message, at: r.created_at })),
    })
  })

  // Shared metrics only: a row appears solely when the owner opted in via /share.
  app.get<{ Params: { clanId: string } }>('/clans/:clanId/metrics', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = parseId(req.params.clanId)
    if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
    const { rows } = await deps.db.query<{
      handle: string; project_name: string; metric: string; value: string; captured_at: string
    }>(
      `SELECT u.handle, p.name AS project_name, ms.metric, ms.value, ms.captured_at
       FROM metric_snapshots ms
       JOIN metric_shares sh ON sh.project_id = ms.project_id AND sh.metric = ms.metric
       JOIN projects p ON p.id = ms.project_id
       JOIN users u ON u.id = p.owner_id
       JOIN clan_members cm ON cm.user_id = u.id AND cm.clan_id = $1
       ORDER BY u.handle, ms.metric`,
      [clanId],
    )
    return reply.send({
      metrics: rows.map((r) => ({
        handle: r.handle,
        projectName: r.project_name,
        metric: r.metric,
        value: Number(r.value),
        capturedAt: r.captured_at,
      })),
    })
  })

  return app
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

function registerWebPages(app: FastifyInstance, publicUrl: string): void {
  const page = (file: string): string | null => {
    try {
      return readFileSync(join(publicDir, file), 'utf8').replaceAll('__FORGE_SERVER__', publicUrl)
    } catch {
      return null
    }
  }
  app.get('/', async (_req, reply) => {
    const html = page('index.html')
    if (!html) return reply.code(404).send({ error: 'not found' })
    return reply.type('text/html; charset=utf-8').send(html)
  })
  app.get('/install.sh', async (_req, reply) => {
    const sh = page('install.sh')
    if (!sh) return reply.code(404).send({ error: 'not found' })
    return reply.type('text/plain; charset=utf-8').send(sh)
  })
}
