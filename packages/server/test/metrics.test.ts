import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { runMetricsPoll } from '../src/workers/metrics-poll.js'
import { encryptSecret } from '../src/lib/crypto.js'

const key = randomBytes(32)

async function setup() {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    secretKey: key,
    integrations: { stripeValidate: async () => true, webhookCreate: async () => true },
  })
  const owner = await createUserWithToken(db, 1, 'tomr')
  const mate = await createUserWithToken(db, 2, 'sarah')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { name: 'shop' },
  })
  const projectId = proj.json().id as number
  const clanRes = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { name: 'crew' },
  })
  const invite = clanRes.json().inviteCode as string
  const clanId = clanRes.json().id as number
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${mate.token}` }, payload: { code: invite },
  })
  return { db, app, owner, mate, projectId, clanId }
}

it('metrics poll snapshots mrr and clan metrics expose only shared ones', async () => {
  const { db, app, owner, mate, projectId, clanId } = await setup()
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc) VALUES ($1, 'stripe', $2)`,
    [projectId, encryptSecret('rk_test_x', key)],
  )
  await runMetricsPoll({
    db, secretKey: key,
    stripe: {
      summary: async () => ({
        firstChargeId: null, paidCustomerCount: 0, grossRevenueCents: 0, activeMrrCents: 41200,
      }),
    },
    metrics: { plausibleVisitors: async () => null, youtubeViews: async () => null },
  })

  // not shared yet: clanmate sees nothing
  const before = await app.inject({
    method: 'GET', url: `/clans/${clanId}/metrics`,
    headers: { authorization: `Bearer ${mate.token}` },
  })
  expect(before.json().metrics).toEqual([])

  // owner opts in
  const share = await app.inject({
    method: 'POST', url: `/projects/${projectId}/share`,
    headers: { authorization: `Bearer ${owner.token}` }, payload: { metric: 'mrr', enabled: true },
  })
  expect(share.statusCode).toBe(200)

  const after = await app.inject({
    method: 'GET', url: `/clans/${clanId}/metrics`,
    headers: { authorization: `Bearer ${mate.token}` },
  })
  expect(after.json().metrics).toEqual([
    expect.objectContaining({ handle: 'tomr', projectName: 'shop', metric: 'mrr', value: 41200 }),
  ])

  // opting out removes it again
  await app.inject({
    method: 'POST', url: `/projects/${projectId}/share`,
    headers: { authorization: `Bearer ${owner.token}` }, payload: { metric: 'mrr', enabled: false },
  })
  const gone = await app.inject({
    method: 'GET', url: `/clans/${clanId}/metrics`,
    headers: { authorization: `Bearer ${mate.token}` },
  })
  expect(gone.json().metrics).toEqual([])
})

it('non-members cannot read clan metrics', async () => {
  const { db, app, clanId } = await setup()
  const outsider = await createUserWithToken(db, 3, 'rando')
  const res = await app.inject({
    method: 'GET', url: `/clans/${clanId}/metrics`,
    headers: { authorization: `Bearer ${outsider.token}` },
  })
  expect(res.statusCode).toBe(403)
})

it('ping requires clan membership, rejects strangers as targets, and rate-limits', async () => {
  const { db, app, owner, mate, clanId } = await setup()
  const outsider = await createUserWithToken(db, 3, 'rando')
  const auth = (t: string) => ({ authorization: `Bearer ${t}` })

  const notMember = await app.inject({
    method: 'POST', url: `/clans/${clanId}/ping`, headers: auth(outsider.token),
    payload: { to: 'tomr', message: 'hi' },
  })
  expect(notMember.statusCode).toBe(403)

  const badTarget = await app.inject({
    method: 'POST', url: `/clans/${clanId}/ping`, headers: auth(owner.token),
    payload: { to: 'rando', message: 'hi' },
  })
  expect(badTarget.statusCode).toBe(404)

  const ok = await app.inject({
    method: 'POST', url: `/clans/${clanId}/ping`, headers: auth(owner.token),
    payload: { to: 'sarah', message: 'get back to work' },
  })
  expect(ok.statusCode).toBe(200)

  const tooSoon = await app.inject({
    method: 'POST', url: `/clans/${clanId}/ping`, headers: auth(owner.token),
    payload: { to: 'sarah', message: 'again' },
  })
  expect(tooSoon.statusCode).toBe(429)

  const inbox = await app.inject({
    method: 'GET', url: `/clans/${clanId}/pings`, headers: auth(mate.token),
  })
  expect(inbox.json().pings).toEqual([
    expect.objectContaining({ from: 'tomr', message: 'get back to work' }),
  ])
})
