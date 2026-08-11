import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { emitMilestone } from '../src/events/emit.js'
import { ClanBroadcaster } from '../src/realtime/broadcaster.js'

it('clanmates receive a milestone push; outsiders are rejected', async () => {
  const db = await makeTestDb()
  const broadcaster = new ClanBroadcaster(db)
  const app = buildApp({ db, broadcaster })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')
  const outsider = await createUserWithToken(db, 3, 'eve')

  const clanRes = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'crew' },
  })
  const clanId = clanRes.json().id as number
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: clanRes.json().inviteCode },
  })
  const projRes = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'launchpage' },
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `ws://127.0.0.1:${port}`

  const received: unknown[] = []
  const sock = new WebSocket(`${base}/clans/${clanId}/ws?token=${sarah.token}`)
  await new Promise<void>((resolve, reject) => {
    sock.on('open', () => resolve())
    sock.on('error', reject)
  })
  sock.on('message', (data) => received.push(JSON.parse(String(data))))

  const rejected = new WebSocket(`${base}/clans/${clanId}/ws?token=${outsider.token}`)
  const closeCode = await new Promise<number>((resolve) => {
    rejected.on('close', (code) => resolve(code))
    rejected.on('error', () => {})
  })
  expect(closeCode).toBe(4003)

  await emitMilestone(db, broadcaster, {
    projectId: projRes.json().id, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'k-ws',
  })

  await new Promise((r) => setTimeout(r, 200))
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({
    type: 'milestone',
    event: { vertical: 'revenue', rung: 2, handle: 'tomr', projectName: 'launchpage' },
  })

  sock.close()
  await app.close()
})
