import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from './helpers.js'
import { encryptSecret } from '../src/lib/crypto.js'
import { nullNotifier } from '../src/events/emit.js'
import { listProjectEvents } from '../src/events/log.js'
import { runStripePoll, type StripeClient } from '../src/workers/stripe-poll.js'

const key = randomBytes(32)

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name) VALUES (1, 'p') RETURNING id`,
  )
  const projectId = Number(rows[0]!.id)
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc) VALUES ($1, 'stripe', $2)`,
    [projectId, encryptSecret('rk_test', key)],
  )
  return projectId
}

function client(s: Partial<Awaited<ReturnType<StripeClient['summary']>> & object>): StripeClient {
  return {
    summary: async () => ({
      firstChargeId: null, paidCustomerCount: 0, grossRevenueCents: 0, activeMrrCents: 0,
      ...(s as object),
    }),
  }
}

it('first dollar emits rung 2; thresholds emit 3-5; idempotent', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  const deps = {
    db, notifier: nullNotifier, secretKey: key,
    stripe: client({ firstChargeId: 'ch_1', paidCustomerCount: 12, grossRevenueCents: 150000, activeMrrCents: 0 }),
  }
  await runStripePoll(deps)
  await runStripePoll(deps)
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => e.rung).sort()).toEqual([2, 3, 4, 5])
  expect(events.find((e) => e.rung === 2)!.evidenceRef).toBe('stripe:charge:ch_1')
})

it('no qualifying charge emits nothing; null summary emits nothing', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  await runStripePoll({ db, notifier: nullNotifier, secretKey: key, stripe: client({}) })
  await runStripePoll({
    db, notifier: nullNotifier, secretKey: key,
    stripe: { summary: async () => null },
  })
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})

it('$100 MRR alone satisfies rung 5', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  await runStripePoll({
    db, notifier: nullNotifier, secretKey: key,
    stripe: client({ firstChargeId: 'ch_9', grossRevenueCents: 5000, activeMrrCents: 10000 }),
  })
  const rungs = (await listProjectEvents(db, projectId)).map((e) => e.rung)
  expect(rungs).toContain(5)
  expect(rungs).not.toContain(4)
})
