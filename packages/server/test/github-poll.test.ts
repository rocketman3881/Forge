import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from './helpers.js'
import { encryptSecret } from '../src/lib/crypto.js'
import { nullNotifier } from '../src/events/emit.js'
import { listProjectEvents } from '../src/events/log.js'
import { runGithubPoll, type GithubClient } from '../src/workers/github-poll.js'

const key = randomBytes(32)

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name, repo_full_name) VALUES (1, 'p', 'tomr/p') RETURNING id`,
  )
  await db.query(
    `INSERT INTO user_integrations (user_id, provider, secret_enc) VALUES (1, 'github', $1)`,
    [encryptSecret('gho_tok', key)],
  )
  return Number(rows[0]!.id)
}

it('emits rungs for verified state and is idempotent across runs', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  const client: GithubClient = {
    repoState: async (token, repo) => {
      expect(token).toBe('gho_tok')
      expect(repo).toBe('tomr/p')
      return { hasCommit: true, hasMergedPr: true, ciGreenOnDefault: false, hasRelease: false }
    },
  }
  const deps = { db, notifier: nullNotifier, secretKey: key, github: client }
  await runGithubPoll(deps)
  await runGithubPoll(deps)
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => e.rung).sort()).toEqual([1, 2])
})

it('a null repoState emits nothing (never guess)', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  await runGithubPoll({
    db, notifier: nullNotifier, secretKey: key,
    github: { repoState: async () => null },
  })
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})
