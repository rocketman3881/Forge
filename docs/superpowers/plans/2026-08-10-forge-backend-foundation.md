# Forge Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested Fastify + Postgres backend exposing the immutable MilestoneEvent log, GitHub-OAuth login, projects, invite-link clans (max 6), and weekly check-ins — everything Plans 2 (verification workers) and 3 (CLI/TUI) build on.

**Architecture:** Monorepo (pnpm workspaces) with `packages/server`. All state flows through an append-only `milestone_events` table with two uniqueness guarantees (one event per project/vertical/rung; producer idempotency via `dedupe_key`). Routes are thin SQL wrappers; there is no ORM — a 4-line `Db` interface wraps `pg` in production and PGlite (in-memory Postgres) in tests, so every test runs against real Postgres semantics with zero setup.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm, Fastify 5, pg, @electric-sql/pglite (tests only), Vitest.

**Plan sequence:** This is Plan 1 of 3. Plan 2 (verification workers + WebSocket push) and Plan 3 (CLI/TUI + hook shim) follow after this plan is merged.

## Global Constraints

- `milestone_events` is append-only: no route or function may UPDATE or DELETE rows in it.
- Producer idempotency: appending with a previously seen `dedupe_key` — or to an already-earned (project, vertical, rung) — must be a no-op returning the existing event, never an error, never a duplicate.
- Verticals in v1 are exactly: `build`, `ship`, `revenue`.
- Clans hold 2–6 members; joining a full clan returns HTTP 409.
- No ranking anywhere: any member list is ordered alphabetically by handle.
- Session tokens are opaque random values; only their SHA-256 hash is stored.
- All packages are ESM (`"type": "module"`); TypeScript `strict: true`; relative imports use `.js` extensions (NodeNext resolution).
- Run all server tests with: `pnpm --filter @forge/server test`

## File Structure

```
forge/
  package.json                 # workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/server/
    package.json               # @forge/server
    tsconfig.json
    src/
      app.ts                   # buildApp(deps) — Fastify wiring, /health
      index.ts                 # production entry (pg + env)
      db/client.ts             # Db interface + makePgDb
      db/migrations.ts         # SCHEMA constant + migrate(db)
      events/log.ts            # appendMilestone, listProjectEvents, listClanFeed
      auth/sessions.ts         # createSession, userFromRequest
      auth/github.ts           # OAuth routes + GithubExchange type
      projects/routes.ts
      clans/routes.ts          # create/join/mine
      checkins/routes.ts       # submit + weekly status; weekStartUtc
    test/
      helpers.ts               # makeTestDb (PGlite), createUserWithToken
      app.test.ts
      migrations.test.ts
      events.test.ts
      sessions.test.ts
      github-auth.test.ts
      projects.test.ts
      clans.test.ts
      checkins.test.ts
      feed.test.ts
```

---

