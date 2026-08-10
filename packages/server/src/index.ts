import { buildApp } from './app.js'
import { makePgDb } from './db/client.js'
import { migrate } from './db/migrations.js'
import { makeGithubExchange } from './auth/github.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const db = makePgDb(databaseUrl)
await migrate(db)

const clientId = process.env.GITHUB_CLIENT_ID
const clientSecret = process.env.GITHUB_CLIENT_SECRET
const app = buildApp({
  db,
  github:
    clientId && clientSecret
      ? { clientId, exchange: makeGithubExchange(clientId, clientSecret) }
      : undefined,
})

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`forge server listening on :${port}`)
