# Forge — Terminal-Native Founder Accountability — Design Spec

**Date:** 2026-08-10
**Status:** Approved pending user review
**Working title:** Forge (rename anytime)

## One-liner

`npx forge` opens a terminal sidebar where a small clan of friends sees each other's *verified* project progress — build, ship, revenue — and holds a weekly accountability ritual. Progress is visible by default; code only ever by consent.

## Who it's for

Vibe-coder graduates: people who built something with Claude Code, Cursor, Lovable, or Bolt and are stuck between "it runs on localhost" and "it makes money." v1 targets the CLI-comfortable slice (Claude Code / Cursor users). Pure web-builders are a later expansion via the read-only web share page.

## Why this shape (research, distilled)

Deep research (Aug 2026) into predecessors (WIP.co, Makerlog, Pioneer, Buildspace, Product Hunt Maker Goals) and behavioral evidence produced these binding design rules:

1. **Verified events only drive progression.** Self-reported anything is cosmetic at most. Honor systems in this niche are dead on arrival (fake Stripe screenshots are an industry).
2. **Milestones, never streaks.** Startup work is not a daily atomic action. Streaks caused faked "ships" and quit-on-break on WIP. Progress can pause for weeks with zero penalty; personal-best framing only.
3. **Small known groups, weekly cadence.** Recurring progress reports to a known group is the best-evidenced accountability mechanic (Matthews: >70% goal achievement vs 35% solo). Clans cap at 6.
4. **No public leaderboards, no cross-stranger competition.** Pioneer (the closest funded precedent) was gamed and shut down. Clan rows sort alphabetically, never by progress.
5. **Completed actions, not announcements.** Public identity announcements reduce follow-through (Gollwitzer 2009). The feed's content is verified events by construction; there is no way to post a plan.
6. **Single-player value first.** Clan features need friends; the progress tracker must be useful alone (cold-start lesson from every dead predecessor).
7. **Activity is ambient, never progression.** Hours-with-Claude, commit counts, follower counts: visible as flavor, worth zero levels (Goodhart/progress-theater rule).

## The product

### Core loop (single-player)

1. **Connect** — OAuth real tools once (GitHub, deploy URL/domain, Stripe in v1). Onboarding *is* the verification system.
2. **Build elsewhere** — Forge is not where work happens; it's where progress becomes visible. No tasks, no to-dos.
3. **Milestone fires** — the backend detects a verified event; the vertical levels up. Users never self-report anything that affects levels.
4. **Sidebar reflects it** — bars advance; the event prints in every clanmate's terminal within seconds.
5. **Next rung shown** — each vertical always displays the single next milestone and a short "how founders typically get there" note.

### The sidebar (v1 UI)

```
┌─ forge ─ tomr/launchpage ────────────────────────────────┐
│  BUILD    ▰▰▰▰▱  ci green · v0.3 tagged                  │
│  SHIP     ▰▰▰▱▱  live on custom domain · 12d uptime      │
│  REVENUE  ▰▱▱▱▱  stripe connected — next: first $        │
├─ clan: shipcrew ─────────────────────────────────────────┤
│  ● sarah    coldmail   B▰▰▰▰ S▰▰▰▰ R▰▰   ⚡ now          │
│  ● dev      fitstack   B▰▰▰ S▰▰▰▰▰ R▰    2h ago          │
│  ○ marcus   tabkeeper  B▰▰ S▰ R▰         6d ago          │
│  ▸ sarah hit REVENUE 2 — first dollar 🎉  (yesterday)    │
│      forge how sarah revenue.2                           │
├─ check-in: 2/4 this week ────────────────────────────────┤
└──────────────────────────────────────────────────────────┘
```

### v1 verticals and rungs

Every rung states its verification source. Rungs are permanent dated **events** ("First charge — Mar 3"), never live numbers. Live numbers (MRR, traffic) are owner-private unless explicitly shared.

**Build** (GitHub OAuth)
| Rung | Milestone | Verification |
|---|---|---|
| 1 | Repo connected, first commit | GitHub OAuth |
| 2 | First merged PR | GitHub OAuth |
| 3 | CI passing on default branch | GitHub OAuth |
| 4 | First tagged release | GitHub OAuth |
| 5 | Sustained build health: activity in 4 of last 6 weeks (rolling badge, not a streak) | GitHub OAuth |

**Ship** (platform probes)
| Rung | Milestone | Verification |
|---|---|---|
| 1 | Deployed URL returns 200 with SSL | Platform probe |
| 2 | Custom domain verified | DNS TXT challenge |
| 3 | Publicly launched (Product Hunt / Show HN / store listing) | API / registry lookup |
| 4 | 30 days of uptime | Platform probe |
| 5 | Second surface shipped (app store / extension / package registry) | Registry lookup |

**Revenue** (Stripe OAuth; LemonSqueezy/Paddle/Polar later)
| Rung | Milestone | Verification |
|---|---|---|
| 1 | Payments connected, checkout live | Stripe OAuth |
| 2 | **First dollar** — first successful charge (flagship moment) | Stripe OAuth |
| 3 | First 10 customers | Stripe OAuth |
| 4 | $100 total revenue | Stripe OAuth |
| 5 | $1k total / first $100 MRR | Stripe OAuth |

Anti-gaming specifics: commits gate only Build rung 1 (they are trivially fakeable; PRs/CI/releases gate the rest). A refunded first charge un-fires nothing retroactively but the worker must not fire on charges refunded before verification runs.

### Clans & the social loop (v1)

