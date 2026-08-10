import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'

export interface AppDeps {
  db: Db
  github?: { clientId: string; exchange: GithubExchange }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  if (deps.github) registerGithubAuth(app, { db: deps.db, ...deps.github })
  return app
}
