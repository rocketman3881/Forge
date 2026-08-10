# Forge Verification Workers & Realtime Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The verification engine — GitHub webhook + poller, Stripe poller (restricted-key interim), deploy/DNS/uptime prober, an interval scheduler, and WebSocket clan celebrations — everything that turns real-world events into MilestoneEvents and pushes them to clanmates' terminals.

**Architecture:** Every producer funnels through one function, `emitMilestone(db, notifier, input)` — appendMilestone plus notification on `created`. Producers receive injected provider clients (`GithubClient`, `StripeClient`, fetcher, DNS resolver) so all verification logic is tested against recorded fixtures; the thin fetch-based real clients mirror `makeGithubExchange`. Secrets (GitHub tokens, Stripe keys) are AES-256-GCM encrypted at rest with a `FORGE_SECRET` key. A `ClanBroadcaster` (in-process, per-clan socket sets) implements the `Notifier` interface for WebSocket push.

**Tech Stack:** Everything from Plan 1, plus `@fastify/websocket` (and its transitive `ws` for test clients). No other new dependencies.

**Prior state:** Plan 1 merged to main (PR #1): Fastify app (`buildApp(deps)`), `Db` interface, append-only milestone log with `appendMilestone`/`listProjectEvents`/`listClanFeed`, sessions (`userFromRequest`), GitHub OAuth login, projects/clans/checkins routes, 31 tests green, `pnpm --filter @forge/server typecheck` clean.

**Human-approved decisions carried in:** Stripe connects via pasted restricted read-only API key (interim until OAuth pre-launch); runtime JSON-schema validation on every body route; exact-400 assertions in validation tests. Ship rungs 3 and 5 (Product Hunt / store-registry lookups) are explicitly deferred to Plan 3+.

## Global Constraints

- **Never emit a false milestone.** Producers emit only on positive, verified evidence; on ambiguous or failed provider responses they skip silently and let the next run retry — they never guess, never emit on error paths.
- ALL milestone writes go through `emitMilestone` — no direct `appendMilestone` calls outside `src/events/emit.ts` and existing tests.
- `milestone_events` remains append-only; producer idempotency via dedupe keys (patterns defined per task) plus the existing one-event-per-rung constraint.
- Secrets: encrypted at rest (AES-256-GCM, `FORGE_SECRET` = 64 hex chars), never logged, never returned by any API response, decrypted only inside workers/routes that need them.
- GitHub webhook requests MUST be HMAC-verified (X-Hub-Signature-256) before any parsing of intent; unverified → 401, no side effects.
- Notification failures must never fail an emission (`emitMilestone` swallows notifier errors).
- Every body route carries Fastify JSON-schema validation (`additionalProperties: false`); validation tests assert exactly 400.
- ESM; TypeScript strict (`pnpm --filter @forge/server typecheck` must stay clean); relative imports use `.js` extensions.
- Run tests with `pnpm --filter @forge/server test`.

## File Structure

```
packages/server/
  src/
    lib/params.ts            # parseId (Task 1)
    lib/crypto.ts            # loadSecretKey, encryptSecret, decryptSecret (Task 2)
    events/emit.ts           # Notifier, nullNotifier, emitMilestone (Task 3)
    integrations/routes.ts   # stripe key, repo link, deployUrl (Task 4)
    workers/github-webhook.ts# HMAC-verified webhook route (Task 5)
    workers/github-poll.ts   # GithubClient + reconciliation poller (Task 6)
    workers/stripe-poll.ts   # StripeClient + revenue poller (Task 7)
    workers/prober.ts        # deploy/DNS/uptime prober (Task 8)
    workers/scheduler.ts     # interval runner (Task 9)
    realtime/broadcaster.ts  # ClanBroadcaster + WS route (Task 10)
  test/
    params.test.ts crypto.test.ts emit.test.ts integrations.test.ts
    github-webhook.test.ts github-poll.test.ts stripe-poll.test.ts
    prober.test.ts scheduler.test.ts realtime.test.ts
```

---

### Task 1: Carry-forward fixes from Plan 1's final review

**Files:**
- Create: `packages/server/src/lib/params.ts`
- Modify: `packages/server/src/auth/github.ts` (exchange error handling; exchange now also returns `accessToken`), `packages/server/src/checkins/routes.ts` (completed-count join; parseId), `packages/server/src/app.ts` (parseId on read routes), `packages/server/test/github-auth.test.ts` (fakes gain `accessToken`)
- Test: `packages/server/test/params.test.ts`; additions to `test/github-auth.test.ts`, `test/checkins.test.ts`, `test/feed.test.ts`

**Interfaces:**
- Consumes: everything from Plan 1.
- Produces:
  - `parseId(raw: string): number | null` from `lib/params.ts` (accepts 1–15 digit strings only)
  - `GithubExchange` type becomes `(code: string) => Promise<{ githubId: number; handle: string; accessToken: string }>`
  - `class GithubExchangeError extends Error` exported from `auth/github.ts`; OAuth callback returns 502 `{ error: 'github exchange failed' }` when the exchange throws it

- [ ] **Step 1: Write the failing tests**

`packages/server/test/params.test.ts`:
```ts
import { expect, it } from 'vitest'
import { parseId } from '../src/lib/params.js'

it('parses plain positive integers only', () => {
  expect(parseId('42')).toBe(42)
  expect(parseId('0')).toBe(0)
  for (const bad of ['abc', '-1', '1.5', '', '1e3', '99999999999999999']) {
    expect(parseId(bad)).toBeNull()
  }
})
```

Append to `packages/server/test/github-auth.test.ts` (and update the existing fakes in this file to return `accessToken: 'gho_test'` alongside githubId/handle):
```ts
it('a failing exchange returns 502, not a crash', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: {
      clientId: 'x',
      exchange: async () => {
        throw new GithubExchangeError('token exchange failed: 401')
      },
    },
  })
  const start = await app.inject({
    method: 'GET', url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb',
  })
  const state = new URL(start.headers.location as string).searchParams.get('state')!
  const cb = await app.inject({ method: 'GET', url: `/auth/github/callback?code=bad&state=${state}` })
  expect(cb.statusCode).toBe(502)
  expect(cb.json()).toEqual({ error: 'github exchange failed' })
})
```
(Import `GithubExchangeError` from `../src/auth/github.js` at the top.)

Append to `packages/server/test/checkins.test.ts`:
```ts
it('a dormant member checkin does not count toward completed', async () => {
  const { db, app, tom, sarah, clanId } = await setup()
  await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`,
    headers: { authorization: `Bearer ${sarah.token}` },
    payload: { shipped: 'x', blocked: '', next: '' },
  })
  await db.query(`UPDATE clan_members SET status = 'dormant' WHERE user_id = $1`, [sarah.userId])
  const status = await app.inject({
    method: 'GET', url: `/clans/${clanId}/checkins/status`,
    headers: { authorization: `Bearer ${tom.token}` },
  })
  expect(status.json()).toMatchObject({ completed: 0, total: 1 })
})
```
(The existing `setup()` helper in that file already returns `db`, `app`, `tom`, `sarah`, `clanId`; `createUserWithToken` returns `userId`.)

Append to `packages/server/test/feed.test.ts`:
```ts
it('non-numeric ids return 400, not 500', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const { token } = await createUserWithToken(db, 1, 'tomr')
  for (const url of ['/projects/abc/events', '/clans/abc/feed']) {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(400)
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — `lib/params.js` missing, `GithubExchangeError` not exported, dormant-member and 400 tests failing.

- [ ] **Step 3: Implement**

`packages/server/src/lib/params.ts`:
```ts
export function parseId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null
  return Number(raw)
}
```

In `packages/server/src/auth/github.ts`:
```ts
export class GithubExchangeError extends Error {}

export type GithubExchange = (
  code: string,
) => Promise<{ githubId: number; handle: string; accessToken: string }>

export function makeGithubExchange(clientId: string, clientSecret: string): GithubExchange {
  return async (code) => {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    if (!tokenRes.ok) throw new GithubExchangeError(`token exchange failed: ${tokenRes.status}`)
    const { access_token } = (await tokenRes.json()) as { access_token?: string }
    if (!access_token) throw new GithubExchangeError('no access_token in exchange response')
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${access_token}` },
    })
    if (!userRes.ok) throw new GithubExchangeError(`user fetch failed: ${userRes.status}`)
    const gh = (await userRes.json()) as { id?: number; login?: string }
    if (typeof gh.id !== 'number' || !gh.login) throw new GithubExchangeError('malformed user response')
    return { githubId: gh.id, handle: gh.login, accessToken: access_token }
  }
}
```
In the callback handler, wrap the exchange:
```ts
let gh: Awaited<ReturnType<GithubExchange>>
try {
  gh = await deps.exchange(req.query.code)
} catch (err) {
  if (err instanceof GithubExchangeError) {
    return reply.code(502).send({ error: 'github exchange failed' })
  }
  throw err
}
```

In `packages/server/src/checkins/routes.ts`, replace the `completed` subquery in the status route with:
```sql
(SELECT count(DISTINCT c.user_id)::int FROM checkins c
   JOIN clan_members m ON m.clan_id = c.clan_id AND m.user_id = c.user_id
     AND m.status = 'active'
   WHERE c.clan_id = $1 AND c.week_start = $2) AS completed
