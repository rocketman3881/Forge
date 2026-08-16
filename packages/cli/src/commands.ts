import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { ApiClient, CheckinStatus, Clan, FeedEvent, MilestoneEvent, Ping, Project, SharedMetric } from './api.js'
import type { Store } from './store.js'

export interface Io {
  log(line: string): void
  error(line: string): void
}

/** `forge init`: register/select a project, link the git repo, install the hook shim. */
export async function init(api: ApiClient, store: Store, io: Io, cwd = process.cwd()): Promise<void> {
  const name = cwd.split('/').filter(Boolean).at(-1) ?? 'project'
  const existing = (await api.projects()).value.find((p) => p.name === name)
  const project = existing ?? (await api.createProject(name))
  store.setConfig({ projectId: project.id })
  io.log(`project: ${project.name} (#${project.id})`)

  let repoFullName: string | null = null
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
    const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)
    repoFullName = m?.[1] ?? null
  } catch {
    // not a git repo or no origin — skip linking
  }
  if (repoFullName) {
    try {
      await api.linkRepo(project.id, repoFullName)
      io.log(`linked repo: ${repoFullName} (webhook installed)`)
    } catch (err) {
      io.error(`repo link failed: ${(err as Error).message}`)
    }
  } else {
    io.log('no github origin found — link later with `forge connect github`')
  }

  const hooksDir = join(cwd, '.git', 'hooks')
  if (existsSync(join(cwd, '.git'))) {
    mkdirSync(hooksDir, { recursive: true })
    const hook = join(hooksDir, 'post-commit')
    writeFileSync(hook, '#!/bin/sh\n# forge hook shim: warm the sidebar cache, never block the commit\n(forge refresh >/dev/null 2>&1 &)\n')
    chmodSync(hook, 0o755)
    io.log('installed post-commit hook shim')
  }
}

export async function connect(
  api: ApiClient, store: Store, io: Io,
  provider: string, value: string | undefined,
): Promise<void> {
  const projectId = store.getConfig().projectId
  if (!projectId) throw new Error('no project configured — run `forge init` first')
  switch (provider) {
    case 'github': {
      if (!value) throw new Error('usage: forge connect github <owner/repo>')
      await api.linkRepo(projectId, value)
      io.log(`linked repo: ${value}`)
      return
    }
    case 'stripe': {
      if (!value) throw new Error('usage: forge connect stripe <rk_live_... restricted read-only key>')
      await api.connectStripe(projectId, value)
      io.log('stripe connected — revenue rung 1 verified')
      return
    }
    case 'domain': {
      if (!value) throw new Error('usage: forge connect domain <example.com>')
      const ch = await api.domainChallenge(projectId, value)
      io.log(`add this DNS TXT record, then wait for the next verification pass (~15 min):`)
      io.log(`  ${ch.record}  TXT  "${ch.value}"`)
      return
    }
    case 'deploy': {
      if (!value) throw new Error('usage: forge connect deploy <https://your-app.example>')
      await api.setDeployUrl(projectId, value)
      io.log('deploy url saved — probed every ~15 min')
      return
    }
    case 'plausible': {
      const [siteId, apiKey] = (value ?? '').split(/\s+/)
      if (!siteId || !apiKey) throw new Error('usage: forge connect plausible <site-id> <api-key>')
      await api.connectPlausible(projectId, siteId, apiKey)
      io.log('plausible connected — website views tracked (share with `forge share views`)')
      return
    }
    case 'youtube': {
      if (!value) throw new Error('usage: forge connect youtube <@handle>')
      await api.connectYoutube(projectId, value)
      io.log('youtube connected — public channel views tracked (share with `forge share social`)')
      return
    }
    default:
      throw new Error(`unknown provider "${provider}" — use github|stripe|domain|deploy|plausible|youtube`)
  }
}

export async function clan(api: ApiClient, store: Store, io: Io, sub: string, arg?: string): Promise<void> {
  if (sub === 'create') {
    if (!arg) throw new Error('usage: forge clan create <name>')
    const c = await api.createClan(arg)
    store.setConfig({ clanId: c.id })
    io.log(`clan "${c.name}" created — invite code: ${c.inviteCode}`)
    return
  }
  if (sub === 'join') {
    if (!arg) throw new Error('usage: forge clan join <code>')
    const c = await api.joinClan(arg)
    store.setConfig({ clanId: c.id })
    io.log(`joined "${c.name}"`)
    return
  }
  throw new Error('usage: forge clan create <name> | forge clan join <code>')
}

export function formatEvidence(e: FeedEvent): string {
  const [source, ...rest] = e.evidenceRef.split(':')
  return `${e.handle} reached ${e.vertical} rung ${e.rung} on ${e.projectName}\n  verified ${e.verifiedAt} via ${source}: ${rest.join(':') || 'n/a'}`
}

/** `forge how <user> <vertical><rung>` e.g. `forge how sarah revenue2` */
export async function how(api: ApiClient, store: Store, io: Io, user: string, milestone: string): Promise<void> {
  const clanId = store.getConfig().clanId
  if (!clanId) throw new Error('no clan configured — run `forge clan join <code>` first')
  const m = /^(build|ship|revenue)\s*(\d)$/.exec(milestone)
  if (!m) throw new Error('milestone looks like: build3, ship1, revenue2')
  const feed = (await api.clanFeed(clanId)).value
  const hit = feed.find((e) => e.handle === user && e.vertical === m[1] && e.rung === Number(m[2]))
  if (!hit) {
    io.log(`no verified ${milestone} for ${user} yet`)
    return
  }
  io.log(formatEvidence(hit))
}

