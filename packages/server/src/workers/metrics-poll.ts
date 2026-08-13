import type { Db } from '../db/client.js'
import { decryptSecret } from '../lib/crypto.js'
import type { StripeClient } from './stripe-poll.js'

/** Live metric sources. Social is a public lookup of a declared handle. */
export interface MetricsClients {
  /** 30-day unique visitors for a Plausible site. */
  plausibleVisitors(siteId: string, apiKey: string): Promise<number | null>
  /** Lifetime public view count for a YouTube channel handle. */
  youtubeViews(handle: string): Promise<number | null>
}

export function makeMetricsClients(youtubeApiKey?: string): MetricsClients {
  return {
    plausibleVisitors: async (siteId, apiKey) => {
      const url = `https://plausible.io/api/v1/stats/aggregate?site_id=${encodeURIComponent(siteId)}&period=30d&metrics=visitors`
      const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } })
      if (!res.ok) return null
      const body = (await res.json()) as { results?: { visitors?: { value?: number } } }
      const v = body.results?.visitors?.value
      return typeof v === 'number' ? v : null
    },
    youtubeViews: async (handle) => {
      if (!youtubeApiKey) return null
      const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=${encodeURIComponent(handle)}&key=${youtubeApiKey}`
      const res = await fetch(url)
      if (!res.ok) return null
      const body = (await res.json()) as { items?: Array<{ statistics?: { viewCount?: string } }> }
      const raw = body.items?.[0]?.statistics?.viewCount
      const v = raw === undefined ? NaN : Number(raw)
      return Number.isFinite(v) ? v : null
    },
  }
}

async function snapshot(db: Db, projectId: number, metric: string, value: number): Promise<void> {
  await db.query(
    `INSERT INTO metric_snapshots (project_id, metric, value, captured_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (project_id, metric) DO UPDATE SET value = EXCLUDED.value, captured_at = now()`,
    [projectId, metric, Math.round(value)],
  )
}

/** Refresh metric snapshots for every connected source. Sharing is gated at read time. */
export async function runMetricsPoll(deps: {
  db: Db
  secretKey: Buffer
  stripe: StripeClient
  metrics: MetricsClients
}): Promise<void> {
  const { rows } = await deps.db.query<{ project_id: number; provider: string; secret_enc: string }>(
    `SELECT project_id, provider, secret_enc FROM project_integrations
     WHERE provider IN ('stripe','plausible','youtube')`,
  )
  for (const row of rows) {
    const projectId = Number(row.project_id)
    let secret: string
    try {
      secret = decryptSecret(row.secret_enc, deps.secretKey)
    } catch {
      continue
    }
    try {
      if (row.provider === 'stripe') {
        const s = await deps.stripe.summary(secret)
        if (s) await snapshot(deps.db, projectId, 'mrr', s.activeMrrCents)
      } else if (row.provider === 'plausible') {
        const { siteId, apiKey } = JSON.parse(secret) as { siteId: string; apiKey: string }
        const v = await deps.metrics.plausibleVisitors(siteId, apiKey)
        if (v !== null) await snapshot(deps.db, projectId, 'views', v)
      } else {
        const v = await deps.metrics.youtubeViews(secret)
        if (v !== null) await snapshot(deps.db, projectId, 'social', v)
      }
    } catch {
      // one bad source never blocks the rest; next interval retries
    }
  }
}
