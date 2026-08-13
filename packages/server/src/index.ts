import { buildApp } from './app.js'
import { makePgDb } from './db/client.js'
import { migrate } from './db/migrations.js'
import { makeGithubExchange } from './auth/github.js'
import { loadSecretKey } from './lib/crypto.js'
import { ClanBroadcaster } from './realtime/broadcaster.js'
import { makeGithubClient } from './workers/github-poll.js'
import { makeStripeClient, makeStripeValidate } from './workers/stripe-poll.js'
import { makeWebhookCreate } from './workers/github-webhook.js'
import { makeFetcher, makeTxtResolver } from './workers/prober.js'
import { startScheduler } from './workers/scheduler.js'
import { makeMetricsClients } from './workers/metrics-poll.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const db = makePgDb(databaseUrl)
await migrate(db)

const secretKey = loadSecretKey()
const clientId = process.env.GITHUB_CLIENT_ID
const clientSecret = process.env.GITHUB_CLIENT_SECRET
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET
const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000'
const stripeClient = makeStripeClient()
const metricsClients = makeMetricsClients(process.env.YOUTUBE_API_KEY)
const notifier = new ClanBroadcaster(db)

const app = buildApp({
  db,
  publicUrl,
  secretKey,
  notifier,
  broadcaster: notifier,
  githubWebhookSecret: webhookSecret,
  github:
    clientId && clientSecret
      ? { clientId, exchange: makeGithubExchange(clientId, clientSecret) }
      : undefined,
  integrations: webhookSecret
    ? {
        stripeValidate: makeStripeValidate(stripeClient),
        webhookCreate: makeWebhookCreate(`${publicUrl}/webhooks/github`, webhookSecret),
        plausibleValidate: async (siteId, apiKey) =>
          (await metricsClients.plausibleVisitors(siteId, apiKey)) !== null,
      }
    : undefined,
})

if (process.env.FORGE_WORKERS !== 'off') {
  startScheduler({
    db, notifier, secretKey,
    github: makeGithubClient(), stripe: stripeClient,
    fetch: makeFetcher(), resolveTxt: makeTxtResolver(),
    metrics: metricsClients,
  })
}

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`forge server listening on :${port}`)
