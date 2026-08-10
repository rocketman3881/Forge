import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'

it('creates and lists own projects only, alphabetically', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const me = await createUserWithToken(db, 1, 'tomr')
  const other = await createUserWithToken(db, 2, 'sarah')
  const auth = { authorization: `Bearer ${me.token}` }

  const created = await app.inject({
    method: 'POST', url: '/projects', headers: auth, payload: { name: 'launchpage' },
  })
  expect(created.statusCode).toBe(201)
  await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'apitool' } })
  await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${other.token}` }, payload: { name: 'coldmail' },
  })

  const list = await app.inject({ method: 'GET', url: '/projects', headers: auth })
  expect(list.statusCode).toBe(200)
  expect(list.json().projects.map((p: { name: string }) => p.name)).toEqual(['apitool', 'launchpage'])
})

it('duplicate name for the same owner is 409; no auth is 401', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const auth = { authorization: `Bearer ${token}` }
  await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'x' } })
  const dup = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'x' } })
  expect(dup.statusCode).toBe(409)
  const anon = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'y' } })
  expect(anon.statusCode).toBe(401)
})
