import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { appendMilestone } from '../src/events/log.js'

it('clan feed shows members events newest-first with handle and project name', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')

  const clan = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: clan.json().inviteCode },
  })
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { name: 'coldmail' },
  })
  await appendMilestone(db, {
    projectId: proj.json().id, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'stripe-ch_1',
  })

  const feed = await app.inject({
    method: 'GET', url: `/clans/${clan.json().id}/feed`,
    headers: { authorization: `Bearer ${tom.token}` },
  })
  expect(feed.statusCode).toBe(200)
  expect(feed.json().events[0]).toMatchObject({
    vertical: 'revenue', rung: 2, handle: 'sarah', projectName: 'coldmail',
  })
})

it('project events are owner-only; feed is member-only', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const outsider = await createUserWithToken(db, 3, 'outsider')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'launchpage' },
  })
  const clan = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })

  const forbiddenEvents = await app.inject({
    method: 'GET', url: `/projects/${proj.json().id}/events`,
    headers: { authorization: `Bearer ${outsider.token}` },
  })
  expect(forbiddenEvents.statusCode).toBe(403)

  const forbiddenFeed = await app.inject({
    method: 'GET', url: `/clans/${clan.json().id}/feed`,
    headers: { authorization: `Bearer ${outsider.token}` },
  })
  expect(forbiddenFeed.statusCode).toBe(403)
})
