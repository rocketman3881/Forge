import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'
import { parseId } from '../lib/params.js'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export type StripeValidate = (apiKey: string) => Promise<boolean>
export type WebhookCreate = (githubToken: string, repoFullName: string) => Promise<boolean>

interface Deps {
  db: Db
  secretKey: Buffer
  notifier: Notifier
  stripeValidate: StripeValidate
  webhookCreate: WebhookCreate
}

async function ownedProject(
  deps: Deps,
  req: { headers: { authorization?: string }; params: { projectId: string } },
): Promise<{ status: 200; projectId: number; userId: number } | { status: 400 | 401 | 403 }> {
  const user = await userFromRequest(deps.db, req)
  if (!user) return { status: 401 }
  const projectId = parseId(req.params.projectId)
  if (projectId === null) return { status: 400 }
  const { rows } = await deps.db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2`, [projectId, user.id],
  )
  if (!rows[0]) return { status: 403 }
  return { status: 200, projectId, userId: user.id }
}

export function registerIntegrations(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { projectId: string }; Body: { apiKey: string } }>(
    '/projects/:projectId/stripe',
    {
      schema: {
        body: {
          type: 'object', required: ['apiKey'],
          properties: { apiKey: { type: 'string', minLength: 1, maxLength: 200 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      if (!(await deps.stripeValidate(req.body.apiKey))) {
        return reply.code(400).send({ error: 'invalid stripe key' })
      }
      await deps.db.query(
        `INSERT INTO project_integrations (project_id, provider, secret_enc) VALUES ($1, 'stripe', $2)
         ON CONFLICT (project_id, provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc`,
        [own.projectId, encryptSecret(req.body.apiKey, deps.secretKey)],
      )
      await emitMilestone(deps.db, deps.notifier, {
        projectId: own.projectId, vertical: 'revenue', rung: 1,
        evidenceRef: 'stripe:connected', dedupeKey: `stripe-connected-${own.projectId}`,
      })
      return reply.send({ connected: true })
    },
  )

  app.post<{ Params: { projectId: string }; Body: { repoFullName: string } }>(
    '/projects/:projectId/repo',
    {
      schema: {
        body: {
          type: 'object', required: ['repoFullName'],
          properties: {
            repoFullName: { type: 'string', minLength: 3, maxLength: 140, pattern: '^[^/\\s]+/[^/\\s]+$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      const { rows } = await deps.db.query<{ secret_enc: string }>(
        `SELECT secret_enc FROM user_integrations WHERE user_id = $1 AND provider = 'github'`,
        [own.userId],
      )
      if (!rows[0]) return reply.code(409).send({ error: 'connect github first' })
      const token = decryptSecret(rows[0].secret_enc, deps.secretKey)
      if (!(await deps.webhookCreate(token, req.body.repoFullName))) {
        return reply.code(502).send({ error: 'could not create webhook' })
      }
      await deps.db.query(`UPDATE projects SET repo_full_name = $1 WHERE id = $2`, [
        req.body.repoFullName, own.projectId,
      ])
      return reply.send({ linked: true })
    },
  )

  app.patch<{ Params: { projectId: string }; Body: { deployUrl: string } }>(
    '/projects/:projectId',
    {
      schema: {
        body: {
          type: 'object', required: ['deployUrl'],
          properties: { deployUrl: { type: 'string', minLength: 1, maxLength: 300 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      let parsed: URL
      try {
        parsed = new URL(req.body.deployUrl)
      } catch {
        return reply.code(400).send({ error: 'invalid url' })
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return reply.code(400).send({ error: 'invalid url' })
      }
      await deps.db.query(`UPDATE projects SET deploy_url = $1 WHERE id = $2`, [
        req.body.deployUrl, own.projectId,
      ])
      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { projectId: string }; Body: { domain: string } }>(
    '/projects/:projectId/domain',
    {
      schema: {
        body: {
          type: 'object', required: ['domain'],
          properties: { domain: { type: 'string', minLength: 4, maxLength: 253, pattern: '^[a-z0-9.-]+$' } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      const token = `forge-verify=${randomBytes(16).toString('base64url')}`
      await deps.db.query(
        `INSERT INTO domain_challenges (project_id, domain, token) VALUES ($1, $2, $3)
         ON CONFLICT (project_id) DO UPDATE SET domain = EXCLUDED.domain, token = EXCLUDED.token`,
        [own.projectId, req.body.domain, token],
      )
      return reply.send({ record: `_forge.${req.body.domain}`, value: token })
    },
  )
}
