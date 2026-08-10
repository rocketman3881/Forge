import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { weekStartUtc } from '../src/checkins/routes.js'

it('weekStartUtc returns the Monday of the week', () => {
  expect(weekStartUtc(new Date('2026-08-10T09:00:00Z'))).toBe('2026-08-10') // a Monday
  expect(weekStartUtc(new Date('2026-08-16T23:00:00Z'))).toBe('2026-08-10') // Sunday same week
  expect(weekStartUtc(new Date('2026-08-17T00:00:00Z'))).toBe('2026-08-17') // next Monday
})

async function setup() {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')
  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  const clanId = created.json().id as number
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: created.json().inviteCode },
  })
  return { db, app, tom, sarah, clanId }
}

it('submit counts toward weekly status; resubmit overwrites, not duplicates', async () => {
  const { app, tom, clanId } = await setup()
  const auth = { authorization: `Bearer ${tom.token}` }
  const first = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth,
    payload: { shipped: 'deployed v1', blocked: 'stripe webhooks', next: 'first charge' },
  })
  expect(first.statusCode).toBe(201)
  const again = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth,
    payload: { shipped: 'deployed v1 + fix', blocked: 'none', next: 'first charge' },
  })
  expect(again.statusCode).toBe(200)

  const status = await app.inject({
    method: 'GET', url: `/clans/${clanId}/checkins/status`, headers: auth,
  })
  expect(status.json()).toMatchObject({ completed: 1, total: 2 })
})

it('non-members cannot check in', async () => {
  const { db, app, clanId } = await setup()
  const outsider = await createUserWithToken(db, 3, 'outsider')
  const res = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`,
    headers: { authorization: `Bearer ${outsider.token}` },
    payload: { shipped: 'x', blocked: 'y', next: 'z' },
  })
  expect(res.statusCode).toBe(403)
})

it('rejects missing fields with 400', async () => {
  const { app, tom, clanId } = await setup()
  const auth = { authorization: `Bearer ${tom.token}` }
  for (const payload of [
    { shipped: 'x', blocked: 'y' }, // missing next
    { shipped: 'x', next: 'z' }, // missing blocked
    { blocked: 'y', next: 'z' }, // missing shipped
  ]) {
    const res = await app.inject({
      method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth, payload,
    })
    expect(res.statusCode).toBe(400)
  }
})

it('rejects empty shipped and oversized fields with 400', async () => {
  const { app, tom, clanId } = await setup()
  const auth = { authorization: `Bearer ${tom.token}` }
  const oversized = 'x'.repeat(2001)
  for (const payload of [
    { shipped: '', blocked: 'y', next: 'z' }, // empty shipped
    { shipped: 'x', blocked: oversized, next: 'z' }, // oversized blocked
    { shipped: 'x', blocked: 'y', next: oversized }, // oversized next
  ]) {
    const res = await app.inject({
      method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth, payload,
    })
    expect(res.statusCode).toBe(400)
  }
})

