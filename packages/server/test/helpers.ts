import { PGlite } from '@electric-sql/pglite'
import type { Db } from '../src/db/client.js'
import { migrate } from '../src/db/migrations.js'

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
