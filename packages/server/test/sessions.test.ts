import { expect, it } from 'vitest'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { createSession, userFromRequest } from '../src/auth/sessions.js'

it('a created session token authenticates its user', async () => {
  const db = await makeTestDb()
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const user = await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })
  expect(user).toEqual({ id: 1, handle: 'tomr' })
})

it('expired sessions do not authenticate', async () => {
  const db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const token = await createSession(db, 1, -1000)
  expect(await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })).toBeNull()
})

it('garbage and missing tokens do not authenticate', async () => {
  const db = await makeTestDb()
  expect(await userFromRequest(db, { headers: { authorization: 'Bearer nope' } })).toBeNull()
  expect(await userFromRequest(db, { headers: {} })).toBeNull()
})
