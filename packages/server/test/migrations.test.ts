import { expect, it } from 'vitest'
import { makeTestDb } from './helpers.js'
import { migrate } from '../src/db/migrations.js'

it('migrate creates tables that accept inserts', async () => {
  const db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES ($1, $2)`, [123, 'tomr'])
  const { rows } = await db.query(`SELECT handle FROM users WHERE github_id = $1`, [123])
  expect(rows).toEqual([{ handle: 'tomr' }])
})

it('migrate is idempotent', async () => {
  const db = await makeTestDb()
  await migrate(db) // second run must not throw
})
