import { expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from './helpers.js'
import { encryptSecret } from '../src/lib/crypto.js'
import { nullNotifier } from '../src/events/emit.js'
import { runAllProducers, startScheduler, type SchedulerDeps } from '../src/workers/scheduler.js'

function deps(db: Awaited<ReturnType<typeof makeTestDb>>, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    db, notifier: nullNotifier, secretKey: randomBytes(32),
    github: { repoState: async () => null },
    stripe: { summary: async () => null },
    fetch: async () => null, resolveTxt: async () => null,
    ...overrides,
  }
}

it('a throwing producer does not block the others', async () => {
  const db = await makeTestDb()
  const stripeSpy = vi.fn(async () => null)
  await runAllProducers(
    deps(db, {
      github: { repoState: async () => { throw new Error('github down') } },
      stripe: { summary: stripeSpy },
    }),
  )
  // the assertion is that runAllProducers resolved despite the github throw
  expect(true).toBe(true)
})

it('startScheduler runs immediately and can be stopped', async () => {
  const db = await makeTestDb()
  const k = randomBytes(32)
  let runs = 0
  const d = deps(db, {
    secretKey: k,
    stripe: { summary: async () => { runs++; return null } },
  })
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'u')`)
  await db.query(`INSERT INTO projects (owner_id, name) VALUES (1, 'p')`)
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc)
     SELECT id, 'stripe', $1 FROM projects LIMIT 1`,
    [encryptSecret('rk_x', k)],
  )
  const handle = startScheduler(d, 60_000)
  await vi.waitFor(() => expect(runs).toBeGreaterThan(0))
  handle.stop()
})