### Task 1: Monorepo scaffold + Fastify app with /health

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/app.ts`
- Test: `packages/server/test/app.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildApp(deps: AppDeps): FastifyInstance` from `src/app.ts`, where `interface AppDeps { db?: unknown }` (later tasks tighten `db` to the `Db` interface and add fields).

- [ ] **Step 1: Create workspace files**

`package.json` (root):
```json
{
  "name": "forge",
  "private": true,
  "scripts": { "test": "pnpm -r test" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`packages/server/package.json`:
```json
{
  "name": "@forge/server",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "dev": "tsx src/index.ts" },
  "dependencies": { "fastify": "^5.2.0", "pg": "^8.13.0" },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.15",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `pnpm install` (from repo root)
Expected: lockfile created, no errors.

- [ ] **Step 3: Write the failing test**

`packages/server/test/app.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

it('GET /health returns ok', async () => {
  const app = buildApp({})
  const res = await app.inject({ method: 'GET', url: '/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — cannot find module `../src/app.js`.

- [ ] **Step 5: Write minimal implementation**

`packages/server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'

export interface AppDeps {
  db?: unknown
}

export function buildApp(_deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  return app
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold pnpm monorepo with @forge/server and /health route"
```

---

### Task 2: Db interface, schema, migrate()

**Files:**
- Create: `packages/server/src/db/client.ts`, `packages/server/src/db/migrations.ts`, `packages/server/test/helpers.ts`
- Test: `packages/server/test/migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Db { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }` from `db/client.ts`
  - `makePgDb(connectionString: string): Db` from `db/client.ts`
  - `migrate(db: Db): Promise<void>` from `db/migrations.ts`
  - `makeTestDb(): Promise<Db>` from `test/helpers.ts` (PGlite-backed, migrated)

- [ ] **Step 1: Write the failing test**

`packages/server/test/migrations.test.ts`:
```ts
import { expect, it } from 'vitest'
import { makeTestDb } from './helpers.js'
import { migrate } from '../src/db/migrations.js'

it('migrate creates tables that accept inserts', async () => {
  const db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES ($1, $2)`, [123, 'tomr'])
  const { rows } = await db.query(`SELECT handle FROM users WHERE github_id = $1`, [123])
  expect(rows).toEqual([{ handle: 'tomr' }])
})

it('migrate is idempotent', async () => {
  const db = await makeTestDb()
  await migrate(db) // second run must not throw
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — cannot find module `./helpers.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/db/client.ts`:
```ts
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
```

`packages/server/src/db/migrations.ts`:
```ts
import type { Db } from './client.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL,
  handle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  repo_full_name TEXT,
  deploy_url TEXT,
  UNIQUE (owner_id, name)
);
CREATE TABLE IF NOT EXISTS clans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS clan_members (
  clan_id BIGINT NOT NULL REFERENCES clans(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (clan_id, user_id)
);
CREATE TABLE IF NOT EXISTS milestone_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  vertical TEXT NOT NULL,
  rung INT NOT NULL,
  evidence_ref TEXT NOT NULL,
  dedupe_key TEXT UNIQUE NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, vertical, rung)
);
CREATE TABLE IF NOT EXISTS checkins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id BIGINT NOT NULL REFERENCES clans(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  week_start DATE NOT NULL,
  shipped TEXT NOT NULL,
  blocked TEXT NOT NULL,
  next_target TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clan_id, user_id, week_start)
);
`

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt)
  }
}
```

`packages/server/test/helpers.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (3 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Db interface, full v1 schema, and idempotent migrate()"
```

---

### Task 3: The MilestoneEvent log

**Files:**
- Create: `packages/server/src/events/log.ts`
- Test: `packages/server/test/events.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2).
- Produces (from `events/log.ts`):
  - `type Vertical = 'build' | 'ship' | 'revenue'`
  - `interface MilestoneEvent { id: number; projectId: number; vertical: Vertical; rung: number; evidenceRef: string; verifiedAt: string }`
  - `appendMilestone(db: Db, input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string }): Promise<{ created: boolean; event: MilestoneEvent }>`
  - `listProjectEvents(db: Db, projectId: number): Promise<MilestoneEvent[]>`

- [ ] **Step 1: Write the failing test**

`packages/server/test/events.test.ts`:
```ts
import { expect, it, beforeEach } from 'vitest'
import type { Db } from '../src/db/client.js'
import { makeTestDb } from './helpers.js'
import { appendMilestone, listProjectEvents } from '../src/events/log.js'

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

it('appends a new milestone', async () => {
  const r = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  expect(r.created).toBe(true)
  expect(r.event.vertical).toBe('build')
  expect(r.event.rung).toBe(1)
})

it('same dedupeKey twice is a no-op returning the existing event', async () => {
  const first = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  const second = await appendMilestone(db, {
    projectId, vertical: 'build', rung: 1,
    evidenceRef: 'github:commit:abc123', dedupeKey: 'gh-push-abc123',
  })
  expect(second.created).toBe(false)
  expect(second.event.id).toBe(first.event.id)
  expect(await listProjectEvents(db, projectId)).toHaveLength(1)
})

it('an already-earned rung is a no-op even with a new dedupeKey', async () => {
  await appendMilestone(db, {
    projectId, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'stripe-ch_1',
  })
  const dup = await appendMilestone(db, {
    projectId, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_2', dedupeKey: 'stripe-ch_2',
  })
  expect(dup.created).toBe(false)
  expect(await listProjectEvents(db, projectId)).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — cannot find module `../src/events/log.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/events/log.ts`:
```ts
import type { Db } from '../db/client.js'

export type Vertical = 'build' | 'ship' | 'revenue'

export interface MilestoneEvent {
  id: number
  projectId: number
  vertical: Vertical
  rung: number
  evidenceRef: string
  verifiedAt: string
}

interface Row {
  id: string | number
  project_id: string | number
  vertical: Vertical
  rung: number
  evidence_ref: string
  verified_at: string | Date
}

function toEvent(r: Row): MilestoneEvent {
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    vertical: r.vertical,
    rung: r.rung,
    evidenceRef: r.evidence_ref,
    verifiedAt: new Date(r.verified_at).toISOString(),
  }
}

export async function appendMilestone(
  db: Db,
  input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string },
): Promise<{ created: boolean; event: MilestoneEvent }> {
  const inserted = await db.query<Row>(
    `INSERT INTO milestone_events (project_id, vertical, rung, evidence_ref, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id, project_id, vertical, rung, evidence_ref, verified_at`,
    [input.projectId, input.vertical, input.rung, input.evidenceRef, input.dedupeKey],
  )
  if (inserted.rows[0]) return { created: true, event: toEvent(inserted.rows[0]) }

  const existing = await db.query<Row>(
    `SELECT id, project_id, vertical, rung, evidence_ref, verified_at
     FROM milestone_events
     WHERE (project_id = $1 AND vertical = $2 AND rung = $3) OR dedupe_key = $4`,
    [input.projectId, input.vertical, input.rung, input.dedupeKey],
  )
  return { created: false, event: toEvent(existing.rows[0]!) }
}

