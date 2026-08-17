// Dev-only entrypoint: runs the server on in-memory PGlite (no Postgres needed).
import { PGlite } from '@electric-sql/pglite'
import { buildApp } from './src/app.js'
import type { Db } from './src/db/client.js'
import { migrate } from './src/db/migrations.js'
import { loadSecretKey } from './src/lib/crypto.js'
import { ClanBroadcaster } from './src/realtime/broadcaster.js'

const lite = new PGlite()
const db: Db = {
  query: async <T,>(sql: string, params?: unknown[]) => {
    const res = await lite.query(sql, params as unknown[] | undefined)
    return { rows: res.rows as T[] }
  },
}
await migrate(db)

const secretKey = loadSecretKey()
const notifier = new ClanBroadcaster(db)

const app = buildApp({ db, secretKey, notifier, broadcaster: notifier })

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`forge server (pglite) listening on :${port}`)