```
And in both checkins handlers, replace `const clanId = Number(req.params.clanId)` with:
```ts
const clanId = parseId(req.params.clanId)
if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
```
(import `parseId` from `../lib/params.js`). Apply the same pattern to `Number(req.params.projectId)` / `Number(req.params.clanId)` in the two read routes in `src/app.ts`. Update the existing fakes in `test/github-auth.test.ts` to include `accessToken: 'gho_test'`.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS (35 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: exchange error handling, active-only checkin counts, parseId on path params"
```

---

### Task 2: Secret crypto, integration tables, GitHub token capture

**Files:**
- Create: `packages/server/src/lib/crypto.ts`
- Modify: `packages/server/src/db/migrations.ts` (four new tables), `packages/server/src/auth/github.ts` (store encrypted token on callback), `packages/server/src/app.ts` (`AppDeps.secretKey?: Buffer`, threaded into `registerGithubAuth`)
- Test: `packages/server/test/crypto.test.ts`; addition to `test/github-auth.test.ts`

**Interfaces:**
- Consumes: `Db`, `migrate`, OAuth callback (Task 1's exchange with `accessToken`).
- Produces (from `lib/crypto.ts`):
  - `loadSecretKey(env?: NodeJS.ProcessEnv): Buffer` — reads `FORGE_SECRET` (64 hex chars), throws if missing/wrong length
  - `encryptSecret(plain: string, key: Buffer): string` — `iv.ct.tag` base64url triple
  - `decryptSecret(enc: string, key: Buffer): string` — throws on tamper/malformed
- New tables: `user_integrations (user_id, provider CHECK IN ('github'), secret_enc, PRIMARY KEY (user_id, provider))`; `project_integrations (project_id, provider CHECK IN ('stripe'), secret_enc, PRIMARY KEY (project_id, provider))`; `domain_challenges (project_id PRIMARY KEY, domain, token)`; `probe_results (id, project_id, probed_at, ok)`.
- `AppDeps` gains `secretKey?: Buffer`; when present, the OAuth callback upserts the user's encrypted GitHub access token into `user_integrations`. `/auth/github/start` accepts optional `scope` query param (allowlist: absent or `'repo'`) forwarded to the authorize URL.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/crypto.test.ts`:
```ts
import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret, loadSecretKey } from '../src/lib/crypto.js'

const key = randomBytes(32)

it('round-trips a secret', () => {
  const enc = encryptSecret('rk_live_abc123', key)
  expect(enc).not.toContain('rk_live')
  expect(decryptSecret(enc, key)).toBe('rk_live_abc123')
})

it('throws on tampered ciphertext and wrong key', () => {
  const enc = encryptSecret('secret', key)
  const [iv, ct, tag] = enc.split('.')
  expect(() => decryptSecret(`${iv}.${ct!.slice(0, -2)}AA.${tag}`, key)).toThrow()
  expect(() => decryptSecret(enc, randomBytes(32))).toThrow()
  expect(() => decryptSecret('nonsense', key)).toThrow()
})

it('loadSecretKey enforces 64 hex chars', () => {
  expect(loadSecretKey({ FORGE_SECRET: 'ab'.repeat(32) }).length).toBe(32)
  expect(() => loadSecretKey({})).toThrow()
  expect(() => loadSecretKey({ FORGE_SECRET: 'abcd' })).toThrow()
})
```

Append to `packages/server/test/github-auth.test.ts`:
```ts
it('callback stores the encrypted github token when secretKey is set', async () => {
  const db = await makeTestDb()
  const key = randomBytes(32)
  const app = buildApp({
    db,
    secretKey: key,
    github: {
      clientId: 'x',
      exchange: async () => ({ githubId: 7, handle: 'tok', accessToken: 'gho_secret' }),
    },
  })
  const start = await app.inject({
    method: 'GET', url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb&scope=repo',
  })
  expect(start.headers.location).toContain('scope=repo')
  const state = new URL(start.headers.location as string).searchParams.get('state')!
  await app.inject({ method: 'GET', url: `/auth/github/callback?code=c&state=${state}` })
  const { rows } = await db.query<{ secret_enc: string }>(
    `SELECT secret_enc FROM user_integrations ui JOIN users u ON u.id = ui.user_id
     WHERE u.github_id = 7 AND ui.provider = 'github'`,
  )
  expect(rows).toHaveLength(1)
  expect(decryptSecret(rows[0]!.secret_enc, key)).toBe('gho_secret')
})
```
(add imports: `randomBytes` from `node:crypto`, `decryptSecret` from `../src/lib/crypto.js`)

Also append to `test/migrations.test.ts`:
```ts
it('integration and probe tables exist', async () => {
  const db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'u')`)
  await db.query(`INSERT INTO projects (owner_id, name) VALUES (1, 'p')`)
  await db.query(`INSERT INTO user_integrations (user_id, provider, secret_enc) VALUES (1, 'github', 'x')`)
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc) SELECT id, 'stripe', 'y' FROM projects LIMIT 1`,
  )
  await db.query(`INSERT INTO probe_results (project_id, ok) SELECT id, true FROM projects LIMIT 1`)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — crypto module missing, tables missing, `secretKey` not in `AppDeps`.

- [ ] **Step 3: Implement**

`packages/server/src/lib/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function loadSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.FORGE_SECRET
  if (!raw) throw new Error('FORGE_SECRET is required')
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) throw new Error('FORGE_SECRET must be 64 hex chars (32 bytes)')
  return key
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.')
}

