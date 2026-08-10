import Fastify, { type FastifyInstance } from 'fastify'

export interface AppDeps {
  db?: unknown
}

export function buildApp(_deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  return app
}
