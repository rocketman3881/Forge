# Forge CLI/TUI Implementation Plan (Plan 3 of 3)

**Goal:** Ship the `forge` terminal client: an Ink sidebar rendering verified progress, the weekly check-in form, connect flows, and the repo hook shim — completing the v1 spec (docs/superpowers/specs/2026-08-10-forge-terminal-accountability-design.md).

**Carried-in decisions:**
- Auth reuses the existing loopback flow (`/auth/github/start?redirect_uri=http://127.0.0.1:<port>/cb`); the loopback page reads the `#token` fragment client-side and relays it to the CLI. No new server endpoints.
- Session token stored in the OS keychain via macOS `security` when available; fallback `~/.forge/token` (mode 0600). No provider secrets ever touch the CLI.
- Offline: every successful fetch caches to `~/.forge/cache.json`; on network failure the sidebar renders last-known state with a staleness timestamp, never an empty pane.
- `forge how <user> <milestone>` is a projection of `/clans/:id/feed` (evidence refs) — no new server endpoint.
- Hook shim: `forge init` installs a `post-commit` hook that fire-and-forgets `forge refresh` (cache warm); verification stays 100% server-side.
- Ship rungs 3/5 and Build rung 5 remain deferred (registry lookups) — unchanged from Plan 2 close-out.

## Tasks

1. **Package scaffold + config/token/cache stores** — `packages/cli` (bin `forge`, Ink 6 + React 19, ESM, vitest). `src/store.ts`: token store (keychain/file), JSON cache with timestamps, `~/.forge/config.json` (serverUrl, projectId). Unit-tested against a temp HOME.
2. **API client with offline cache** — `src/api.ts`: typed wrappers for projects, events, clans, feed, checkins, integrations; on success write cache, on failure serve cache + `staleSince`. Unit-tested with injected fetch.
3. **Auth login flow** — `src/auth.ts`: loopback HTTP server + relay page, opens browser, resolves token, stores it. `forge login` / auto-triggered when no token. Tested with an injected opener hitting the loopback directly.
4. **Sidebar TUI** — `src/ui/Sidebar.tsx`: per-project vertical ladders (build/ship/revenue 0–5), clan check-in count ("2/4 this week"), recent feed, staleness banner, live WebSocket celebrations. Snapshot tests via ink-testing-library.
5. **Command surface** — `src/cli.ts` dispatch: `forge` (sidebar), `init` (link repo + hook shim), `connect github|stripe|domain`, `clan create|join <code>`, `checkin` (three-field Ink form), `how <user> <milestone>`, `login`, `refresh`. Integration-tested against a real in-process server (PGlite) where practical.
6. **Docs + close-out** — README usage, root workspace scripts, final full-suite run.
