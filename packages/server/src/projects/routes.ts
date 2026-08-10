import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'

export function registerProjects(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Body: { name: string } }>(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const { rows } = await deps.db.query<{ id: string | number }>(
        `INSERT INTO projects (owner_id, name) VALUES ($1, $2)
         ON CONFLICT (owner_id, name) DO NOTHING RETURNING id`,
        [user.id, req.body.name],
      )
      if (!rows[0]) return reply.code(409).send({ error: 'project name already exists' })
      return reply.code(201).send({ id: Number(rows[0].id), name: req.body.name })
    },
  )

  app.get('/projects', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { rows } = await deps.db.query<{
      id: string | number; name: string; repo_full_name: string | null; deploy_url: string | null
    }>(
      `SELECT id, name, repo_full_name, deploy_url FROM projects
       WHERE owner_id = $1 ORDER BY name ASC`,
      [user.id],
    )
    return reply.send({
      projects: rows.map((r) => ({
        id: Number(r.id), name: r.name, repoFullName: r.repo_full_name, deployUrl: r.deploy_url,
      })),
    })
  })
}