export async function listProjectEvents(db: Db, projectId: number): Promise<MilestoneEvent[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, project_id, vertical, rung, evidence_ref, verified_at
     FROM milestone_events WHERE project_id = $1
     ORDER BY verified_at ASC, id ASC`,
    [projectId],
  )
  return rows.map(toEvent)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: append-only milestone event log with dual idempotency guarantees"
```

---

### Task 4: Sessions and request authentication

**Files:**
- Create: `packages/server/src/auth/sessions.ts`
- Modify: `packages/server/test/helpers.ts` (add `createUserWithToken`)
- Test: `packages/server/test/sessions.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2).
- Produces (from `auth/sessions.ts`):
  - `interface AuthedUser { id: number; handle: string }`
  - `createSession(db: Db, userId: number, ttlMs?: number): Promise<string>` — returns the raw token (default TTL 30 days)
  - `userFromRequest(db: Db, req: { headers: { authorization?: string } }): Promise<AuthedUser | null>`
- Produces (from `test/helpers.ts`): `createUserWithToken(db: Db, githubId: number, handle: string): Promise<{ userId: number; token: string }>`

- [ ] **Step 1: Write the failing test**

`packages/server/test/sessions.test.ts`:
```ts
import { expect, it } from 'vitest'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { createSession, userFromRequest } from '../src/auth/sessions.js'

it('a created session token authenticates its user', async () => {
  const db = await makeTestDb()
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const user = await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })
  expect(user).toEqual({ id: 1, handle: 'tomr' })
})

it('expired sessions do not authenticate', async () => {
  const db = await makeTestDb()
  await db.query(`INSERT INTO users (github_id, handle) VALUES (1, 'tomr')`)
  const token = await createSession(db, 1, -1000)
  expect(await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })).toBeNull()
})

it('garbage and missing tokens do not authenticate', async () => {
  const db = await makeTestDb()
  expect(await userFromRequest(db, { headers: { authorization: 'Bearer nope' } })).toBeNull()
  expect(await userFromRequest(db, { headers: {} })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — cannot find module `../src/auth/sessions.js` (and missing helper export).

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/auth/sessions.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.js'

export interface AuthedUser {
  id: number
  handle: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(db: Db, userId: number, ttlMs = 30 * 24 * 3600 * 1000): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, new Date(Date.now() + ttlMs).toISOString()],
  )
  return token
}

export async function userFromRequest(
  db: Db,
  req: { headers: { authorization?: string } },
): Promise<AuthedUser | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const { rows } = await db.query<{ id: string | number; handle: string }>(
    `SELECT u.id, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(auth.slice(7))],
  )
  const row = rows[0]
  return row ? { id: Number(row.id), handle: row.handle } : null
}
```

Append to `packages/server/test/helpers.ts`:
```ts
import { createSession } from '../src/auth/sessions.js'

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: opaque hashed session tokens and bearer authentication"
```

---

### Task 5: GitHub OAuth login routes

**Files:**
- Create: `packages/server/src/auth/github.ts`
- Modify: `packages/server/src/app.ts` (tighten `AppDeps`, register auth routes)
- Test: `packages/server/test/github-auth.test.ts`

**Interfaces:**
- Consumes: `Db`, `createSession` (Task 4).
- Produces (from `auth/github.ts`):
  - `type GithubExchange = (code: string) => Promise<{ githubId: number; handle: string }>`
  - `makeGithubExchange(clientId: string, clientSecret: string): GithubExchange` (real fetch-based impl; exercised only via the fake in tests)
  - `registerGithubAuth(app: FastifyInstance, deps: { db: Db; clientId: string; exchange: GithubExchange }): void`
- Produces (from `app.ts`): `interface AppDeps { db: Db; github?: { clientId: string; exchange: GithubExchange } }` — `buildApp` registers auth routes when `github` is present. **Note:** `db` becomes required; the Task 1 health test changes to `buildApp({ db: await makeTestDb() })`.

Flow (CLI-friendly localhost callback, like `gh` / `vercel`):
1. `GET /auth/github/start?redirect_uri=http://127.0.0.1:PORT/cb` → stores a nonce in an in-memory map, 302 to `https://github.com/login/oauth/authorize?client_id=...&state=<nonce>`.
2. `GET /auth/github/callback?code=...&state=<nonce>` → looks up nonce (400 if unknown), calls `exchange(code)`, upserts user by `github_id`, creates session, 302 to `<redirect_uri>#token=<token>` (fragment, so the token never hits the local server's logs).

- [ ] **Step 1: Write the failing test**

`packages/server/test/github-auth.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb } from './helpers.js'
import { userFromRequest } from '../src/auth/sessions.js'

async function loginFlow(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const app = buildApp({
    db,
    github: {
      clientId: 'test-client',
      exchange: async (code) => ({ githubId: 42, handle: `user-${code}` }),
    },
  })
  const start = await app.inject({
    method: 'GET',
    url: '/auth/github/start?redirect_uri=http://127.0.0.1:9999/cb',
  })
  expect(start.statusCode).toBe(302)
  const authorize = new URL(start.headers.location as string)
  expect(authorize.hostname).toBe('github.com')
  const state = authorize.searchParams.get('state')!

  const cb = await app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=abc&state=${state}`,
  })
  expect(cb.statusCode).toBe(302)
  const dest = cb.headers.location as string
  expect(dest.startsWith('http://127.0.0.1:9999/cb#token=')).toBe(true)
  return { app, token: dest.split('#token=')[1]! }
}