const PING_PRESETS: Record<string, string> = {
  work: 'get back to work 🔨',
  lazy: 'stop being lazy — ship something',
  nice: 'seen your progress, keep going 🔥',
}

/** `forge ping <user> [message...]`: nudge a clanmate, live if they're online. */
export async function ping(api: ApiClient, store: Store, io: Io, user: string, words: string[]): Promise<void> {
  const clanId = store.getConfig().clanId
  if (!clanId) throw new Error('no clan configured — run `forge clan join <code>` first')
  if (!user) throw new Error('usage: forge ping <user> [work|lazy|nice|custom message]')
  const raw = words.join(' ').trim()
  const message = PING_PRESETS[raw] ?? (raw || PING_PRESETS.work!)
  await api.sendPing(clanId, user, message)
  const online = (await api.presence(clanId)).online.includes(user)
  io.log(`ping → ${user}: "${message}" ${online ? '(delivered live ⚡)' : '(offline — lands within 24h)'}`)
}

/** `forge share <mrr|views|social> [off]`: opt in/out of clan-visible live metrics. */
export async function share(api: ApiClient, store: Store, io: Io, metric: string, toggle?: string): Promise<void> {
  const projectId = store.getConfig().projectId
  if (!projectId) throw new Error('no project configured — run `forge init` first')
  if (metric !== 'mrr' && metric !== 'views' && metric !== 'social') {
    throw new Error('usage: forge share <mrr|views|social> [off]')
  }
  const enabled = toggle !== 'off'
  await api.setShare(projectId, metric, enabled)
  io.log(enabled
    ? `${metric} is now visible to your clan (verified, refreshed ~15 min)`
    : `${metric} is now private again`)
}

/**
 * `forge status`: one-line cache-only summary for embedding in other tools
 * (e.g. Claude Code's statusLine). Never hits the network or prompts login.
 */
export function status(store: Store, io: Io): void {
  const projects = store.getCache<Project[]>('projects')?.value ?? []
  const config = store.getConfig()
  const project = projects.find((p) => p.id === config.projectId) ?? projects[0]
  if (!project) {
    io.log('⚒ forge: no cached state — run `forge refresh`')
    return
  }

  // Open-ended climb markers, not a bounded progress bar: a business is never
  // "done", so show the height reached (▲n) instead of distance-to-full.
  const dim = (s: string) => `\u001b[2m${s}\u001b[0m`
  const paint = (s: string, color: string) => `\u001b[${color}m${s}\u001b[0m`
  const V: Array<[MilestoneEvent['vertical'], string, string]> = [
    ['build', 'b', '36'],
    ['ship', 's', '35'],
    ['revenue', 'r', '32'],
  ]
  const tops = (events: MilestoneEvent[]) => {
    const top = { build: 0, ship: 0, revenue: 0 }
    for (const e of events) {
      const rung = Number.isFinite(e.rung) ? Math.max(0, Math.trunc(e.rung)) : 0 // untrusted cache
      if (rung > (top[e.vertical] ?? Infinity)) top[e.vertical] = rung
    }
    return top
  }
  const climb = (top: Record<MilestoneEvent['vertical'], number>, long = false) =>
    V.map(([v, short, color]) => {
      const label = long ? v : short
      return top[v] > 0 ? `${label} ${paint(`▲${top[v]}`, color)}` : dim(`${label} ·`)
    }).join('  ')

  const events = store.getCache<MilestoneEvent[]>(`events-${project.id}`)?.value ?? []
  const parts = [`⚒ ${project.name}`, climb(tops(events), true)]

  const clanId = config.clanId
  const clan = clanId
    ? (store.getCache<Clan[]>('clans')?.value ?? []).find((c) => c.id === clanId)
    : null
  if (clan) {
    const checkin = store.getCache<CheckinStatus>(`checkin-${clanId}`)?.value
    if (checkin && checkin.total > 0) parts.push(`clan ${checkin.completed}/${checkin.total}`)
    const feed = store.getCache<FeedEvent[]>(`feed-${clanId}`)?.value ?? []
    const byMember = new Map<string, FeedEvent[]>()
    for (const e of feed) {
      byMember.set(e.handle, [...(byMember.get(e.handle) ?? []), e])
    }
    const pings = store.getCache<Ping[]>(`pings-${clanId}`)?.value ?? []
    if (pings[0]) parts.push(paint(`✉ ${pings[0].from}: ${pings[0].message}`, '33'))
    const shared = store.getCache<SharedMetric[]>(`metrics-${clanId}`)?.value ?? []
    const fmtMetric = (s: SharedMetric): string => {
      const v = s.value
      const compact = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}m` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
      if (s.metric === 'mrr') return paint(`$${Math.round(v / 100)} mrr`, '32')
      if (s.metric === 'views') return paint(`${compact} views`, '36')
      return paint(`${compact} yt`, '35')
    }
    for (const m of clan.members.slice(0, 4)) {
      const theirs = byMember.get(m.handle)
      const mine = shared.filter((s) => s.handle === m.handle).map(fmtMetric)
      const climbPart = theirs ? climb(tops(theirs)) : dim('—')
      parts.push(`${m.handle} ${mine.length ? mine.join(' ') : climbPart}`)
    }
  }

  io.log(parts.join(dim('  │  ')))
}

/** `forge refresh`: warm the offline cache (used by the hook shim). */
export async function refresh(api: ApiClient): Promise<void> {
  const projects = await api.projects()
  for (const p of projects.value) await api.projectEvents(p.id)
  const clans = await api.clansMine()
  for (const c of clans.value) {
    await api.clanFeed(c.id)
    await api.checkinStatus(c.id)
    await api.clanMetrics(c.id)
    await api.clanPings(c.id)
  }
}
