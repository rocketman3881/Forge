import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb } from './helpers.js'
import { userFromRequest } from '../src/auth/sessions.js'

async function loginFlow(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const app = buildApp({
    db,
    github: {
      clientId: 'test-client',
      exchange: async (code) => ({ githubId: 42, handle: `user-${code}` }),
    },
  })
  const start = await app.inject({
    method: 'GET',
    url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb',
  })
  expect(start.statusCode).toBe(302)
  const authorize = new URL(start.headers.location as string)
  expect(authorize.hostname).toBe('github.com')
  const state = authorize.searchParams.get('state')!

  const cb = await app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=abc&state=${state}`,
  })
  expect(cb.statusCode).toBe(302)
  const dest = cb.headers.location as string
  expect(dest.startsWith('http://127.0.0.1:9999/cb#token=')).toBe(true)
  return { app, token: dest.split('#token=')[1]! }
}

it('full login flow creates a user and a working session', async () => {
  const db = await makeTestDb()
  const { token } = await loginFlow(db)
  const user = await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })
  expect(user?.handle).toBe('user-abc')
})

it('logging in twice with the same github_id reuses the user', async () => {
  const db = await makeTestDb()
  await loginFlow(db)
  await loginFlow(db)
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users`)
  expect(rows[0]).toEqual({ n: 1 })
})

it('unknown state is rejected', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: { clientId: 'x', exchange: async () => ({ githubId: 1, handle: 'h' }) },
  })
  const res = await app.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=bogus' })
  expect(res.statusCode).toBe(400)
})