it('full login flow creates a user and a working session', async () => {
  const db = await makeTestDb()
  const { token } = await loginFlow(db)
  const user = await userFromRequest(db, { headers: { authorization: `Bearer ${token}` } })
  expect(user?.handle).toBe('user-abc')
})

it('logging in twice with the same github_id reuses the user', async () => {
  const db = await makeTestDb()
  await loginFlow(db)
  await loginFlow(db)
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users`)
  expect(rows[0]).toEqual({ n: 1 })
})

it('unknown state is rejected', async () => {
  const db = await makeTestDb()
  const app = buildApp({
    db,
    github: { clientId: 'x', exchange: async () => ({ githubId: 1, handle: 'h' }) },
  })
  const res = await app.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=bogus' })
  expect(res.statusCode).toBe(400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — `github` not a known property of `AppDeps` / module not found.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/auth/github.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { createSession } from './sessions.js'

export type GithubExchange = (code: string) => Promise<{ githubId: number; handle: string }>

export function makeGithubExchange(clientId: string, clientSecret: string): GithubExchange {
  return async (code) => {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    })
    const { access_token } = (await tokenRes.json()) as { access_token: string }
    const userRes = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${access_token}` },
    })
    const gh = (await userRes.json()) as { id: number; login: string }
    return { githubId: gh.id, handle: gh.login }
  }
}

export function registerGithubAuth(
  app: FastifyInstance,
  deps: { db: Db; clientId: string; exchange: GithubExchange },
): void {
  const pending = new Map<string, string>() // state -> redirect_uri

  app.get<{ Querystring: { redirect_uri: string } }>('/auth/github/start', async (req, reply) => {
    const state = randomBytes(16).toString('base64url')
    pending.set(state, req.query.redirect_uri)
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', deps.clientId)
    url.searchParams.set('state', state)
    return reply.redirect(url.toString(), 302)
  })

  app.get<{ Querystring: { code: string; state: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const redirectUri = pending.get(req.query.state)
      if (!redirectUri) return reply.code(400).send({ error: 'unknown state' })
      pending.delete(req.query.state)

      const gh = await deps.exchange(req.query.code)
      const { rows } = await deps.db.query<{ id: string | number }>(
        `INSERT INTO users (github_id, handle) VALUES ($1, $2)
         ON CONFLICT (github_id) DO UPDATE SET handle = EXCLUDED.handle
         RETURNING id`,
        [gh.githubId, gh.handle],
      )
      const token = await createSession(deps.db, Number(rows[0]!.id))
      return reply.redirect(`${redirectUri}#token=${token}`, 302)
    },
  )
}
```

Modify `packages/server/src/app.ts` to:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { registerGithubAuth, type GithubExchange } from './auth/github.js'

export interface AppDeps {
  db: Db
  github?: { clientId: string; exchange: GithubExchange }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  app.get('/health', async () => ({ ok: true }))
  if (deps.github) registerGithubAuth(app, { db: deps.db, ...deps.github })
  return app
}
```

Update `packages/server/test/app.test.ts` to satisfy the tightened `AppDeps`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb } from './helpers.js'

