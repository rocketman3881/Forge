import { expect, it, beforeEach } from 'vitest'
import type { Db } from '../src/db/client.js'
import { makeTestDb } from './helpers.js'
import { emitMilestone, type Notifier } from '../src/events/emit.js'

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

function capture() {
  const seen: unknown[] = []
  const notifier: Notifier = { milestone: async (e) => void seen.push(e) }
  return { seen, notifier }
}

it('notifies with handle and project name on first emission only', async () => {
  const { seen, notifier } = capture()
  const input = {
    projectId, vertical: 'build' as const, rung: 1,
    evidenceRef: 'github:push:abc', dedupeKey: 'k1',
  }
  const first = await emitMilestone(db, notifier, input)
  expect(first.created).toBe(true)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ handle: 'tomr', projectName: 'launchpage', rung: 1 })
  const second = await emitMilestone(db, notifier, { ...input, dedupeKey: 'k2' })
  expect(second.created).toBe(false)
  expect(seen).toHaveLength(1)
})

it('a throwing notifier does not fail the emission', async () => {
  const notifier: Notifier = { milestone: async () => { throw new Error('socket gone') } }
  const res = await emitMilestone(db, notifier, {
    projectId, vertical: 'ship', rung: 1, evidenceRef: 'probe:200', dedupeKey: 'k3',
  })
  expect(res.created).toBe(true)
})
