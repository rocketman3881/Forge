import { expect, it, beforeEach } from 'vitest'
import type { Db } from '../src/db/client.js'
import { makeTestDb } from './helpers.js'
import { appendMilestone, listProjectEvents } from '../src/events/log.js'

let db: Db
let projectId: number

beforeEach(async () => {
  db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name) VALUES (1, 'launchpage') RETURNING id`,
  )
  projectId = Number(rows[0]!.id)
})

it('appends a new milestone', async () => {
  const r = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  expect(r.created).toBe(true)
  expect(r.event.vertical).toBe('build')
  expect(r.event.rung).toBe(1)
})

it('same dedupeKey twice is a no-op returning the existing event', async () => {
  const first = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  const second = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  expect(second.created).toBe(false)
  expect(second.event.id).toBe(first.event.id)
  expect(await listProjectEvents(db, projectId)).toHaveLength(1)
})

it('an already-earned rung is a no-op even with a new dedupeKey', async () => {
  await appendMilestone(db, {
    projectId, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'stripe-ch_1',
  })
  const dup = await appendMilestone(db, {
    projectId, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_2', dedupeKey: 'stripe-ch_2',
  })
  expect(dup.created).toBe(false)
  expect(await listProjectEvents(db, projectId)).toHaveLength(1)
})

it('a dedupe key reused across projects resolves to the original event, never a wrong-project duplicate', async () => {
  const a = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc', dedupeKey: 'shared-key',
  })
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name) VALUES (1, 'second') RETURNING id`,
  )
  const projectB = Number(rows[0]!.id)
  const b = await appendMilestone(db, {
    projectId: projectB, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:def', dedupeKey: 'shared-key',
  })
  expect(b.created).toBe(false)
  expect(b.event.id).toBe(a.event.id)
  expect(await listProjectEvents(db, projectB)).toHaveLength(0)
})
