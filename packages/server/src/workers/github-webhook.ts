import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { emitMilestone, type Notifier } from '../events/emit.js'
import type { WebhookCreate } from '../integrations/routes.js'

interface Deps {
  db: Db
  notifier: Notifier
  secret: string
}

function verify(secret: string, raw: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const got = header.slice(7)
  if (got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'))
}

interface Detection {
  rung: number
  evidenceRef: string
}

export function detectBuildMilestone(event: string, p: Record<string, unknown>): Detection | null {
  const pr = p.pull_request as { merged?: boolean; number?: number } | undefined
  const run = p.workflow_run as { id?: number; conclusion?: string; head_branch?: string } | undefined
  const repo = p.repository as { default_branch?: string } | undefined
  const release = p.release as { tag_name?: string } | undefined
  if (event === 'push' && typeof p.after === 'string') {
    return { rung: 1, evidenceRef: `github:push:${p.after}` }
  }
  if (event === 'pull_request' && p.action === 'closed' && pr?.merged === true) {
    return { rung: 2, evidenceRef: `github:pr:${pr.number ?? 'unknown'}` }
  }
  if (
    event === 'workflow_run' && p.action === 'completed' &&
    run?.conclusion === 'success' && run.head_branch === repo?.default_branch
  ) {
    return { rung: 3, evidenceRef: `github:ci:${run.id ?? 'unknown'}` }
  }
  if (event === 'release' && p.action === 'published' && release?.tag_name) {
    return { rung: 4, evidenceRef: `github:release:${release.tag_name}` }
  }
  return null
}

export function registerGithubWebhook(app: FastifyInstance, deps: Deps): void {
  app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    )
    scoped.post('/webhooks/github', async (req, reply) => {
      const raw = req.body as string
      if (!verify(deps.secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'bad signature' })
      }
      const event = req.headers['x-github-event'] as string | undefined
      const delivery = req.headers['x-github-delivery'] as string | undefined
      if (!event || !delivery) return reply.code(400).send({ error: 'missing headers' })
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'bad json' })
      }
      const repoName = (payload.repository as { full_name?: string } | undefined)?.full_name
      if (!repoName) return reply.code(204).send()
      const { rows } = await deps.db.query<{ id: number }>(
        `SELECT id FROM projects WHERE repo_full_name = $1`, [repoName],
      )
      const detection = detectBuildMilestone(event, payload)
      if (!rows[0] || !detection) return reply.code(204).send()
      await emitMilestone(deps.db, deps.notifier, {
        projectId: Number(rows[0].id), vertical: 'build', rung: detection.rung,
        evidenceRef: detection.evidenceRef, dedupeKey: `gh-${delivery}`,
      })
      return reply.code(204).send()
    })
  })
}

export function makeWebhookCreate(webhookUrl: string, webhookSecret: string): WebhookCreate {
  return async (githubToken, repoFullName) => {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/hooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        config: { url: webhookUrl, content_type: 'json', secret: webhookSecret },
        events: ['push', 'pull_request', 'workflow_run', 'release'],
      }),
    })
    return res.ok || res.status === 422
  }
}