it('GET /health returns ok', async () => {
  const app = buildApp({ db: await makeTestDb() })
  const res = await app.inject({ method: 'GET', url: '/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: GitHub OAuth login with localhost-callback flow for the CLI"
```

---

### Task 6: Projects routes

**Files:**
- Create: `packages/server/src/projects/routes.ts`
- Modify: `packages/server/src/app.ts` (register routes)
- Test: `packages/server/test/projects.test.ts`

**Interfaces:**
- Consumes: `Db`, `userFromRequest` (Task 4).
- Produces: `registerProjects(app: FastifyInstance, deps: { db: Db }): void` with:
  - `POST /projects` body `{ name: string }` → 201 `{ id, name }` (409 on duplicate name for the same owner; 401 unauthenticated)
  - `GET /projects` → 200 `{ projects: Array<{ id: number; name: string; repoFullName: string | null; deployUrl: string | null }> }` (own projects only, alphabetical by name)

- [ ] **Step 1: Write the failing test**

`packages/server/test/projects.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'

it('creates and lists own projects only, alphabetically', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const me = await createUserWithToken(db, 1, 'tomr')
  const other = await createUserWithToken(db, 2, 'sarah')
  const auth = { authorization: `Bearer ${me.token}` }

  const created = await app.inject({
    method: 'POST', url: '/projects', headers: auth, payload: { name: 'launchpage' },
  })
  expect(created.statusCode).toBe(201)
  await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'apitool' } })
  await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${other.token}` }, payload: { name: 'coldmail' },
  })

  const list = await app.inject({ method: 'GET', url: '/projects', headers: auth })
  expect(list.statusCode).toBe(200)
  expect(list.json().projects.map((p: { name: string }) => p.name)).toEqual(['apitool', 'launchpage'])
})

it('duplicate name for the same owner is 409; no auth is 401', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const { token } = await createUserWithToken(db, 1, 'tomr')
  const auth = { authorization: `Bearer ${token}` }
  await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'x' } })
  const dup = await app.inject({ method: 'POST', url: '/projects', headers: auth, payload: { name: 'x' } })
  expect(dup.statusCode).toBe(409)
  const anon = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'y' } })
  expect(anon.statusCode).toBe(401)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — 404s (routes not registered).

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/projects/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'

export function registerProjects(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Body: { name: string } }>('/projects', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { rows } = await deps.db.query<{ id: string | number }>(
      `INSERT INTO projects (owner_id, name) VALUES ($1, $2)
       ON CONFLICT (owner_id, name) DO NOTHING RETURNING id`,
      [user.id, req.body.name],
    )
    if (!rows[0]) return reply.code(409).send({ error: 'project name already exists' })
    return reply.code(201).send({ id: Number(rows[0].id), name: req.body.name })
  })

  app.get('/projects', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { rows } = await deps.db.query<{
      id: string | number; name: string; repo_full_name: string | null; deploy_url: string | null
    }>(
      `SELECT id, name, repo_full_name, deploy_url FROM projects
       WHERE owner_id = $1 ORDER BY name ASC`,
      [user.id],
    )
    return reply.send({
      projects: rows.map((r) => ({
        id: Number(r.id), name: r.name, repoFullName: r.repo_full_name, deployUrl: r.deploy_url,
      })),
    })
  })
}
```

In `packages/server/src/app.ts`, add after the health route:
```ts
import { registerProjects } from './projects/routes.js'
// inside buildApp, after app.get('/health', ...):
registerProjects(app, { db: deps.db })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: authenticated project create/list routes"
```

---

### Task 7: Clans — create, join by invite code, 6-member cap

**Files:**
- Create: `packages/server/src/clans/routes.ts`
- Modify: `packages/server/src/app.ts` (register routes)
- Test: `packages/server/test/clans.test.ts`

**Interfaces:**
- Consumes: `Db`, `userFromRequest`.
- Produces: `registerClans(app: FastifyInstance, deps: { db: Db }): void` with:
  - `POST /clans` body `{ name: string }` → 201 `{ id, name, inviteCode }`; creator becomes first member
  - `POST /clans/join` body `{ code: string }` → 200 `{ id, name }`; 404 unknown code; 409 if the clan already has 6 members; joining a clan you're in is a 200 no-op
  - `GET /clans/mine` → 200 `{ clans: [{ id, name, members: [{ handle, status }] }] }` — members alphabetical by handle (Global Constraint: no ranking)

- [ ] **Step 1: Write the failing test**

`packages/server/test/clans.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'

it('create, join via code, and list members alphabetically', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')

  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  expect(created.statusCode).toBe(201)
  const { inviteCode } = created.json()

  const joined = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: inviteCode },
  })
  expect(joined.statusCode).toBe(200)

  const mine = await app.inject({
    method: 'GET', url: '/clans/mine', headers: { authorization: `Bearer ${tom.token}` },
  })
  expect(mine.json().clans[0].members.map((m: { handle: string }) => m.handle)).toEqual([
    'sarah', 'tomr',
  ])
})

it('unknown code is 404; the 7th member is rejected with 409; rejoin is a no-op', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const owner = await createUserWithToken(db, 1, 'owner')
  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { name: 'full' },
  })
  const { inviteCode } = created.json()

  const bad = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { code: 'nope' },
  })
  expect(bad.statusCode).toBe(404)

  for (let i = 2; i <= 6; i++) {
    const u = await createUserWithToken(db, i, `user${i}`)
    const res = await app.inject({
      method: 'POST', url: '/clans/join',
      headers: { authorization: `Bearer ${u.token}` }, payload: { code: inviteCode },
    })
    expect(res.statusCode).toBe(200)
  }
  const seventh = await createUserWithToken(db, 7, 'user7')
  const rejected = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${seventh.token}` }, payload: { code: inviteCode },
  })
  expect(rejected.statusCode).toBe(409)

  const rejoin = await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { code: inviteCode },
  })
  expect(rejoin.statusCode).toBe(200)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — 404s (routes not registered).

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/clans/routes.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'