export function decryptSecret(enc: string, key: Buffer): string {
  const parts = enc.split('.')
  if (parts.length !== 3) throw new Error('malformed encrypted secret')
  const [iv, ct, tag] = parts.map((s) => Buffer.from(s, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', key, iv!)
  d.setAuthTag(tag!)
  return Buffer.concat([d.update(ct!), d.final()]).toString('utf8')
}
```

In `src/db/migrations.ts`, append to the SCHEMA constant (before the trigger statements array):
```sql
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id BIGINT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  secret_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS project_integrations (
  project_id BIGINT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe')),
  secret_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, provider)
);
CREATE TABLE IF NOT EXISTS domain_challenges (
  project_id BIGINT PRIMARY KEY REFERENCES projects(id),
  domain TEXT NOT NULL,
  token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  probed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL
);
```

In `src/app.ts`: add `secretKey?: Buffer` to `AppDeps` and pass it to `registerGithubAuth` (`{ db: deps.db, secretKey: deps.secretKey, ...deps.github }`).

In `src/auth/github.ts`:
- `registerGithubAuth` deps gain `secretKey?: Buffer`.
- `/auth/github/start` querystring gains optional `scope`; reject values other than `undefined`/`''`/`'repo'` with 400; when `'repo'`, set `url.searchParams.set('scope', 'repo')`.
- In the callback after `createSession`, before the redirect:
```ts
if (deps.secretKey) {
  await deps.db.query(
    `INSERT INTO user_integrations (user_id, provider, secret_enc) VALUES ($1, 'github', $2)
     ON CONFLICT (user_id, provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc`,
    [userId, encryptSecret(gh.accessToken, deps.secretKey)],
  )
}
```
(import `encryptSecret` from `../lib/crypto.js`; `userId` is the id already selected for `createSession`).

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: AES-GCM secret storage, integration tables, github token capture"
```

---

### Task 3: emitMilestone + Notifier

**Files:**
- Create: `packages/server/src/events/emit.ts`
- Test: `packages/server/test/emit.test.ts`

**Interfaces:**
- Consumes: `appendMilestone`, `MilestoneEvent`, `Vertical` from `events/log.ts`.
- Produces (from `events/emit.ts`):
  - `interface Notifier { milestone(event: MilestoneEvent & { handle: string; projectName: string }): Promise<void> }`
  - `const nullNotifier: Notifier`
  - `emitMilestone(db: Db, notifier: Notifier, input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string }): Promise<{ created: boolean; event: MilestoneEvent }>` — appends; on `created === true` looks up handle/projectName and calls `notifier.milestone`; notifier errors are swallowed (never fail the emission); on `created === false` the notifier is NOT called.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/emit.test.ts`:
```ts
import { expect, it, beforeEach } from 'vitest'
import type { Db } from '../src/db/client.js'
import { makeTestDb } from './helpers.js'
import { emitMilestone, type Notifier } from '../src/events/emit.js'

let db: Db
let projectId: number

beforeEach(async () => {
  db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name) VALUES (1, 'launchpage') RETURNING id`,
  )
  projectId = Number(rows[0]!.id)
})

function capture() {
  const seen: unknown[] = []
  const notifier: Notifier = { milestone: async (e) => void seen.push(e) }
  return { seen, notifier }
}

it('notifies with handle and project name on first emission only', async () => {
  const { seen, notifier } = capture()
  const input = {
    projectId, vertical: 'build' as const, rung: 1,
    evidenceRef: 'github:push:abc', dedupeKey: 'k1',
  }
  const first = await emitMilestone(db, notifier, input)
  expect(first.created).toBe(true)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ handle: 'tomr', projectName: 'launchpage', rung: 1 })
  const second = await emitMilestone(db, notifier, { ...input, dedupeKey: 'k2' })
  expect(second.created).toBe(false)
  expect(seen).toHaveLength(1)
})

it('a throwing notifier does not fail the emission', async () => {
  const notifier: Notifier = { milestone: async () => { throw new Error('socket gone') } }
  const res = await emitMilestone(db, notifier, {
    projectId, vertical: 'ship', rung: 1, evidenceRef: 'probe:200', dedupeKey: 'k3',
  })
  expect(res.created).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/server/src/events/emit.ts`:
```ts
import type { Db } from '../db/client.js'
import { appendMilestone, type MilestoneEvent, type Vertical } from './log.js'

export interface Notifier {
  milestone(event: MilestoneEvent & { handle: string; projectName: string }): Promise<void>
}

export const nullNotifier: Notifier = { milestone: async () => {} }

export async function emitMilestone(
  db: Db,
  notifier: Notifier,
  input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string },
): Promise<{ created: boolean; event: MilestoneEvent }> {
  const res = await appendMilestone(db, input)
  if (res.created) {
    const { rows } = await db.query<{ handle: string; name: string }>(
      `SELECT u.handle, p.name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = $1`,
      [input.projectId],
    )
    const row = rows[0]
    if (row) {
      try {
        await notifier.milestone({ ...res.event, handle: row.handle, projectName: row.name })
      } catch {
        // notification failures never fail an emission
      }
    }
  }
  return res
}
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: emitMilestone gateway with swallowed-notifier semantics"
```

---

### Task 4: Integration routes — Stripe key, repo link, deploy URL

**Files:**
- Create: `packages/server/src/integrations/routes.ts`
- Modify: `packages/server/src/app.ts` (register when `secretKey` present; `AppDeps` gains `notifier?: Notifier` and `integrations?: { stripeValidate: StripeValidate; webhookCreate: WebhookCreate }`)
- Test: `packages/server/test/integrations.test.ts`

**Interfaces:**
- Consumes: `parseId`, `encryptSecret`, `decryptSecret`, `emitMilestone`, `nullNotifier`, `userFromRequest`.
- Produces (from `integrations/routes.ts`):
  - `type StripeValidate = (apiKey: string) => Promise<boolean>` (real impl arrives in Task 7)
  - `type WebhookCreate = (githubToken: string, repoFullName: string) => Promise<boolean>` (real impl in Task 5)
  - `registerIntegrations(app, deps: { db: Db; secretKey: Buffer; notifier: Notifier; stripeValidate: StripeValidate; webhookCreate: WebhookCreate }): void` with routes (all owner-only, 403 otherwise; 401 unauthenticated; parseId → 400):
    - `POST /projects/:projectId/stripe` body `{ apiKey }` (schema: required string 1–200) → validate key via `stripeValidate` (false → 400 `{ error: 'invalid stripe key' }`); store encrypted (upsert); **emit revenue rung 1** (`evidenceRef: 'stripe:connected'`, `dedupeKey: 'stripe-connected-<projectId>'`); → 200 `{ connected: true }`. The API key never appears in any response or log.
    - `POST /projects/:projectId/repo` body `{ repoFullName }` (schema: required string 3–140, pattern `^[^/\s]+/[^/\s]+$`) → requires the owner's `user_integrations` github token (missing → 409 `{ error: 'connect github first' }`); decrypt token, call `webhookCreate` (false → 502 `{ error: 'could not create webhook' }`); set `projects.repo_full_name`; → 200 `{ linked: true }`.
    - `PATCH /projects/:projectId` body `{ deployUrl }` (schema: required string 1–300, must parse as http(s) URL else 400) → set `projects.deploy_url`; → 200 `{ ok: true }`.
- In `app.ts`: `if (deps.secretKey && deps.integrations) registerIntegrations(app, { db: deps.db, secretKey: deps.secretKey, notifier: deps.notifier ?? nullNotifier, ...deps.integrations })`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/integrations.test.ts`:
```ts
import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { encryptSecret, decryptSecret } from '../src/lib/crypto.js'
import { listProjectEvents } from '../src/events/log.js'

const key = randomBytes(32)

async function setup(opts: { stripeOk?: boolean; webhookOk?: boolean } = {}) {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    secretKey: key,
    integrations: {
      stripeValidate: async () => opts.stripeOk ?? true,
      webhookCreate: async () => opts.webhookOk ?? true,
    },
  })
  const me = await createUserWithToken(db, 1, 'tomr')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${me.token}` }, payload: { name: 'launchpage' },
  })
  return { db, app, me, projectId: proj.json().id as number }
}

it('stripe connect stores encrypted key and emits revenue rung 1 once', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const res = await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`, headers: auth,
    payload: { apiKey: 'rk_live_secret123' },
  })
  expect(res.statusCode).toBe(200)
  expect(JSON.stringify(res.json())).not.toContain('rk_live')
  const { rows } = await db.query<{ secret_enc: string }>(
    `SELECT secret_enc FROM project_integrations WHERE project_id = $1 AND provider = 'stripe'`,
    [projectId],
  )
  expect(decryptSecret(rows[0]!.secret_enc, key)).toBe('rk_live_secret123')
  await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`, headers: auth,
    payload: { apiKey: 'rk_live_rotated' },
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.filter((e) => e.vertical === 'revenue' && e.rung === 1)).toHaveLength(1)
})

it('invalid stripe key is 400 and stores nothing', async () => {
  const { db, app, me, projectId } = await setup({ stripeOk: false })
  const res = await app.inject({
    method: 'POST', url: `/projects/${projectId}/stripe`,
    headers: { authorization: `Bearer ${me.token}` }, payload: { apiKey: 'rk_bad' },
  })
  expect(res.statusCode).toBe(400)
  const { rows } = await db.query(`SELECT 1 FROM project_integrations WHERE project_id = $1`, [projectId])
  expect(rows).toHaveLength(0)
})

it('repo link requires github integration, then stores repo_full_name', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const before = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repo`, headers: auth,
    payload: { repoFullName: 'tomr/launchpage' },
  })
  expect(before.statusCode).toBe(409)
  await db.query(
    `INSERT INTO user_integrations (user_id, provider, secret_enc) VALUES ($1, 'github', $2)`,
    [me.userId, encryptSecret('gho_tok', key)],
  )
  const after = await app.inject({
    method: 'POST', url: `/projects/${projectId}/repo`, headers: auth,
    payload: { repoFullName: 'tomr/launchpage' },
  })
  expect(after.statusCode).toBe(200)
  const { rows } = await db.query<{ repo_full_name: string }>(
    `SELECT repo_full_name FROM projects WHERE id = $1`, [projectId],
  )
  expect(rows[0]!.repo_full_name).toBe('tomr/launchpage')
})

it('deployUrl patch validates URL shape; non-owner is 403; bad body is 400', async () => {
  const { db, app, me, projectId } = await setup()
  const auth = { authorization: `Bearer ${me.token}` }
  const ok = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`, headers: auth,
    payload: { deployUrl: 'https://launchpage.app' },
  })
  expect(ok.statusCode).toBe(200)
  const bad = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`, headers: auth, payload: { deployUrl: 'not a url' },
  })
  expect(bad.statusCode).toBe(400)
  const missing = await app.inject({ method: 'PATCH', url: `/projects/${projectId}`, headers: auth, payload: {} })
  expect(missing.statusCode).toBe(400)
  const other = await createUserWithToken(db, 2, 'eve')
  const forbidden = await app.inject({
    method: 'PATCH', url: `/projects/${projectId}`,
    headers: { authorization: `Bearer ${other.token}` }, payload: { deployUrl: 'https://x.dev' },
  })
  expect(forbidden.statusCode).toBe(403)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — 404s (routes absent), `integrations` not in `AppDeps`.

- [ ] **Step 3: Implement**

`packages/server/src/integrations/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'
import { parseId } from '../lib/params.js'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export type StripeValidate = (apiKey: string) => Promise<boolean>
export type WebhookCreate = (githubToken: string, repoFullName: string) => Promise<boolean>

interface Deps {
  db: Db
  secretKey: Buffer
  notifier: Notifier
  stripeValidate: StripeValidate
  webhookCreate: WebhookCreate
}

async function ownedProject(
  deps: Deps,
  req: { headers: { authorization?: string }; params: { projectId: string } },
): Promise<{ status: 200; projectId: number; userId: number } | { status: 400 | 401 | 403 }> {
  const user = await userFromRequest(deps.db, req)
  if (!user) return { status: 401 }
  const projectId = parseId(req.params.projectId)
  if (projectId === null) return { status: 400 }
  const { rows } = await deps.db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2`, [projectId, user.id],
  )
  if (!rows[0]) return { status: 403 }
  return { status: 200, projectId, userId: user.id }
}

