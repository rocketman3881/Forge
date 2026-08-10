import { PGlite } from '@electric-sql/pglite'
import type { Db } from '../src/db/client.js'
import { migrate } from '../src/db/migrations.js'
import { createSession } from '../src/auth/sessions.js'

export async function makeTestDb(): Promise<Db> {
  const lite = new PGlite()
  const db: Db = {
    query: async (sql, params) => {
      const res = await lite.query(sql, params as unknown[] | undefined)
      return { rows: res.rows as Record<string, unknown>[] }
    },
  }
  await migrate(db)
  return db
}

export async function createUserWithToken(
  db: Db,
  githubId: number,
  handle: string,
): Promise<{ userId: number; token: string }> {
  const { rows } = await db.query<{ id: string | number }>(
    `INSERT INTO users (github_id, handle) VALUES ($1, $2) RETURNING id`,
    [githubId, handle],
  )
  const userId = Number(rows[0]!.id)
  return { userId, token: await createSession(db, userId) }
}