export function registerClans(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Body: { name: string } }>('/clans', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const inviteCode = randomBytes(6).toString('base64url')
    const { rows } = await deps.db.query<{ id: string | number }>(
      `INSERT INTO clans (name, invite_code) VALUES ($1, $2) RETURNING id`,
      [req.body.name, inviteCode],
    )
    const clanId = Number(rows[0]!.id)
    await deps.db.query(`INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`, [
      clanId, user.id,
    ])
    return reply.code(201).send({ id: clanId, name: req.body.name, inviteCode })
  })

  app.post<{ Body: { code: string } }>('/clans/join', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clan = await deps.db.query<{ id: string | number; name: string }>(
      `SELECT id, name FROM clans WHERE invite_code = $1`,
      [req.body.code],
    )
    const found = clan.rows[0]
    if (!found) return reply.code(404).send({ error: 'unknown invite code' })
    const clanId = Number(found.id)

    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (member.rows[0]) return reply.send({ id: clanId, name: found.name })

    const count = await deps.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM clan_members WHERE clan_id = $1`,
      [clanId],
    )
    if (count.rows[0]!.n >= 6) return reply.code(409).send({ error: 'clan is full' })

    await deps.db.query(`INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`, [
      clanId, user.id,
    ])
    return reply.send({ id: clanId, name: found.name })
  })

  app.get('/clans/mine', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { rows } = await deps.db.query<{
      id: string | number; name: string; handle: string; status: string
    }>(
      `SELECT c.id, c.name, u.handle, m.status
       FROM clans c
       JOIN clan_members m ON m.clan_id = c.id
       JOIN users u ON u.id = m.user_id
       WHERE c.id IN (SELECT clan_id FROM clan_members WHERE user_id = $1)
       ORDER BY c.id ASC, u.handle ASC`,
      [user.id],
    )
    const clans = new Map<number, { id: number; name: string; members: { handle: string; status: string }[] }>()
    for (const r of rows) {
      const id = Number(r.id)
      if (!clans.has(id)) clans.set(id, { id, name: r.name, members: [] })
      clans.get(id)!.members.push({ handle: r.handle, status: r.status })
    }
    return reply.send({ clans: [...clans.values()] })
  })
}
```

In `packages/server/src/app.ts`, register alongside projects:
```ts
import { registerClans } from './clans/routes.js'
// inside buildApp:
registerClans(app, { db: deps.db })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (16 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: invite-link clans with 6-member cap and alphabetical member lists"
```

---

### Task 8: Weekly check-ins

**Files:**
- Create: `packages/server/src/checkins/routes.ts`
- Modify: `packages/server/src/app.ts` (register routes)
- Test: `packages/server/test/checkins.test.ts`

**Interfaces:**
- Consumes: `Db`, `userFromRequest`.
- Produces (from `checkins/routes.ts`):
  - `weekStartUtc(date: Date): string` — 'YYYY-MM-DD' of the Monday (UTC) of that date's week
  - `registerCheckins(app: FastifyInstance, deps: { db: Db }): void` with:
    - `POST /clans/:clanId/checkins` body `{ shipped: string; blocked: string; next: string }` → 201; resubmitting in the same week overwrites (upsert) and returns 200; 403 if not a member
    - `GET /clans/:clanId/checkins/status` → 200 `{ weekStart, completed, total }` where `total` counts members with status 'active' (spec: dormant members leave the denominator)

- [ ] **Step 1: Write the failing test**

`packages/server/test/checkins.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { weekStartUtc } from '../src/checkins/routes.js'

it('weekStartUtc returns the Monday of the week', () => {
  expect(weekStartUtc(new Date('2026-08-10T09:00:00Z'))).toBe('2026-08-10') // a Monday
  expect(weekStartUtc(new Date('2026-08-16T23:00:00Z'))).toBe('2026-08-10') // Sunday same week
  expect(weekStartUtc(new Date('2026-08-17T00:00:00Z'))).toBe('2026-08-17') // next Monday
})

async function setup() {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')
  const created = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  const clanId = created.json().id as number
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: created.json().inviteCode },
  })
  return { db, app, tom, sarah, clanId }
}

it('submit counts toward weekly status; resubmit overwrites, not duplicates', async () => {
  const { app, tom, clanId } = await setup()
  const auth = { authorization: `Bearer ${tom.token}` }
  const first = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth,
    payload: { shipped: 'deployed v1', blocked: 'stripe webhooks', next: 'first charge' },
  })
  expect(first.statusCode).toBe(201)
  const again = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`, headers: auth,
    payload: { shipped: 'deployed v1 + fix', blocked: 'none', next: 'first charge' },
  })
  expect(again.statusCode).toBe(200)

  const status = await app.inject({
    method: 'GET', url: `/clans/${clanId}/checkins/status`, headers: auth,
  })
  expect(status.json()).toMatchObject({ completed: 1, total: 2 })
})