- **Formation:** invite link only, 2–6 members. (Stranger matchmaking is deferred; the design for it — stage/timezone cohorts with ghost-decay and re-matching — lives in Deferred.)
- **Weekly check-in:** a three-field TUI form — *what shipped* (auto-prefilled from verified events), *what's blocking me*, *next week's target*. Completion displays clan-wide ("2/4 this week"), never as individual streaks.
- **Milestone celebrations:** a clanmate's verified event prints in your terminal within seconds via WebSocket push.
- **`forge how <user> <vertical>.<rung>`:** requests the story behind a milestone; the owner's reply is saved as that milestone's permanent story, shareable within the clan.
- **Presence:** `⚡ now` dot driven by optional Claude Code SessionStart/SessionEnd hooks (or git activity), installed by `forge init`. Ambient only; zero progression weight.
- **Ordering:** clan rows sort alphabetically. No ranking anywhere.

## Architecture

Three components, one contract.

### 1. `forge` CLI/TUI
- Node + TypeScript + Ink (React for terminals). Distribution: `npx forge`, later `npm i -g forge` / Homebrew.
- Renders state from the backend; runs the check-in form; opens the browser for OAuth flows (device-code style: CLI displays URL + code, polls for completion).
- Holds no provider secrets — only its own session token, stored in the OS keychain.
- Commands (v1): `forge` (sidebar), `forge init` (link repo + install hook shim), `forge connect <github|stripe|domain>`, `forge clan create|join <link>`, `forge checkin`, `forge how <user> <milestone>`.

### 2. Backend
- TypeScript (Fastify) + Postgres + one WebSocket channel per clan.
- Owns OAuth tokens, encrypted at rest; scopes are read-only minimum (GitHub read, Stripe read-only key via OAuth).
- **Verification workers** — the only nontrivial logic:
  - GitHub: webhook receiver (push, PR merged, release, workflow run) with a reconciliation poller as backstop.
  - Stripe: poller (~15 min) over charges/customers.
  - Deploy prober: cron (~15 min) HTTP + TLS check; DNS TXT verifier; launch/registry lookups (Product Hunt API, app/package registries) for Ship rungs 3 and 5.
- Workers emit exactly one artifact: an immutable **MilestoneEvent** `(project_id, vertical, rung, evidence_ref, verified_at)`, append-only, idempotent (the same Stripe charge seen twice must never fire two events). Bars, feed, celebrations, and stories are all projections of this log. Every deferred feature is a new producer or consumer of it.

### 3. Hook shim
- One-line SessionStart/SessionEnd hook POSTing presence heartbeats. Optional; absence degrades presence to "last verified event" timestamps.

### Error handling that matters
- **Never emit a false milestone.** On ambiguous API responses, workers skip and retry — never guess. A wrong "first dollar" celebration is the worst possible bug.
- Token revocation ⇒ integration shows "disconnected" in the sidebar; progress freezes visibly, never silently.
- Offline/unreachable backend ⇒ TUI shows last-known state with a staleness timestamp, never an empty pane.

### Testing
- Verification workers: recorded-fixture tests per provider using real API payloads, including edge cases — force-pushes, refunded first charges, CI flapping, webhook replays.
- Event log: property tests — append-only, producer idempotency.
- TUI: snapshot tests via ink-testing-library.

## Deferred (the rest of the map — layers onto the event log without rework)

- **Verticals:** Idea (3 shallow rungs, clan-attested via `forge attest`, zero rank weight) and Audience (analytics OAuth chain: first visitor → 100 visitors → first signup → organic-channel proof; follower/view counts from YouTube/TikTok/Bluesky/Threads as verified-but-cosmetic stats — never rung gates; Meta/Google Ads OAuth for verified spend + conversion milestones).
- **Integrations:** Plausible/GA4/PostHog, ESP (email list), Search Console, LemonSqueezy/Paddle/Polar, Meta/Google Ads. X/Twitter deferred for API cost; LinkedIn excluded (closed API).
- **Higher Revenue rungs:** $1k MRR (Stripe OAuth) and first profitable month (Stripe + self-declared costs, marked as such).
- **Clan chat:** one small room per clan, group-text register. Milestone events auto-post; replies thread onto the event and become its `forge how` story; muted during active coding sessions except milestones/@mentions. Explicitly not a community platform — no channels, no discovery.
- **`forge peek <user>`:** consent-based, time-boxed (48h) read access via GitHub invite; logged and revocable.
- **Matchmaking:** stage/timezone cohorts of 4–6 for users without builder friends; ghost-decay (3 weeks silent → private nudge → dormant ○, excluded from check-in denominator; clans under 3 active get merge/re-match offers; return by showing up, no shame mechanics).
- **Web share page:** read-only verified milestone timeline per project — the shareable credential and the on-ramp for non-terminal users.
- **Monetization:** free for now (user decision). When revisited: CLI stays free; paid tier on server-side value (multi-project, long history, org/accelerator features, commitment stakes). Social layer never paywalled (WIP's lesson). Long-term B2B option: accountability infrastructure for accelerators/AI-tool-vendor communities.

## Risks (accepted, monitored)

1. **Market ceiling:** every predecessor capped at lifestyle scale (WIP ~$2K MRR peak). Accepted — v1 is free and cheap to run; the bet is the AI-builder wave changed the population size.
2. **Retention past week 4:** gamification novelty decays ~4 weeks. The mitigations *are* the design (verified milestones + weekly ritual + celebrations where you work). Measure: % of clans still checking in at week 6.
3. **Platform absorption:** Lovable/Replit/Cursor could build this. Terminal-native + cross-tool neutrality is the differentiation; speed is the defense.
4. **Verification fragility:** provider API changes break workers. Mitigated by fixture tests and visible-freeze error handling.

## Success criteria (v1)

- One real clan (the founder's) uses it for 6 consecutive weeks: ≥75% weekly check-in completion, zero false milestone events, at least one organic "how did you do it" exchange.
- `npx forge` → connected GitHub → first verified event in under 10 minutes for a new user.
