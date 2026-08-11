import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import type { Db } from '../db/client.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export type Fetcher = (url: string) => Promise<{ ok: boolean } | null>
export type TxtResolver = (domain: string) => Promise<string[] | null>

export function makeFetcher(): Fetcher {
  return async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
      return { ok: res.ok }
    } catch {
      return null
    }
  }
}

export function makeTxtResolver(): TxtResolver {
  return async (domain) => {
    try {
      const records = await dnsResolveTxt(domain)
      return records.map((chunks) => chunks.join(''))
    } catch {
      return null
    }
  }
}

export async function runProber(deps: {
  db: Db; notifier: Notifier; fetch: Fetcher; resolveTxt: TxtResolver
}): Promise<void> {
  const projects = await deps.db.query<{ id: number; deploy_url: string }>(
    `SELECT id, deploy_url FROM projects WHERE deploy_url IS NOT NULL`,
  )
  for (const p of projects.rows) {
    const projectId = Number(p.id)
    const result = await deps.fetch(p.deploy_url)
    if (result === null) continue
    await deps.db.query(`INSERT INTO probe_results (project_id, ok) VALUES ($1, $2)`, [
      projectId, result.ok,
    ])
    if (result.ok && p.deploy_url.startsWith('https://')) {
      await emitMilestone(deps.db, deps.notifier, {
        projectId, vertical: 'ship', rung: 1,
        evidenceRef: 'probe:200', dedupeKey: `deploy-live-${projectId}`,
      })
    }
  }

  const challenges = await deps.db.query<{ project_id: number; domain: string; token: string }>(
    `SELECT project_id, domain, token FROM domain_challenges`,
  )
  for (const c of challenges.rows) {
    const projectId = Number(c.project_id)
    const records = await deps.resolveTxt(`_forge.${c.domain}`)
    if (!records?.includes(c.token)) continue
    await emitMilestone(deps.db, deps.notifier, {
      projectId, vertical: 'ship', rung: 2,
      evidenceRef: `dns:${c.domain}`, dedupeKey: `dns-${projectId}`,
    })
    await deps.db.query(`DELETE FROM domain_challenges WHERE project_id = $1`, [projectId])
  }

  const uptime = await deps.db.query<{ id: number }>(
    `SELECT p.id FROM projects p
     WHERE p.deploy_url IS NOT NULL
       AND (SELECT min(probed_at) FROM probe_results r WHERE r.project_id = p.id AND r.ok)
             <= now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM probe_results r WHERE r.project_id = p.id AND NOT r.ok
           AND r.probed_at > now() - interval '30 days')`,
  )
  for (const row of uptime.rows) {
    await emitMilestone(deps.db, deps.notifier, {
      projectId: Number(row.id), vertical: 'ship', rung: 4,
      evidenceRef: 'probe:uptime30', dedupeKey: `uptime30-${Number(row.id)}`,
    })
  }
}
