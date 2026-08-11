import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'
import { registerProjects } from './projects/routes.js'
import { registerClans } from './clans/routes.js'
import { registerCheckins } from './checkins/routes.js'
import { registerIntegrations, type StripeValidate, type WebhookCreate } from './integrations/routes.js'
import { registerGithubWebhook } from './workers/github-webhook.js'
import { listProjectEvents, listClanFeed } from './events/log.js'
import { userFromRequest } from './auth/sessions.js'
import { parseId } from './lib/params.js'
import { type Notifier, nullNotifier } from './events/emit.js'

export interface AppDeps {
  db: Db
  secretKey?: Buffer
  notifier?: Notifier
  github?: { clientId: string; exchange: GithubExchange }
  integrations?: { stripeValidate: StripeValidate; webhookCreate: WebhookCreate }
  githubWebhookSecret?: string
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  registerProjects(app, { db: deps.db })
  registerClans(app, { db: deps.db })
  registerCheckins(app, { db: deps.db })
  if (deps.github) registerGithubAuth(app, { db: deps.db, secretKey: deps.secretKey, ...deps.github })
  if (deps.secretKey && deps.integrations) {
    registerIntegrations(app, {
      db: deps.db,
      secretKey: deps.secretKey,
      notifier: deps.notifier ?? nullNotifier,
      ...deps.integrations,
    })
  }
  if (deps.githubWebhookSecret) {
    registerGithubWebhook(app, {
      db: deps.db, notifier: deps.notifier ?? nullNotifier, secret: deps.githubWebhookSecret,
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

  return app
}