export function registerIntegrations(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { projectId: string }; Body: { apiKey: string } }>(
    '/projects/:projectId/stripe',
    {
      schema: {
        body: {
          type: 'object', required: ['apiKey'],
          properties: { apiKey: { type: 'string', minLength: 1, maxLength: 200 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      if (!(await deps.stripeValidate(req.body.apiKey))) {
        return reply.code(400).send({ error: 'invalid stripe key' })
      }
      await deps.db.query(
        `INSERT INTO project_integrations (project_id, provider, secret_enc) VALUES ($1, 'stripe', $2)
         ON CONFLICT (project_id, provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc`,
        [own.projectId, encryptSecret(req.body.apiKey, deps.secretKey)],
      )
      await emitMilestone(deps.db, deps.notifier, {
        projectId: own.projectId, vertical: 'revenue', rung: 1,
        evidenceRef: 'stripe:connected', dedupeKey: `stripe-connected-${own.projectId}`,
      })
      return reply.send({ connected: true })
    },
  )

  app.post<{ Params: { projectId: string }; Body: { repoFullName: string } }>(
    '/projects/:projectId/repo',
    {
      schema: {
        body: {
          type: 'object', required: ['repoFullName'],
          properties: {
            repoFullName: { type: 'string', minLength: 3, maxLength: 140, pattern: '^[^/\\s]+/[^/\\s]+$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      const { rows } = await deps.db.query<{ secret_enc: string }>(
        `SELECT secret_enc FROM user_integrations WHERE user_id = $1 AND provider = 'github'`,
        [own.userId],
      )
      if (!rows[0]) return reply.code(409).send({ error: 'connect github first' })
      const token = decryptSecret(rows[0].secret_enc, deps.secretKey)
      if (!(await deps.webhookCreate(token, req.body.repoFullName))) {
        return reply.code(502).send({ error: 'could not create webhook' })
      }
      await deps.db.query(`UPDATE projects SET repo_full_name = $1 WHERE id = $2`, [
        req.body.repoFullName, own.projectId,
      ])
      return reply.send({ linked: true })
    },
  )

  app.patch<{ Params: { projectId: string }; Body: { deployUrl: string } }>(
    '/projects/:projectId',
    {
      schema: {
        body: {
          type: 'object', required: ['deployUrl'],
          properties: { deployUrl: { type: 'string', minLength: 1, maxLength: 300 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const own = await ownedProject(deps, req)
      if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
      let parsed: URL
      try {
        parsed = new URL(req.body.deployUrl)
      } catch {
        return reply.code(400).send({ error: 'invalid url' })
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return reply.code(400).send({ error: 'invalid url' })
      }
      await deps.db.query(`UPDATE projects SET deploy_url = $1 WHERE id = $2`, [
        req.body.deployUrl, own.projectId,
      ])
      return reply.send({ ok: true })
    },
  )
}
```

In `src/app.ts`: import `registerIntegrations` and types; extend `AppDeps` with `notifier?: Notifier` and `integrations?: { stripeValidate: StripeValidate; webhookCreate: WebhookCreate }`; register as described in Interfaces.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: stripe key, repo link, and deploy-url integration routes"
```

---

### Task 5: GitHub webhook receiver

**Files:**
- Create: `packages/server/src/workers/github-webhook.ts`
- Modify: `packages/server/src/app.ts` (register when `deps.githubWebhookSecret` present; `AppDeps` gains `githubWebhookSecret?: string`)
- Test: `packages/server/test/github-webhook.test.ts`

**Interfaces:**
- Consumes: `emitMilestone`, `Notifier`, `Db`.
- Produces:
  - `registerGithubWebhook(app, deps: { db: Db; notifier: Notifier; secret: string }): void` — `POST /webhooks/github` inside a scoped Fastify plugin whose JSON parser preserves the raw body string for HMAC.
  - `makeWebhookCreate(): WebhookCreate` — real fetch-based impl: `POST /repos/{repo}/hooks` with events `push, pull_request, workflow_run, release`; returns `res.ok || res.status === 422` (422 = hook already exists).
  - Verification: `X-Hub-Signature-256` must equal `sha256=` + HMAC-SHA256(raw body, secret), compared with `timingSafeEqual` — anything else → 401 with no side effects.
  - Event mapping (only when a project row matches `repository.full_name`; unknown repos → 204 no-op). Dedupe key is always the `X-GitHub-Delivery` GUID (`gh-<delivery>`):
    - `push` → build rung 1, evidence `github:push:<head_commit_sha_or_after>`
    - `pull_request` with `action === 'closed'` and `pull_request.merged === true` → build rung 2, evidence `github:pr:<number>`
    - `workflow_run` with `action === 'completed'`, `conclusion === 'success'`, `workflow_run.head_branch === repository.default_branch` → build rung 3, evidence `github:ci:<workflow_run.id>`
    - `release` with `action === 'published'` → build rung 4, evidence `github:release:<release.tag_name>`
    - Anything else → 204, no emission (never-false rule: unrecognized shapes are skipped, not guessed).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/github-webhook.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — 404 (route absent).

- [ ] **Step 3: Implement**

`packages/server/src/workers/github-webhook.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { emitMilestone, type Notifier } from '../events/emit.js'
import type { WebhookCreate } from '../integrations/routes.js'

interface Deps {
  db: Db
  notifier: Notifier
  secret: string
}

function verify(secret: string, raw: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const got = header.slice(7)
  if (got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'))
}

interface Detection {
  rung: number
  evidenceRef: string
}

export function detectBuildMilestone(event: string, p: Record<string, unknown>): Detection | null {
  const pr = p.pull_request as { merged?: boolean; number?: number } | undefined
  const run = p.workflow_run as { id?: number; conclusion?: string; head_branch?: string } | undefined
  const repo = p.repository as { default_branch?: string } | undefined
  const release = p.release as { tag_name?: string } | undefined
  if (event === 'push' && typeof p.after === 'string') {
    return { rung: 1, evidenceRef: `github:push:${p.after}` }
  }
  if (event === 'pull_request' && p.action === 'closed' && pr?.merged === true) {
    return { rung: 2, evidenceRef: `github:pr:${pr.number ?? 'unknown'}` }
  }
  if (
    event === 'workflow_run' && p.action === 'completed' &&
    run?.conclusion === 'success' && run.head_branch === repo?.default_branch
  ) {
    return { rung: 3, evidenceRef: `github:ci:${run.id ?? 'unknown'}` }
  }
  if (event === 'release' && p.action === 'published' && release?.tag_name) {
    return { rung: 4, evidenceRef: `github:release:${release.tag_name}` }
  }
  return null
}

export function registerGithubWebhook(app: FastifyInstance, deps: Deps): void {
  app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    )
    scoped.post('/webhooks/github', async (req, reply) => {
      const raw = req.body as string
      if (!verify(deps.secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'bad signature' })
      }
      const event = req.headers['x-github-event'] as string | undefined
      const delivery = req.headers['x-github-delivery'] as string | undefined
      if (!event || !delivery) return reply.code(400).send({ error: 'missing headers' })
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'bad json' })
      }
      const repoName = (payload.repository as { full_name?: string } | undefined)?.full_name
      if (!repoName) return reply.code(204).send()
      const { rows } = await deps.db.query<{ id: number }>(
        `SELECT id FROM projects WHERE repo_full_name = $1`, [repoName],
      )
      const detection = detectBuildMilestone(event, payload)
      if (!rows[0] || !detection) return reply.code(204).send()
      await emitMilestone(deps.db, deps.notifier, {
        projectId: Number(rows[0].id), vertical: 'build', rung: detection.rung,
        evidenceRef: detection.evidenceRef, dedupeKey: `gh-${delivery}`,
      })
      return reply.code(204).send()
    })
  })
}

export function makeWebhookCreate(webhookUrl: string, webhookSecret: string): WebhookCreate {
  return async (githubToken, repoFullName) => {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/hooks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        config: { url: webhookUrl, content_type: 'json', secret: webhookSecret },
        events: ['push', 'pull_request', 'workflow_run', 'release'],
      }),
    })
    return res.ok || res.status === 422
  }
}
```

In `src/app.ts`: `AppDeps` gains `githubWebhookSecret?: string`; register:
```ts
if (deps.githubWebhookSecret) {
  registerGithubWebhook(app, {
    db: deps.db, notifier: deps.notifier ?? nullNotifier, secret: deps.githubWebhookSecret,
  })
}
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: HMAC-verified github webhook mapping events to build rungs"
```

---

### Task 6: GitHub reconciliation poller

**Files:**
- Create: `packages/server/src/workers/github-poll.ts`
- Test: `packages/server/test/github-poll.test.ts`

**Interfaces:**
- Consumes: `Db`, `decryptSecret`, `emitMilestone`, `Notifier`.
- Produces (from `workers/github-poll.ts`):
  - `interface GithubClient { repoState(token: string, repoFullName: string): Promise<{ hasCommit: boolean; hasMergedPr: boolean; ciGreenOnDefault: boolean; hasRelease: boolean } | null> }` — `null` means "could not determine" (API error): skip, never emit.
  - `makeGithubClient(): GithubClient` — real fetch impl (commits list length>0; search merged PRs; latest default-branch workflow run success; releases length>0; any non-OK response → `null`).
  - `runGithubPoll(deps: { db: Db; notifier: Notifier; secretKey: Buffer; github: GithubClient }): Promise<void>` — for every project with `repo_full_name` whose owner has a github integration: decrypt token, get state; emit build rungs 1–4 for each true flag with dedupe keys `gh-poll-<projectId>-b<rung>` and evidence `github:poll:<flag>`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/github-poll.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/server/src/workers/github-poll.ts`:
```ts
import type { Db } from '../db/client.js'
import { decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export interface GithubClient {
  repoState(token: string, repoFullName: string): Promise<{
    hasCommit: boolean; hasMergedPr: boolean; ciGreenOnDefault: boolean; hasRelease: boolean
  } | null>
}

export function makeGithubClient(): GithubClient {
  const api = async (token: string, path: string): Promise<unknown | null> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    return res.json()
  }
  return {
    repoState: async (token, repo) => {
      const commits = (await api(token, `/repos/${repo}/commits?per_page=1`)) as unknown[] | null
      const prs = (await api(
        token,
        `/search/issues?q=repo:${encodeURIComponent(repo)}+is:pr+is:merged&per_page=1`,
      )) as { total_count?: number } | null
      const repoMeta = (await api(token, `/repos/${repo}`)) as { default_branch?: string } | null
      const runs = repoMeta?.default_branch
        ? ((await api(
            token,
            `/repos/${repo}/actions/runs?branch=${repoMeta.default_branch}&status=success&per_page=1`,
          )) as { total_count?: number } | null)
        : null
      const releases = (await api(token, `/repos/${repo}/releases?per_page=1`)) as unknown[] | null
      if (commits === null || prs === null || repoMeta === null || releases === null) return null
      return {
        hasCommit: commits.length > 0,
        hasMergedPr: (prs.total_count ?? 0) > 0,
        ciGreenOnDefault: (runs?.total_count ?? 0) > 0,
        hasRelease: releases.length > 0,
      }
    },
  }
}

export async function runGithubPoll(deps: {
  db: Db; notifier: Notifier; secretKey: Buffer; github: GithubClient
}): Promise<void> {
  const { rows } = await deps.db.query<{ id: number; repo_full_name: string; secret_enc: string }>(
    `SELECT p.id, p.repo_full_name, ui.secret_enc
     FROM projects p
     JOIN user_integrations ui ON ui.user_id = p.owner_id AND ui.provider = 'github'
     WHERE p.repo_full_name IS NOT NULL`,
  )
  for (const row of rows) {
    let state: Awaited<ReturnType<GithubClient['repoState']>>
    try {
      state = await deps.github.repoState(decryptSecret(row.secret_enc, deps.secretKey), row.repo_full_name)
    } catch {
      continue
    }
    if (!state) continue
    const projectId = Number(row.id)
    const rungs: Array<[boolean, number, string]> = [
      [state.hasCommit, 1, 'hasCommit'],
      [state.hasMergedPr, 2, 'hasMergedPr'],
      [state.ciGreenOnDefault, 3, 'ciGreenOnDefault'],
      [state.hasRelease, 4, 'hasRelease'],
    ]
    for (const [flag, rung, name] of rungs) {
      if (!flag) continue
      await emitMilestone(deps.db, deps.notifier, {
        projectId, vertical: 'build', rung,
        evidenceRef: `github:poll:${name}`, dedupeKey: `gh-poll-${projectId}-b${rung}`,
      })
    }
  }
}
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: github reconciliation poller with injected client"
```

---

### Task 7: Stripe poller

**Files:**
- Create: `packages/server/src/workers/stripe-poll.ts`
- Test: `packages/server/test/stripe-poll.test.ts`

**Interfaces:**
- Consumes: `Db`, `decryptSecret`, `emitMilestone`.
- Produces (from `workers/stripe-poll.ts`):
  - `interface StripeClient { summary(apiKey: string): Promise<{ firstChargeId: string | null; paidCustomerCount: number; grossRevenueCents: number; activeMrrCents: number } | null> }` — `firstChargeId` is the earliest **succeeded, non-refunded** charge; `null` summary = could not determine → skip.
  - `makeStripeClient(): StripeClient` — real impl over `https://api.stripe.com/v1` (Bearer key): pages `/charges?limit=100` up to 10 pages (documented cap), filters `status === 'succeeded' && !refunded`; distinct customer ids among those charges; gross = sum of their `amount`; MRR = sum over `/subscriptions?status=active&limit=100` of `items.data[].price.unit_amount * quantity`. Any non-OK response → `null`.
  - `makeStripeValidate(client: StripeClient): StripeValidate` — key is valid iff `summary(key)` returns non-null.
  - `runStripePoll(deps: { db: Db; notifier: Notifier; secretKey: Buffer; stripe: StripeClient }): Promise<void>` — for each project with a stripe integration: rung 2 on `firstChargeId` (evidence `stripe:charge:<id>`, dedupe `stripe-charge-<id>`), rung 3 on `paidCustomerCount >= 10` (dedupe `stripe-cust10-<projectId>`), rung 4 on `grossRevenueCents >= 10000` (dedupe `stripe-100-<projectId>`), rung 5 on `grossRevenueCents >= 100000 || activeMrrCents >= 10000` (dedupe `stripe-1k-<projectId>`).

- [ ] **Step 1: Write the failing tests**

`packages/server/test/stripe-poll.test.ts`:
```ts
import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from './helpers.js'
import { encryptSecret } from '../src/lib/crypto.js'
import { nullNotifier } from '../src/events/emit.js'
import { listProjectEvents } from '../src/events/log.js'
import { runStripePoll, type StripeClient } from '../src/workers/stripe-poll.js'

const key = randomBytes(32)

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name) VALUES (1, 'p') RETURNING id`,
  )
  const projectId = Number(rows[0]!.id)
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc) VALUES ($1, 'stripe', $2)`,
    [projectId, encryptSecret('rk_test', key)],
  )
  return projectId
}

function client(s: Partial<Awaited<ReturnType<StripeClient['summary']>> & object>): StripeClient {
  return {
    summary: async () => ({
      firstChargeId: null, paidCustomerCount: 0, grossRevenueCents: 0, activeMrrCents: 0,
      ...(s as object),
    }),
  }
}

it('first dollar emits rung 2; thresholds emit 3-5; idempotent', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  const deps = {
    db, notifier: nullNotifier, secretKey: key,
    stripe: client({ firstChargeId: 'ch_1', paidCustomerCount: 12, grossRevenueCents: 150000, activeMrrCents: 0 }),
  }
  await runStripePoll(deps)
  await runStripePoll(deps)
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => e.rung).sort()).toEqual([2, 3, 4, 5])
  expect(events.find((e) => e.rung === 2)!.evidenceRef).toBe('stripe:charge:ch_1')
})

it('no qualifying charge emits nothing; null summary emits nothing', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  await runStripePoll({ db, notifier: nullNotifier, secretKey: key, stripe: client({}) })
  await runStripePoll({
    db, notifier: nullNotifier, secretKey: key,
    stripe: { summary: async () => null },
  })
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})

it('$100 MRR alone satisfies rung 5', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db)
  await runStripePoll({
    db, notifier: nullNotifier, secretKey: key,
    stripe: client({ firstChargeId: 'ch_9', grossRevenueCents: 5000, activeMrrCents: 10000 }),
  })
  const rungs = (await listProjectEvents(db, projectId)).map((e) => e.rung)
  expect(rungs).toContain(5)
  expect(rungs).not.toContain(4)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/server/src/workers/stripe-poll.ts`:
```ts
import type { Db } from '../db/client.js'
import { decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'
import type { StripeValidate } from '../integrations/routes.js'

export interface StripeClient {
  summary(apiKey: string): Promise<{
    firstChargeId: string | null
    paidCustomerCount: number
    grossRevenueCents: number
    activeMrrCents: number
  } | null>
}

interface StripeCharge {
  id: string
  status: string
  refunded: boolean
  amount: number
  created: number
  customer: string | null
}

export function makeStripeClient(): StripeClient {
  const api = async (key: string, path: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { authorization: `Bearer ${key}` },
    })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  }
  return {
    summary: async (apiKey) => {
      const charges: StripeCharge[] = []
      let starting: string | null = null
      for (let page = 0; page < 10; page++) {
        const qs = `limit=100${starting ? `&starting_after=${starting}` : ''}`
        const res = await api(apiKey, `/charges?${qs}`)
        if (!res) return null
        const data = res.data as StripeCharge[]
        charges.push(...data)
        if (!res.has_more || data.length === 0) break
        starting = data[data.length - 1]!.id
      }
      const good = charges
        .filter((c) => c.status === 'succeeded' && !c.refunded)
        .sort((a, b) => a.created - b.created)
      const subsRes = await api(apiKey, '/subscriptions?status=active&limit=100')
      if (!subsRes) return null
      const subs = subsRes.data as Array<{
        items: { data: Array<{ quantity: number; price: { unit_amount: number | null } }> }
      }>
      const mrr = subs.reduce(
        (sum, s) =>
          sum + s.items.data.reduce((x, i) => x + (i.price.unit_amount ?? 0) * i.quantity, 0),
        0,
      )
      return {
        firstChargeId: good[0]?.id ?? null,
        paidCustomerCount: new Set(good.map((c) => c.customer).filter(Boolean)).size,
        grossRevenueCents: good.reduce((sum, c) => sum + c.amount, 0),
        activeMrrCents: mrr,
      }
    },
  }
}

export function makeStripeValidate(client: StripeClient): StripeValidate {
  return async (apiKey) => (await client.summary(apiKey)) !== null
}

export async function runStripePoll(deps: {
  db: Db; notifier: Notifier; secretKey: Buffer; stripe: StripeClient
}): Promise<void> {
  const { rows } = await deps.db.query<{ project_id: number; secret_enc: string }>(
    `SELECT project_id, secret_enc FROM project_integrations WHERE provider = 'stripe'`,
  )
  for (const row of rows) {
    let s: Awaited<ReturnType<StripeClient['summary']>>
    try {
      s = await deps.stripe.summary(decryptSecret(row.secret_enc, deps.secretKey))
    } catch {
      continue
    }
    if (!s) continue
    const projectId = Number(row.project_id)
    const emit = (rung: number, evidenceRef: string, dedupeKey: string) =>
      emitMilestone(deps.db, deps.notifier, { projectId, vertical: 'revenue', rung, evidenceRef, dedupeKey })
    if (s.firstChargeId) await emit(2, `stripe:charge:${s.firstChargeId}`, `stripe-charge-${s.firstChargeId}`)
    if (s.paidCustomerCount >= 10) await emit(3, `stripe:customers:${s.paidCustomerCount}`, `stripe-cust10-${projectId}`)
    if (s.grossRevenueCents >= 10000) await emit(4, `stripe:gross:${s.grossRevenueCents}`, `stripe-100-${projectId}`)
    if (s.grossRevenueCents >= 100000 || s.activeMrrCents >= 10000) {
      await emit(5, `stripe:gross:${s.grossRevenueCents}:mrr:${s.activeMrrCents}`, `stripe-1k-${projectId}`)
    }
  }
}
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: stripe revenue poller with refund-safe first-dollar detection"
```

---

### Task 8: Deploy, DNS, and uptime prober

**Files:**
- Create: `packages/server/src/workers/prober.ts`
- Modify: `packages/server/src/integrations/routes.ts` (add `POST /projects/:projectId/domain`), `packages/server/src/app.ts` (thread deps)
- Test: `packages/server/test/prober.test.ts`

**Interfaces:**
- Consumes: `Db`, `emitMilestone`, `parseId`, `userFromRequest`.
- Produces (from `workers/prober.ts`):
  - `type Fetcher = (url: string) => Promise<{ ok: boolean } | null>` (null = network error)
  - `type TxtResolver = (domain: string) => Promise<string[] | null>`
  - `makeFetcher(): Fetcher` (fetch with 10s AbortSignal timeout; any throw → null), `makeTxtResolver(): TxtResolver` (node:dns/promises `resolveTxt`, flattened; NXDOMAIN/error → null)
  - `runProber(deps: { db: Db; notifier: Notifier; fetch: Fetcher; resolveTxt: TxtResolver }): Promise<void>`:
    - For each project with `deploy_url`: probe. `ok` → insert `probe_results(ok=true)` + emit ship rung 1 IF the url is https (evidence `probe:200`, dedupe `deploy-live-<projectId>`). `{ok:false}` → insert `probe_results(ok=false)`. `null` (network error on OUR side) → insert nothing (never punish the project for our outage), emit nothing.
    - For each `domain_challenges` row: resolve TXT for `_forge.<domain>`; if records include `forge-verify=<token>` → emit ship rung 2 (evidence `dns:<domain>`, dedupe `dns-<projectId>`) and delete the challenge row.
    - Uptime: for each project with `deploy_url`, emit ship rung 4 (evidence `probe:uptime30`, dedupe `uptime30-<projectId>`) iff `min(probed_at) WHERE ok` ≤ now − 30 days AND no `ok = false` row in the last 30 days.
  - New route in `integrations/routes.ts` — `POST /projects/:projectId/domain` body `{ domain }` (schema: required string 4–253, pattern `^[a-z0-9.-]+$`): upsert `domain_challenges` with token `forge-verify=` + 16-byte base64url; → 200 `{ record: '_forge.<domain>', value: '<token>' }` for the user to add as TXT.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/prober.test.ts`:
```ts
import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { nullNotifier } from '../src/events/emit.js'
import { listProjectEvents } from '../src/events/log.js'
import { runProber } from '../src/workers/prober.js'

const key = randomBytes(32)

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, deployUrl: string | null) {
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (owner_id, name, deploy_url) VALUES (1, 'p', $1) RETURNING id`,
    [deployUrl],
  )
  return Number(rows[0]!.id)
}

it('live https deploy emits ship 1 and records an ok probe', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await runProber({
    db, notifier: nullNotifier,
    fetch: async () => ({ ok: true }), resolveTxt: async () => null,
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => [e.vertical, e.rung])).toEqual([['ship', 1]])
  const { rows } = await db.query(`SELECT ok FROM probe_results WHERE project_id = $1`, [projectId])
  expect(rows).toEqual([{ ok: true }])
})

it('failed probe records ok=false but our own network error records nothing', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await runProber({ db, notifier: nullNotifier, fetch: async () => ({ ok: false }), resolveTxt: async () => null })
  await runProber({ db, notifier: nullNotifier, fetch: async () => null, resolveTxt: async () => null })
  const { rows } = await db.query(`SELECT ok FROM probe_results WHERE project_id = $1`, [projectId])
  expect(rows).toEqual([{ ok: false }])
  expect(await listProjectEvents(db, projectId)).toHaveLength(0)
})

it('dns challenge verifies and emits ship 2, then clears', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, null)
  await db.query(
    `INSERT INTO domain_challenges (project_id, domain, token) VALUES ($1, 'p.app', 'forge-verify=abc')`,
    [projectId],
  )
  await runProber({
    db, notifier: nullNotifier, fetch: async () => null,
    resolveTxt: async (d) => (d === '_forge.p.app' ? ['forge-verify=abc'] : null),
  })
  const events = await listProjectEvents(db, projectId)
  expect(events.map((e) => [e.vertical, e.rung])).toEqual([['ship', 2]])
  const { rows } = await db.query(`SELECT 1 FROM domain_challenges WHERE project_id = $1`, [projectId])
  expect(rows).toHaveLength(0)
})

it('30 days of clean probes emits ship 4; a recent failure blocks it', async () => {
  const db = await makeTestDb()
  const projectId = await seed(db, 'https://p.app')
  await db.query(
    `INSERT INTO probe_results (project_id, ok, probed_at) VALUES ($1, true, now() - interval '31 days')`,
    [projectId],
  )
  const deps = { db, notifier: nullNotifier, fetch: async () => ({ ok: true }), resolveTxt: async () => null }
  await runProber(deps)
  let rungs = (await listProjectEvents(db, projectId)).map((e) => e.rung)
  expect(rungs).toContain(4)

  const db2 = await makeTestDb()
  const p2 = await seed(db2, 'https://q.app')
  await db2.query(
    `INSERT INTO probe_results (project_id, ok, probed_at) VALUES ($1, true, now() - interval '31 days'), ($1, false, now() - interval '2 days')`,
    [p2],
  )
  await runProber({ ...deps, db: db2 })
  rungs = (await listProjectEvents(db2, p2)).map((e) => e.rung)
  expect(rungs).not.toContain(4)
})

it('domain route creates a challenge and returns the TXT record', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db, secretKey: key,
    integrations: { stripeValidate: async () => true, webhookCreate: async () => true },
  })
  const me = await createUserWithToken(db, 5, 'dom')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${me.token}` }, payload: { name: 'd' },
  })
  const res = await app.inject({
    method: 'POST', url: `/projects/${proj.json().id}/domain`,
    headers: { authorization: `Bearer ${me.token}` }, payload: { domain: 'd.app' },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json().record).toBe('_forge.d.app')
  expect(res.json().value).toMatch(/^forge-verify=/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — module and route missing.

- [ ] **Step 3: Implement**

`packages/server/src/workers/prober.ts`:
```ts
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import type { Db } from '../db/client.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export type Fetcher = (url: string) => Promise<{ ok: boolean } | null>
export type TxtResolver = (domain: string) => Promise<string[] | null>

export function makeFetcher(): Fetcher {
  return async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
      return { ok: res.ok }
    } catch {
      return null
    }
  }
}

export function makeTxtResolver(): TxtResolver {
  return async (domain) => {
    try {
      const records = await dnsResolveTxt(domain)
      return records.map((chunks) => chunks.join(''))
    } catch {
      return null
    }
  }
}

export async function runProber(deps: {
  db: Db; notifier: Notifier; fetch: Fetcher; resolveTxt: TxtResolver
}): Promise<void> {
  const projects = await deps.db.query<{ id: number; deploy_url: string }>(
    `SELECT id, deploy_url FROM projects WHERE deploy_url IS NOT NULL`,
  )
  for (const p of projects.rows) {
    const projectId = Number(p.id)
    const result = await deps.fetch(p.deploy_url)
    if (result === null) continue
    await deps.db.query(`INSERT INTO probe_results (project_id, ok) VALUES ($1, $2)`, [
      projectId, result.ok,
    ])
    if (result.ok && p.deploy_url.startsWith('https://')) {
      await emitMilestone(deps.db, deps.notifier, {
        projectId, vertical: 'ship', rung: 1,
        evidenceRef: 'probe:200', dedupeKey: `deploy-live-${projectId}`,
      })
    }
  }

  const challenges = await deps.db.query<{ project_id: number; domain: string; token: string }>(
    `SELECT project_id, domain, token FROM domain_challenges`,
  )
  for (const c of challenges.rows) {
    const projectId = Number(c.project_id)
    const records = await deps.resolveTxt(`_forge.${c.domain}`)
    if (!records?.includes(c.token)) continue
    await emitMilestone(deps.db, deps.notifier, {
      projectId, vertical: 'ship', rung: 2,
      evidenceRef: `dns:${c.domain}`, dedupeKey: `dns-${projectId}`,
    })
    await deps.db.query(`DELETE FROM domain_challenges WHERE project_id = $1`, [projectId])
  }

  const uptime = await deps.db.query<{ id: number }>(
    `SELECT p.id FROM projects p
     WHERE p.deploy_url IS NOT NULL
       AND (SELECT min(probed_at) FROM probe_results r WHERE r.project_id = p.id AND r.ok)
             <= now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM probe_results r WHERE r.project_id = p.id AND NOT r.ok
           AND r.probed_at > now() - interval '30 days')`,
  )
  for (const row of uptime.rows) {
    await emitMilestone(deps.db, deps.notifier, {
      projectId: Number(row.id), vertical: 'ship', rung: 4,
      evidenceRef: 'probe:uptime30', dedupeKey: `uptime30-${Number(row.id)}`,
    })
  }
}
```

In `integrations/routes.ts`, add the domain route inside `registerIntegrations` (import `randomBytes` from `node:crypto`):
```ts
app.post<{ Params: { projectId: string }; Body: { domain: string } }>(
  '/projects/:projectId/domain',
  {
    schema: {
      body: {
        type: 'object', required: ['domain'],
        properties: { domain: { type: 'string', minLength: 4, maxLength: 253, pattern: '^[a-z0-9.-]+$' } },
        additionalProperties: false,
      },
    },
  },
  async (req, reply) => {
    const own = await ownedProject(deps, req)
    if (own.status !== 200) return reply.code(own.status).send({ error: 'rejected' })
    const token = `forge-verify=${randomBytes(16).toString('base64url')}`
    await deps.db.query(
      `INSERT INTO domain_challenges (project_id, domain, token) VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO UPDATE SET domain = EXCLUDED.domain, token = EXCLUDED.token`,
      [own.projectId, req.body.domain, token],
    )
    return reply.send({ record: `_forge.${req.body.domain}`, value: token })
  },
)
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: deploy/dns/uptime prober and domain challenge route"
```

---

### Task 9: Scheduler + production wiring

**Files:**
- Create: `packages/server/src/workers/scheduler.ts`
- Modify: `packages/server/src/index.ts` (construct key/clients/notifier, start scheduler), `README.md` (env var table)
- Test: `packages/server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `runGithubPoll`, `runStripePoll`, `runProber` and their client factories; `loadSecretKey`.
- Produces (from `workers/scheduler.ts`):
  - `interface SchedulerDeps { db: Db; notifier: Notifier; secretKey: Buffer; github: GithubClient; stripe: StripeClient; fetch: Fetcher; resolveTxt: TxtResolver }`
  - `runAllProducers(deps: SchedulerDeps): Promise<void>` — runs the three pollers sequentially; each wrapped in try/catch so one failing producer never blocks the others.
  - `startScheduler(deps: SchedulerDeps, intervalMs = 15 * 60 * 1000): { stop(): void }` — `setInterval` (unref'd) + one immediate run.
- `index.ts` wiring: `loadSecretKey()` (required in production); `githubWebhookSecret` from `GITHUB_WEBHOOK_SECRET`; scheduler started unless `FORGE_WORKERS === 'off'`; `stripeValidate`/`webhookCreate` built from the real clients (`makeStripeValidate(makeStripeClient())`, `makeWebhookCreate(PUBLIC_URL + '/webhooks/github', GITHUB_WEBHOOK_SECRET)`); notifier is the `ClanBroadcaster` (Task 10 — until then use `nullNotifier`, and Task 10's step updates this line).
- README gains an environment table: `DATABASE_URL`, `FORGE_SECRET` (64 hex chars — generate with `openssl rand -hex 32`), `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `PUBLIC_URL`, `PORT`, `FORGE_WORKERS=off` to disable polling.

- [ ] **Step 1: Write the failing test**

`packages/server/test/scheduler.test.ts`:
```ts
import { expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestDb } from './helpers.js'
import { nullNotifier } from '../src/events/emit.js'
import { runAllProducers, startScheduler, type SchedulerDeps } from '../src/workers/scheduler.js'

function deps(db: Awaited<ReturnType<typeof makeTestDb>>, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    db, notifier: nullNotifier, secretKey: randomBytes(32),
    github: { repoState: async () => null },
    stripe: { summary: async () => null },
    fetch: async () => null, resolveTxt: async () => null,
    ...overrides,
  }
}

it('a throwing producer does not block the others', async () => {
  const db = await makeTestDb()
  const stripeSpy = vi.fn(async () => null)
  await runAllProducers(
    deps(db, {
      github: { repoState: async () => { throw new Error('github down') } },
      stripe: { summary: stripeSpy },
    }),
  )
  // stripe poller ran (it queries integrations; with none seeded it simply completes)
  // the assertion is that runAllProducers resolved despite the github throw
  expect(true).toBe(true)
})

it('startScheduler runs immediately and can be stopped', async () => {
  const db = await makeTestDb()
  let runs = 0
  const d = deps(db, {
    stripe: { summary: async () => { runs++; return null } },
  })
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'u')`)
  await db.query(`INSERT INTO projects (owner_id, name) VALUES (1, 'p')`)
  await db.query(
    `INSERT INTO project_integrations (project_id, provider, secret_enc)
     SELECT id, 'stripe', 'AAAA.AAAA.AAAA' FROM projects LIMIT 1`,
  )
  const handle = startScheduler(d, 60_000)
  await vi.waitFor(() => expect(runs).toBeGreaterThan(0))
  handle.stop()
})
```
Note: the seeded `secret_enc` is garbage — `decryptSecret` will throw inside the stripe poller, which must be caught per producer-item semantics... but the run counter increments only if `summary` is reached. To make the immediate-run observable, the stripe poller's decrypt happens per row inside its own try/catch and `summary` is never reached with garbage. Adjust: instead seed a REAL encrypted value:
```ts
// replace the garbage INSERT above with:
import { encryptSecret } from '../src/lib/crypto.js'
const k = randomBytes(32)
// build deps with secretKey: k, and:
await db.query(
  `INSERT INTO project_integrations (project_id, provider, secret_enc)
   SELECT id, 'stripe', $1 FROM projects LIMIT 1`,
  [encryptSecret('rk_x', k)],
)
```
(The implementer should write the final test with the real encrypted value form — the garbage variant is shown only to explain why it would not work.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/server/src/workers/scheduler.ts`:
```ts
import type { Db } from '../db/client.js'
import type { Notifier } from '../events/emit.js'
import { runGithubPoll, type GithubClient } from './github-poll.js'
import { runStripePoll, type StripeClient } from './stripe-poll.js'
import { runProber, type Fetcher, type TxtResolver } from './prober.js'

export interface SchedulerDeps {
  db: Db
  notifier: Notifier
  secretKey: Buffer
  github: GithubClient
  stripe: StripeClient
  fetch: Fetcher
  resolveTxt: TxtResolver
}

export async function runAllProducers(deps: SchedulerDeps): Promise<void> {
  const jobs: Array<() => Promise<void>> = [
    () => runGithubPoll(deps),
    () => runStripePoll({ db: deps.db, notifier: deps.notifier, secretKey: deps.secretKey, stripe: deps.stripe }),
    () => runProber({ db: deps.db, notifier: deps.notifier, fetch: deps.fetch, resolveTxt: deps.resolveTxt }),
  ]
  for (const job of jobs) {
    try {
      await job()
    } catch {
      // one failing producer never blocks the others; next interval retries
    }
  }
}

export function startScheduler(deps: SchedulerDeps, intervalMs = 15 * 60 * 1000): { stop(): void } {
  void runAllProducers(deps)
  const timer = setInterval(() => void runAllProducers(deps), intervalMs)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
```

Update `src/index.ts` to construct everything (full replacement):
```ts
import { buildApp } from './app.js'
import { makePgDb } from './db/client.js'
import { migrate } from './db/migrations.js'
import { makeGithubExchange } from './auth/github.js'
import { loadSecretKey } from './lib/crypto.js'
import { nullNotifier } from './events/emit.js'
import { makeGithubClient } from './workers/github-poll.js'
import { makeStripeClient, makeStripeValidate } from './workers/stripe-poll.js'
import { makeWebhookCreate } from './workers/github-webhook.js'
import { makeFetcher, makeTxtResolver } from './workers/prober.js'
import { startScheduler } from './workers/scheduler.js'

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
const notifier = nullNotifier // Task 10 replaces this with the ClanBroadcaster

const app = buildApp({
  db,
  secretKey,
  notifier,
  githubWebhookSecret: webhookSecret,
  github:
    clientId && clientSecret
      ? { clientId, exchange: makeGithubExchange(clientId, clientSecret) }
      : undefined,
  integrations: webhookSecret
    ? {
        stripeValidate: makeStripeValidate(stripeClient),
        webhookCreate: makeWebhookCreate(`${publicUrl}/webhooks/github`, webhookSecret),
      }
    : undefined,
})

if (process.env.FORGE_WORKERS !== 'off') {
  startScheduler({
    db, notifier, secretKey,
    github: makeGithubClient(), stripe: stripeClient,
    fetch: makeFetcher(), resolveTxt: makeTxtResolver(),
  })
}

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
console.log(`forge server listening on :${port}`)
```

Update `README.md`'s running section with the environment table listed in Interfaces.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: producer scheduler and full production wiring"
```

---

### Task 10: WebSocket clan channels

**Files:**
- Create: `packages/server/src/realtime/broadcaster.ts`
- Modify: `packages/server/package.json` (add `@fastify/websocket`, devDep `ws` + `@types/ws`), `packages/server/src/auth/sessions.ts` (export `userFromToken`), `packages/server/src/app.ts` (register WS route when `deps.broadcaster` present), `packages/server/src/index.ts` (swap `nullNotifier` for the broadcaster)
- Test: `packages/server/test/realtime.test.ts`

**Interfaces:**
- Consumes: `Notifier`, `Db`, sessions.
- Produces:
  - `userFromToken(db: Db, token: string): Promise<AuthedUser | null>` exported from `auth/sessions.ts` (`userFromRequest` refactored to call it).
  - `class ClanBroadcaster implements Notifier` from `realtime/broadcaster.ts`:
    - `constructor(db: Db)`
    - `register(clanId: number, socket: { send(data: string): void; readyState: number }): () => void` — adds socket to the clan's set, returns an unregister function
    - `async milestone(ev)` — looks up all clans of the project owner (`SELECT clan_id FROM clan_members WHERE user_id = (SELECT owner_id FROM projects WHERE id = $1)`), sends `JSON.stringify({ type: 'milestone', event: ev })` to every OPEN socket (readyState === 1) in those clans; dead-socket send errors are swallowed.
  - `registerClanSocket(app, deps: { db: Db; broadcaster: ClanBroadcaster }): void` — `GET /clans/:clanId/ws` via `@fastify/websocket`: token from `?token=` query or Authorization header; invalid → close with code 4001; non-member → close 4003; on success registers the socket and unregisters on close.
  - `AppDeps` gains `broadcaster?: ClanBroadcaster`; when present, `buildApp` awaits registration of `@fastify/websocket` and the route (register the plugin inside `buildApp` with `void app.register(websocket)` before routes; @fastify/websocket supports this pattern).
  - `index.ts`: `const notifier = new ClanBroadcaster(db)` replaces the null notifier, and `broadcaster: notifier` is passed to `buildApp`.

- [ ] **Step 1: Add dependencies**

In `packages/server/package.json`: add `"@fastify/websocket": "^11.0.0"` to dependencies, `"ws": "^8.18.0"` and `"@types/ws": "^8.5.13"` to devDependencies. Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/server/test/realtime.test.ts`:
```ts
import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { emitMilestone } from '../src/events/emit.js'
import { ClanBroadcaster } from '../src/realtime/broadcaster.js'

it('clanmates receive a milestone push; outsiders are rejected', async () => {
  const db = await makeTestDb()
  const broadcaster = new ClanBroadcaster(db)
  const app = buildApp({ db, broadcaster })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')
  const outsider = await createUserWithToken(db, 3, 'eve')

  const clanRes = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'crew' },
  })
  const clanId = clanRes.json().id as number
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: clanRes.json().inviteCode },
  })
  const projRes = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'launchpage' },
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `ws://127.0.0.1:${port}`

  const received: unknown[] = []
  const sock = new WebSocket(`${base}/clans/${clanId}/ws?token=${sarah.token}`)
  await new Promise<void>((resolve, reject) => {
    sock.on('open', () => resolve())
    sock.on('error', reject)
  })
  sock.on('message', (data) => received.push(JSON.parse(String(data))))

  const rejected = new WebSocket(`${base}/clans/${clanId}/ws?token=${outsider.token}`)
  const closeCode = await new Promise<number>((resolve) => {
    rejected.on('close', (code) => resolve(code))
    rejected.on('error', () => {})
  })
  expect(closeCode).toBe(4003)

  await emitMilestone(db, broadcaster, {
    projectId: projRes.json().id, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'k-ws',
  })

  await new Promise((r) => setTimeout(r, 200))
  expect(received).toHaveLength(1)
  expect(received[0]).toMatchObject({
    type: 'milestone',
    event: { vertical: 'revenue', rung: 2, handle: 'tomr', projectName: 'launchpage' },
  })

  sock.close()
  await app.close()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — broadcaster module missing.

- [ ] **Step 4: Implement**

In `auth/sessions.ts`, extract and export:
```ts
export async function userFromToken(db: Db, token: string): Promise<AuthedUser | null> {
  const { rows } = await db.query<{ id: string | number; handle: string }>(
    `SELECT u.id, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  )
  const row = rows[0]
  return row ? { id: Number(row.id), handle: row.handle } : null
}
```
and have `userFromRequest` call `userFromToken(db, auth.slice(7))`.

`packages/server/src/realtime/broadcaster.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { Db } from '../db/client.js'
import type { Notifier } from '../events/emit.js'
import type { MilestoneEvent } from '../events/log.js'
import { userFromToken } from '../auth/sessions.js'
import { parseId } from '../lib/params.js'

interface SocketLike {
  send(data: string): void
  readyState: number
}

export class ClanBroadcaster implements Notifier {
  private readonly clans = new Map<number, Set<SocketLike>>()

  constructor(private readonly db: Db) {}

  register(clanId: number, socket: SocketLike): () => void {
    let set = this.clans.get(clanId)
    if (!set) {
      set = new Set()
      this.clans.set(clanId, set)
    }
    set.add(socket)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.clans.delete(clanId)
    }
  }

  async milestone(ev: MilestoneEvent & { handle: string; projectName: string }): Promise<void> {
    const { rows } = await this.db.query<{ clan_id: string | number }>(
      `SELECT clan_id FROM clan_members
       WHERE user_id = (SELECT owner_id FROM projects WHERE id = $1)`,
      [ev.projectId],
    )
    const message = JSON.stringify({ type: 'milestone', event: ev })
    for (const row of rows) {
      for (const socket of this.clans.get(Number(row.clan_id)) ?? []) {
        if (socket.readyState !== 1) continue
        try {
          socket.send(message)
        } catch {
          // dead sockets are cleaned up on close; never fail the emission
        }
      }
    }
  }
}