it('non-members cannot check in', async () => {
  const { db, app, clanId } = await setup()
  const outsider = await createUserWithToken(db, 3, 'outsider')
  const res = await app.inject({
    method: 'POST', url: `/clans/${clanId}/checkins`,
    headers: { authorization: `Bearer ${outsider.token}` },
    payload: { shipped: 'x', blocked: 'y', next: 'z' },
  })
  expect(res.statusCode).toBe(403)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — cannot find module `../src/checkins/routes.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/server/src/checkins/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'

export function weekStartUtc(date: Date): string {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday),
  )
  return monday.toISOString().slice(0, 10)
}

export function registerCheckins(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Params: { clanId: string }; Body: { shipped: string; blocked: string; next: string } }>(
    '/clans/:clanId/checkins',
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const clanId = Number(req.params.clanId)
      const member = await deps.db.query(
        `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [clanId, user.id],
      )
      if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })

      const week = weekStartUtc(new Date())
      const { rows } = await deps.db.query<{ inserted: boolean }>(
        `INSERT INTO checkins (clan_id, user_id, week_start, shipped, blocked, next_target)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clan_id, user_id, week_start)
         DO UPDATE SET shipped = EXCLUDED.shipped, blocked = EXCLUDED.blocked,
                       next_target = EXCLUDED.next_target
         RETURNING (xmax = 0) AS inserted`,
        [clanId, user.id, week, req.body.shipped, req.body.blocked, req.body.next],
      )
      return reply.code(rows[0]!.inserted ? 201 : 200).send({ weekStart: week })
    },
  )

  app.get<{ Params: { clanId: string } }>('/clans/:clanId/checkins/status', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = Number(req.params.clanId)
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })

    const week = weekStartUtc(new Date())
    const { rows } = await deps.db.query<{ completed: number; total: number }>(
      `SELECT
         (SELECT count(DISTINCT user_id)::int FROM checkins
           WHERE clan_id = $1 AND week_start = $2) AS completed,
         (SELECT count(*)::int FROM clan_members
           WHERE clan_id = $1 AND status = 'active') AS total`,
      [clanId, week],
    )
    return reply.send({ weekStart: week, completed: rows[0]!.completed, total: rows[0]!.total })
  })
}
```

In `packages/server/src/app.ts`, register alongside the others:
```ts
import { registerCheckins } from './checkins/routes.js'
// inside buildApp:
registerCheckins(app, { db: deps.db })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (19 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: weekly check-ins with clan-level completion status"
```

---

### Task 9: Event read APIs, clan feed, and production entry

**Files:**
- Create: `packages/server/src/index.ts`, `README.md`
- Modify: `packages/server/src/events/log.ts` (add `listClanFeed`), `packages/server/src/app.ts` (add read routes)
- Test: `packages/server/test/feed.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `listClanFeed(db: Db, clanId: number, limit?: number): Promise<Array<MilestoneEvent & { handle: string; projectName: string }>>` from `events/log.ts` (newest first, default limit 50)
  - `GET /projects/:projectId/events` → 200 `{ events: MilestoneEvent[] }` (owner only; 403 otherwise)
  - `GET /clans/:clanId/feed` → 200 `{ events: Array<MilestoneEvent & { handle, projectName }> }` (members only; 403 otherwise)
  - `src/index.ts`: starts the server from env (`DATABASE_URL`, `PORT`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), running `migrate` first. Plan 2's workers plug into this entry point.

- [ ] **Step 1: Write the failing test**

`packages/server/test/feed.test.ts`:
```ts
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeTestDb, createUserWithToken } from './helpers.js'
import { appendMilestone } from '../src/events/log.js'

it('clan feed shows members events newest-first with handle and project name', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const sarah = await createUserWithToken(db, 2, 'sarah')

  const clan = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })
  await app.inject({
    method: 'POST', url: '/clans/join',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { code: clan.json().inviteCode },
  })
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${sarah.token}` }, payload: { name: 'coldmail' },
  })
  await appendMilestone(db, {
    projectId: proj.json().id, vertical: 'revenue', rung: 2,
    evidenceRef: 'stripe:charge:ch_1', dedupeKey: 'stripe-ch_1',
  })

  const feed = await app.inject({
    method: 'GET', url: `/clans/${clan.json().id}/feed`,
    headers: { authorization: `Bearer ${tom.token}` },
  })
  expect(feed.statusCode).toBe(200)
  expect(feed.json().events[0]).toMatchObject({
    vertical: 'revenue', rung: 2, handle: 'sarah', projectName: 'coldmail',
  })
})

