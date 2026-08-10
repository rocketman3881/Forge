import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'

it('create, join via code, and list members alphabetically', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')

  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  expect(created.statusCode).toBe(201)
  const { inviteCode } = created.json()

  const joined = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: inviteCode },
  })
  expect(joined.statusCode).toBe(200)

  const mine = await app.inject({
    method: 'GET', url: '/clans/mine', headers: { authorization: `Bearer ${tom.token}` },
  })
  expect(mine.json().clans[0].members.map((m: { handle: string }) => m.handle)).toEqual([
    'sarah', 'tomr',
  ])
})

it('unknown code is 404; the 7th member is rejected with 409; rejoin is a no-op', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const owner = await createUserWithToken(db, 1, 'owner')
  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { name: 'full' },
  })
  const { inviteCode } = created.json()

  const bad = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { code: 'nope' },
  })
  expect(bad.statusCode).toBe(404)

  for (let i = 2; i <= 6; i++) {
    const u = await createUserWithToken(db, i, `user${i}`)
    const res = await app.inject({
      method: 'POST', url: '/clans/join',
      headers: { authorization: `Bearer ${u.token}` }, payload: { code: inviteCode },
    })
    expect(res.statusCode).toBe(200)
  }
  const seventh = await createUserWithToken(db, 7, 'user7')
  const rejected = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${seventh.token}` }, payload: { code: inviteCode },
  })
  expect(rejected.statusCode).toBe(409)

  const rejoin = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { code: inviteCode },
  })
  expect(rejoin.statusCode).toBe(200)
})

it('rejects missing, empty, and oversized clan names with 400', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const auth = { authorization: `Bearer ${token}` }
  for (const payload of [undefined, {}, { name: '' }, { name: 'x'.repeat(101) }]) {
    const res = await app.inject({ method: 'POST', url: '/clans', headers: auth, payload })
    expect(res.statusCode >= 400 && res.statusCode < 500).toBe(true)
  }
})

it('rejects missing and empty clan join codes with 400', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const auth = { authorization: `Bearer ${token}` }
  for (const payload of [undefined, {}, { code: '' }, { code: 'x'.repeat(51) }]) {
    const res = await app.inject({ method: 'POST', url: '/clans/join', headers: auth, payload })
    expect(res.statusCode >= 400 && res.statusCode < 500).toBe(true)
  }
})
