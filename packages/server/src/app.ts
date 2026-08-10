import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'
import { registerProjects } from './projects/routes.js'
import { registerClans } from './clans/routes.js'
import { registerCheckins } from './checkins/routes.js'
import { listProjectEvents, listClanFeed } from './events/log.js'
import { userFromRequest } from './auth/sessions.js'

export interface AppDeps {
  db: Db
  github?: { clientId: string; exchange: GithubExchange }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  registerProjects(app, { db: deps.db })
  registerClans(app, { db: deps.db })
  registerCheckins(app, { db: deps.db })
  if (deps.github) registerGithubAuth(app, { db: deps.db, ...deps.github })

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/events', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const projectId = Number(req.params.projectId)
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
    const clanId = Number(req.params.clanId)
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
    return reply.send({ events: await listClanFeed(deps.db, clanId) })
  })

  return app
}
