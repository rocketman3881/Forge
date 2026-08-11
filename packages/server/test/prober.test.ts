import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { nullNotifier } from '../src/events/emit.js'
import { listProjectEvents } from '../src/events/log.js'
import { runProber } from '../src/workers/prober.js'

const key = randomBytes(32)

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, deployUrl: string | null) {
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name, deploy_url) VALUES (1, 'p', $1) RETURNING id`,
    [deployUrl],
  )
  return Number(rows[0]!.id)
}

it('live https deploy emits ship 1 and records an ok probe', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await runProber({
    db, notifier: nullNotifier,
    fetch: async () => ({ ok: true }), resolveTxt: async () => null,
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => [e.vertical, e.rung])).toEqual([['ship', 1]])
  const { rows } = await db.query(`SELECT ok FROM probe_results WHERE project_id = $1`, [projectId])
  expect(rows).toEqual([{ ok: true }])
})

it('failed probe records ok=false but our own network error records nothing', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await runProber({ db, notifier: nullNotifier, fetch: async () => ({ ok: false }), resolveTxt: async () => null })
  await runProber({ db, notifier: nullNotifier, fetch: async () => null, resolveTxt: async () => null })
  const { rows } = await db.query(`SELECT ok FROM probe_results WHERE project_id = $1`, [projectId])
  expect(rows).toEqual([{ ok: false }])
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})

it('dns challenge verifies and emits ship 2, then clears', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, null)
  await db.query(
    `INSERT INTO domain_challenges (project_id, domain, token) VALUES ($1, 'p.app', 'forge-verify=abc')`,
    [projectId],
  )
  await runProber({
    db, notifier: nullNotifier, fetch: async () => null,
    resolveTxt: async (d) => (d === '_forge.p.app' ? ['forge-verify=abc'] : null),
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => [e.vertical, e.rung])).toEqual([['ship', 2]])
  const { rows } = await db.query(`SELECT 1 FROM domain_challenges WHERE project_id = $1`, [projectId])
  expect(rows).toHaveLength(0)
})

it('30 days of clean probes emits ship 4; a recent failure blocks it', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await db.query(
    `INSERT INTO probe_results (project_id, ok, probed_at) VALUES ($1, true, now() - interval '31 days')`,
    [projectId],
  )
  const deps = { db, notifier: nullNotifier, fetch: async () => ({ ok: true }), resolveTxt: async () => null }
  await runProber(deps)
  let rungs = (await listProjectEvents(db, projectId)).map((e) => e.rung)
  expect(rungs).toContain(4)

  const db2 = await makeTestDb()
  const p2 = await seed(db2, 'https://q.app')
  await db2.query(
    `INSERT INTO probe_results (project_id, ok, probed_at) VALUES ($1, true, now() - interval '31 days'), ($1, false, now() - interval '2 days')`,
    [p2],
  )
  await runProber({ ...deps, db: db2 })
  rungs = (await listProjectEvents(db2, p2)).map((e) => e.rung)
  expect(rungs).not.toContain(4)
})

it('domain route creates a challenge and returns the TXT record', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db, secretKey: key,
    integrations: { stripeValidate: async () => true, webhookCreate: async () => true },
  })
  const me = await createUserWithToken(db, 5, 'dom')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${me.token}` }, payload: { name: 'd' },
  })
  const res = await app.inject({
    method: 'POST', url: `/projects/${proj.json().id}/domain`,
    headers: { authorization: `Bearer ${me.token}` }, payload: { domain: 'd.app' },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().record).toBe('_forge.d.app')
  expect(res.json().value).toMatch(/^forge-verify=/)
})
