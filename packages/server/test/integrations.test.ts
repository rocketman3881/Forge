import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { encryptSecret, decryptSecret } from '../src/lib/crypto.js'
import { listProjectEvents } from '../src/events/log.js'

const key = randomBytes(32)

async function setup(opts: { stripeOk?: boolean; webhookOk?: boolean } = {}) {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    secretKey: key,
    integrations: {
      stripeValidate: async () => opts.stripeOk ?? true,
      webhookCreate: async () => opts.webhookOk ?? true,
    },
  })
  const me = await createUserWithToken(db, 1, 'tomr')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${me.token}` }, payload: { name: 'launchpage' },
  })
  return { db, app, me, projectId: proj.json().id as number }
}

it('stripe connect stores encrypted key and emits revenue rung 1 once', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const res = await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`, headers: auth,
    payload: { apiKey: 'rk_live_secret123' },
  })
  expect(res.statusCode).toBe(200)
  expect(JSON.stringify(res.json())).not.toContain('rk_live')
  const { rows } = await db.query<{ secret_enc: string }>(
    `SELECT secret_enc FROM project_integrations WHERE project_id = $1 AND provider = 'stripe'`,
    [projectId],
  )
  expect(decryptSecret(rows[0]!.secret_enc, key)).toBe('rk_live_secret123')
  await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`, headers: auth,
    payload: { apiKey: 'rk_live_rotated' },
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.filter((e) => e.vertical === 'revenue' && e.rung === 1)).toHaveLength(1)
})

it('invalid stripe key is 400 and stores nothing', async () => {
  const { db, app, me, projectId } = await setup({ stripeOk: false })
  const res = await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`,
    headers: { authorization: `Bearer ${me.token}` }, payload: { apiKey: 'rk_bad' },
  })
  expect(res.statusCode).toBe(400)
  const { rows } = await db.query(`SELECT 1 FROM project_integrations WHERE project_id = $1`, [projectId])
  expect(rows).toHaveLength(0)
})

it('repo link requires github integration, then stores repo_full_name', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const before = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repo`, headers: auth,
    payload: { repoFullName: 'tomr/launchpage' },
  })
  expect(before.statusCode).toBe(409)
  await db.query(
    `INSERT INTO user_integrations (user_id, provider, secret_enc) VALUES ($1, 'github', $2)`,
    [me.userId, encryptSecret('gho_tok', key)],
  )
  const after = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repo`, headers: auth,
    payload: { repoFullName: 'tomr/launchpage' },
  })
  expect(after.statusCode).toBe(200)
  const { rows } = await db.query<{ repo_full_name: string }>(
    `SELECT repo_full_name FROM projects WHERE id = $1`, [projectId],
  )
  expect(rows[0]!.repo_full_name).toBe('tomr/launchpage')
})

it('deployUrl patch validates URL shape; non-owner is 403; bad body is 400', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const ok = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`, headers: auth,
    payload: { deployUrl: 'https://launchpage.app' },
  })
  expect(ok.statusCode).toBe(200)
  const bad = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`, headers: auth, payload: { deployUrl: 'not a url' },
  })
  expect(bad.statusCode).toBe(400)
  const missing = await app.inject({ method: 'PATCH', url: `/projects/${projectId}`, headers: auth, payload: {} })
  expect(missing.statusCode).toBe(400)
  const other = await createUserWithToken(db, 2, 'eve')
  const forbidden = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`,
    headers: { authorization: `Bearer ${other.token}` }, payload: { deployUrl: 'https://x.dev' },
  })
  expect(forbidden.statusCode).toBe(403)
})
