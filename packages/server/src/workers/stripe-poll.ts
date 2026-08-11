import type { Db } from '../db/client.js'
import { decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'
import type { StripeValidate } from '../integrations/routes.js'

export interface StripeClient {
  summary(apiKey: string): Promise<{
    firstChargeId: string | null
    paidCustomerCount: number
    grossRevenueCents: number
    activeMrrCents: number
  } | null>
}

interface StripeCharge {
  id: string
  status: string
  refunded: boolean
  amount: number
  created: number
  customer: string | null
}

export function makeStripeClient(): StripeClient {
  const api = async (key: string, path: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  }
  return {
    summary: async (apiKey) => {
      const charges: StripeCharge[] = []
      let starting: string | null = null
      for (let page = 0; page < 10; page++) {
        const qs = `limit=100${starting ? `&starting_after=${starting}` : ''}`
        const res = await api(apiKey, `/charges?${qs}`)
        if (!res) return null
        const data = res.data as StripeCharge[]
        charges.push(...data)
        if (!res.has_more || data.length === 0) break
        starting = data[data.length - 1]!.id
      }
      const good = charges
        .filter((c) => c.status === 'succeeded' && !c.refunded)
        .sort((a, b) => a.created - b.created)
      const subsRes = await api(apiKey, '/subscriptions?status=active&limit=100')
      if (!subsRes) return null
      const subs = subsRes.data as Array<{
        items: { data: Array<{ quantity: number; price: { unit_amount: number | null } }> }
      }>
      const mrr = subs.reduce(
        (sum, s) =>
          sum + s.items.data.reduce((x, i) => x + (i.price.unit_amount ?? 0) * i.quantity, 0),
        0,
      )
      return {
        firstChargeId: good[0]?.id ?? null,
        paidCustomerCount: new Set(good.map((c) => c.customer).filter(Boolean)).size,
        grossRevenueCents: good.reduce((sum, c) => sum + c.amount, 0),
        activeMrrCents: mrr,
      }
    },
  }
}

export function makeStripeValidate(client: StripeClient): StripeValidate {
  return async (apiKey) => (await client.summary(apiKey)) !== null
}

export async function runStripePoll(deps: {
  db: Db; notifier: Notifier; secretKey: Buffer; stripe: StripeClient
}): Promise<void> {
  const { rows } = await deps.db.query<{ project_id: number; secret_enc: string }>(
    `SELECT project_id, secret_enc FROM project_integrations WHERE provider = 'stripe'`,
  )
  for (const row of rows) {
    let s: Awaited<ReturnType<StripeClient['summary']>>
    try {
      s = await deps.stripe.summary(decryptSecret(row.secret_enc, deps.secretKey))
    } catch {
      continue
    }
    if (!s) continue
    const projectId = Number(row.project_id)
    const emit = (rung: number, evidenceRef: string, dedupeKey: string) =>
      emitMilestone(deps.db, deps.notifier, { projectId, vertical: 'revenue', rung, evidenceRef, dedupeKey })
    if (s.firstChargeId) await emit(2, `stripe:charge:${s.firstChargeId}`, `stripe-charge-${s.firstChargeId}`)
    if (s.paidCustomerCount >= 10) await emit(3, `stripe:customers:${s.paidCustomerCount}`, `stripe-cust10-${projectId}`)
    if (s.grossRevenueCents >= 10000) await emit(4, `stripe:gross:${s.grossRevenueCents}`, `stripe-100-${projectId}`)
    if (s.grossRevenueCents >= 100000 || s.activeMrrCents >= 10000) {
      await emit(5, `stripe:gross:${s.grossRevenueCents}:mrr:${s.activeMrrCents}`, `stripe-1k-${projectId}`)
    }
  }
}
