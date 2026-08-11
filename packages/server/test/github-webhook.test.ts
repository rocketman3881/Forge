import { expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { listProjectEvents } from '../src/events/log.js'

const SECRET = 'whsec_test'

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
}

async function setup() {
  const db = await makeTestDb()
  const app = buildApp({ db, githubWebhookSecret: SECRET })
  const me = await createUserWithToken(db, 1, 'tomr')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${me.token}` }, payload: { name: 'launchpage' },
  })
  const projectId = proj.json().id as number
  await db.query(`UPDATE projects SET repo_full_name = 'tomr/launchpage' WHERE id = $1`, [projectId])
  return { db, app, projectId }
}

function deliver(app: Awaited<ReturnType<typeof setup>>['app'], event: string, delivery: string, payload: unknown, sig?: string) {
  const body = JSON.stringify(payload)
  return app.inject({
    method: 'POST', url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': sig ?? sign(body),
    },
    payload: body,
  })
}

it('rejects bad signatures with 401 and no side effects', async () => {
  const { db, app, projectId } = await setup()
  const res = await deliver(app, 'push', 'd1', {
    repository: { full_name: 'tomr/launchpage' }, after: 'abc',
  }, 'sha256=' + '0'.repeat(64))
  expect(res.statusCode).toBe(401)
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})

it('maps push, merged PR, green CI, and release to build rungs 1-4', async () => {
  const { db, app, projectId } = await setup()
  const repo = { full_name: 'tomr/launchpage', default_branch: 'main' }
  await deliver(app, 'push', 'd1', { repository: repo, after: 'abc123' })
  await deliver(app, 'pull_request', 'd2', {
    repository: repo, action: 'closed', pull_request: { merged: true, number: 5 },
  })
  await deliver(app, 'workflow_run', 'd3', {
    repository: repo, action: 'completed',
    workflow_run: { id: 9, conclusion: 'success', head_branch: 'main' },
  })
  await deliver(app, 'release', 'd4', { repository: repo, action: 'published', release: { tag_name: 'v0.1' } })
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => [e.vertical, e.rung])).toEqual([
    ['build', 1], ['build', 2], ['build', 3], ['build', 4],
  ])
})

it('ignores unknown repos, unmerged PRs, failed CI, and duplicate deliveries', async () => {
  const { db, app, projectId } = await setup()
  const repo = { full_name: 'tomr/launchpage', default_branch: 'main' }
  await deliver(app, 'push', 'dup', { repository: repo, after: 'a1' })
  await deliver(app, 'push', 'dup', { repository: repo, after: 'a1' })
  await deliver(app, 'push', 'other', { repository: { full_name: 'someone/else' }, after: 'b2' })
  await deliver(app, 'pull_request', 'p1', {
    repository: repo, action: 'closed', pull_request: { merged: false, number: 6 },
  })
  await deliver(app, 'workflow_run', 'w1', {
    repository: repo, action: 'completed',
    workflow_run: { id: 10, conclusion: 'failure', head_branch: 'main' },
  })
  const events = await listProjectEvents(db, projectId)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ vertical: 'build', rung: 1 })
})