it('project events are owner-only; feed is member-only', async () => {
  const db = await makeTestDb()
  const app = buildApp({ db })
  const tom = await createUserWithToken(db, 1, 'tomr')
  const outsider = await createUserWithToken(db, 3, 'outsider')
  const proj = await app.inject({
    method: 'POST', url: '/projects',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'launchpage' },
  })
  const clan = await app.inject({
    method: 'POST', url: '/clans',
    headers: { authorization: `Bearer ${tom.token}` }, payload: { name: 'shipcrew' },
  })

  const forbiddenEvents = await app.inject({
    method: 'GET', url: `/projects/${proj.json().id}/events`,
    headers: { authorization: `Bearer ${outsider.token}` },
  })
  expect(forbiddenEvents.statusCode).toBe(403)

  const forbiddenFeed = await app.inject({
    method: 'GET', url: `/clans/${clan.json().id}/feed`,
    headers: { authorization: `Bearer ${outsider.token}` },
  })
  expect(forbiddenFeed.statusCode).toBe(403)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @forge/server test`
Expected: FAIL — 404s (routes not registered).

- [ ] **Step 3: Write minimal implementation**

Append to `packages/server/src/events/log.ts`:
```ts
export async function listClanFeed(
  db: Db,
  clanId: number,
  limit = 50,
): Promise<Array<MilestoneEvent & { handle: string; projectName: string }>> {
  const { rows } = await db.query<Row & { handle: string; project_name: string }>(
    `SELECT e.id, e.project_id, e.vertical, e.rung, e.evidence_ref, e.verified_at,
            u.handle, p.name AS project_name
     FROM milestone_events e
     JOIN projects p ON p.id = e.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE p.owner_id IN (SELECT user_id FROM clan_members WHERE clan_id = $1)
     ORDER BY e.verified_at DESC, e.id DESC
     LIMIT $2`,
    [clanId, limit],
  )
  return rows.map((r) => ({ ...toEvent(r), handle: r.handle, projectName: r.project_name }))
}
```

In `packages/server/src/app.ts`, add the two read routes inside `buildApp` (after the existing registrations), importing `listProjectEvents`, `listClanFeed` from `./events/log.js` and `userFromRequest` from `./auth/sessions.js`:
```ts
app.get<{ Params: { projectId: string } }>('/projects/:projectId/events', async (req, reply) => {
  const user = await userFromRequest(deps.db, req)
  if (!user) return reply.code(401).send({ error: 'unauthenticated' })
  const projectId = Number(req.params.projectId)
  const owner = await deps.db.query(
    `SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2`,
    [projectId, user.id],
  )
  if (!owner.rows[0]) return reply.code(403).send({ error: 'not your project' })
  return reply.send({ events: await listProjectEvents(deps.db, projectId) })
})

app.get<{ Params: { clanId: string } }>('/clans/:clanId/feed', async (req, reply) => {
  const user = await userFromRequest(deps.db, req)
  if (!user) return reply.code(401).send({ error: 'unauthenticated' })
  const clanId = Number(req.params.clanId)
  const member = await deps.db.query(
    `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
    [clanId, user.id],
  )
  if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })
  return reply.send({ events: await listClanFeed(deps.db, clanId) })
})
```

`packages/server/src/index.ts`:
```ts
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
```

`README.md` (repo root):
```markdown
# Forge

Terminal-native founder accountability: a sidebar where your clan sees each
other's verified project progress. Spec: docs/superpowers/specs/.

## Development

Requires Node 22+ and pnpm.

    pnpm install
    pnpm test                      # all packages (tests use in-memory Postgres)

## Running the server locally

    DATABASE_URL=postgres://localhost/forge \
    GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
    pnpm --filter @forge/server dev
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @forge/server test`
Expected: PASS (21 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: project event and clan feed read APIs, production entry, README"
```

---

## Self-Review Notes

- Spec coverage for this plan's scope (backend foundation): event log with dual idempotency (Task 3), auth (Tasks 4–5), projects (Task 6), clans with cap + alphabetical ordering (Task 7), weekly check-ins with active-member denominator (Task 8), read APIs + entry point (Task 9). Verification workers, WebSocket push, celebrations, `forge how` stories, and presence are Plan 2; TUI is Plan 3.
- `xmax = 0` in Task 8 is a Postgres trick to detect insert-vs-update in an upsert; PGlite supports it (it is real Postgres compiled to WASM).
- Task 5 changes `AppDeps.db` from optional to required and updates the Task 1 test accordingly — flagged in both tasks.
