import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb } from './helpers.js'
import { userFromRequest } from '../src/auth/sessions.js'
import { GithubExchangeError } from '../src/auth/github.js'
import { decryptSecret } from '../src/lib/crypto.js'

async function loginFlow(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const app = buildApp({
    db,
    github: {
      clientId: 'test-client',
      exchange: async (code) => ({ githubId: 42, handle: `user-${code}`, accessToken: 'gho_test' }),
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
    github: { clientId: 'x', exchange: async () => ({ githubId: 1, handle: 'h', accessToken: 'gho_test' }) },
  })
  const res = await app.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=bogus' })
  expect(res.statusCode).toBe(400)
})

it('rejects non-loopback redirect_uri', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: { clientId: 'x', exchange: async () => ({ githubId: 1, handle: 'h', accessToken: 'gho_test' }) },
  })
  const res = await app.inject({
    method: 'GET',
    url: '/auth/github/start?redirect_uri=' + encodeURIComponent('https://evil.example/cb'),
  })
  expect(res.statusCode).toBe(400)
  const missing = await app.inject({ method: 'GET', url: '/auth/github/start' })
  expect(missing.statusCode).toBe(400)
})

it('a consumed state cannot be replayed', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: { clientId: 'x', exchange: async (code) => ({ githubId: 9, handle: `u${code}`, accessToken: 'gho_test' }) },
  })
  const start = await app.inject({
    method: 'GET',
    url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb',
  })
  const state = new URL(start.headers.location as string).searchParams.get('state')!
  const first = await app.inject({ method: 'GET', url: `/auth/github/callback?code=a&state=${state}` })
  expect(first.statusCode).toBe(302)
  const replay = await app.inject({ method: 'GET', url: `/auth/github/callback?code=a&state=${state}` })
  expect(replay.statusCode).toBe(400)
})

it('a failing exchange returns 502, not a crash', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: {
      clientId: 'x',
      exchange: async () => {
        throw new GithubExchangeError('token exchange failed: 401')
      },
    },
  })
  const start = await app.inject({
    method: 'GET', url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb',
  })
  const state = new URL(start.headers.location as string).searchParams.get('state')!
  const cb = await app.inject({ method: 'GET', url: `/auth/github/callback?code=bad&state=${state}` })
  expect(cb.statusCode).toBe(502)
  expect(cb.json()).toEqual({ error: 'github exchange failed' })
})

it('callback stores the encrypted github token when secretKey is set', async () => {
  const db = await makeTestDb()
  const key = randomBytes(32)
  const app = buildApp({
    db,
    secretKey: key,
    github: {
      clientId: 'x',
      exchange: async () => ({ githubId: 7, handle: 'tok', accessToken: 'gho_secret' }),
    },
  })
  const start = await app.inject({
    method: 'GET', url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb&scope=repo',
  })
  expect(start.headers.location).toContain('scope=repo')
  const state = new URL(start.headers.location as string).searchParams.get('state')!
  await app.inject({ method: 'GET', url: `/auth/github/callback?code=c&state=${state}` })
  const { rows } = await db.query<{ secret_enc: string }>(
    `SELECT secret_enc FROM user_integrations ui JOIN users u ON u.id = ui.user_id
     WHERE u.github_id = 7 AND ui.provider = 'github'`,
  )
  expect(rows).toHaveLength(1)
  expect(decryptSecret(rows[0]!.secret_enc, key)).toBe('gho_secret')
})

it('rejects invalid scope parameter', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: { clientId: 'x', exchange: async () => ({ githubId: 1, handle: 'h', accessToken: 'gho_test' }) },
  })
  const res = await app.inject({
    method: 'GET',
    url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb&scope=foo',
  })
  expect(res.statusCode).toBe(400)
})
