import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'
import { registerProjects } from './projects/routes.js'

export interface AppDeps {
  db: Db
  github?: { clientId: string; exchange: GithubExchange }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  registerProjects(app, { db: deps.db })
  if (deps.github) registerGithubAuth(app, { db: deps.db, ...deps.github })
  return app
}
