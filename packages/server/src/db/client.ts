import pg from 'pg'

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export function makePgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })
  return {
    query: async (sql, params) => {
      const res = await pool.query(sql, params as unknown[] | undefined)
      return { rows: res.rows }
    },
  }
}
