// Demo server: in-memory PGlite + seeded data, for trying the CLI locally.
// Run: pnpm --filter @forge/server exec tsx scripts/demo.ts
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from '../test/helpers.js'
import { ClanBroadcaster } from '../src/realtime/broadcaster.js'
import { emitMilestone } from '../src/events/emit.js'

const db = await makeTestDb()
const broadcaster = new ClanBroadcaster(db)
const app = buildApp({ db, broadcaster })

const tom = await createUserWithToken(db, 1, 'tomr')
const sarah = await createUserWithToken(db, 2, 'sarah')
const dev = await createUserWithToken(db, 3, 'devon')

async function insert(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ id: string | number }>(`${sql} RETURNING id`, params)
  return Number(rows[0]!.id)
}

const launchpage = await insert(
  `INSERT INTO projects (owner_id, name, repo_full_name, deploy_url) VALUES ($1, 'launchpage', 'tomr/launchpage', 'https://launchpage.app')`,
  [tom.userId],
)
const shop = await insert(
  `INSERT INTO projects (owner_id, name, repo_full_name) VALUES ($1, 'shop', 'sarah/shop')`,
  [sarah.userId],
)

const clanId = await insert(`INSERT INTO clans (name, invite_code) VALUES ('indie-crew', 'DEMO42')`, [])
for (const u of [tom, sarah, dev]) {
  await db.query(`INSERT INTO clan_members (clan_id, user_id, status) VALUES ($1, $2, 'active')`, [
    clanId, u.userId,
  ])
}

const seedEvents: Array<[number, 'build' | 'ship' | 'revenue', number, string]> = [
  [launchpage, 'build', 1, 'github:repo:tomr/launchpage'],
  [launchpage, 'build', 2, 'github:commits:14d'],
  [launchpage, 'build', 3, 'github:tag:v0.1.0'],
  [launchpage, 'ship', 1, 'probe:200'],
  [launchpage, 'revenue', 1, 'stripe:connected'],
  [launchpage, 'revenue', 2, 'stripe:charge:ch_3OaDemo'],
  [shop, 'build', 1, 'github:repo:sarah/shop'],
  [shop, 'build', 2, 'github:commits:14d'],
]
for (const [projectId, vertical, rung, evidenceRef] of seedEvents) {
  await emitMilestone(db, broadcaster, {
    projectId, vertical, rung, evidenceRef, dedupeKey: `seed-${projectId}-${vertical}-${rung}`,
  })
}

await db.query(
  `INSERT INTO checkins (clan_id, user_id, week_start, shipped, blocked, next_target)
   VALUES ($1, $2, date_trunc('week', now())::date, 'landing page + stripe', 'nothing', 'first 10 customers')`,
  [clanId, sarah.userId],
)

// A late-breaking milestone so the live celebration shows up in the sidebar.
setTimeout(() => {
  void emitMilestone(db, broadcaster, {
    projectId: shop, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_3ObLive', dedupeKey: 'demo-live-celebration',
  })
}, 12_000)

await app.listen({ port: 3000, host: '127.0.0.1' })
console.log('demo server on http://127.0.0.1:3000')
console.log(`TOKEN_TOM=${tom.token}`)