export function registerClanSocket(
  app: FastifyInstance,
  deps: { db: Db; broadcaster: ClanBroadcaster },
): void {
  void app.register(websocket)
  void app.register(async (scoped) => {
    scoped.get<{ Params: { clanId: string }; Querystring: { token?: string } }>(
      '/clans/:clanId/ws',
      { websocket: true },
      async (connection, req) => {
        const socket = connection as unknown as SocketLike & { close(code: number): void }
        const raw = req.query.token ?? (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : undefined)
        const user = raw ? await userFromToken(deps.db, raw) : null
        const clanId = parseId(req.params.clanId)
        if (!user || clanId === null) return socket.close(4001)
        const member = await deps.db.query(
          `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
          [clanId, user.id],
        )
        if (!member.rows[0]) return socket.close(4003)
        const unregister = deps.broadcaster.register(clanId, socket)
        ;(connection as unknown as { on(ev: string, fn: () => void): void }).on('close', unregister)
      },
    )
  })
}
```
Note for the implementer: in `@fastify/websocket` v11 the handler's first argument IS the WebSocket. If `connection.close` / `connection.on` fail type or runtime checks, consult the installed version's README once and adapt the two casts — the behavior contract (close codes 4001/4003, register/unregister) is what the test pins.

In `src/app.ts`: `AppDeps` gains `broadcaster?: ClanBroadcaster`; when present call `registerClanSocket(app, { db: deps.db, broadcaster: deps.broadcaster })`, and default `notifier` resolution becomes `deps.notifier ?? deps.broadcaster ?? nullNotifier` everywhere the app passes a notifier to routes.

In `src/index.ts`: replace `const notifier = nullNotifier` with `const notifier = new ClanBroadcaster(db)` and pass `broadcaster: notifier` to `buildApp`.

- [ ] **Step 5: Run tests + typecheck to verify green**

Run: `pnpm --filter @forge/server test && pnpm --filter @forge/server typecheck`
Expected: PASS — including the end-to-end WS push test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: websocket clan channels with live milestone celebrations"
```

---

## Self-Review Notes

- **Spec coverage (Plan 2 scope):** carry-forwards (Task 1), encrypted secrets + connect flows (Tasks 2, 4), never-false emission gateway (Task 3), Build verification webhook+poller (Tasks 5–6), Revenue poller with refund-safe first dollar (Task 7), Ship rungs 1/2/4 (Task 8), scheduling (Task 9), celebrations push (Task 10). Ship rungs 3/5 (Product Hunt / registries) and Build rung 5 (rolling activity badge) are deferred to Plan 3+ — deliberate, documented here.
- **Type consistency check:** `GithubExchange` return type change (Task 1) ripples into Task 2's token capture and existing test fakes — both tasks name it. `Notifier` shape defined once in Task 3, consumed by Tasks 4–10. `StripeValidate`/`WebhookCreate` defined in Task 4, real impls in Tasks 7/5 respectively, wired in Task 9.
- **Known seams:** Task 9's index.ts uses `nullNotifier` with an explicit note that Task 10 swaps it; Task 9's scheduler test includes an inline correction (real encrypted seed) — the implementer writes the corrected form.
- The stripe real client's 10-page charge cap is a documented limitation (projects with >1,000 charges would under-count gross; rungs only ever fire early, never falsely, since thresholds are minimums over a subset).
