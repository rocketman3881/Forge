import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { ApiClient, FeedEvent } from './api.js'
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
    default:
      throw new Error(`unknown provider "${provider}" — use github|stripe|domain|deploy`)
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

/** `forge refresh`: warm the offline cache (used by the hook shim). */
export async function refresh(api: ApiClient): Promise<void> {
  const projects = await api.projects()
  for (const p of projects.value) await api.projectEvents(p.id)
  const clans = await api.clansMine()
  for (const c of clans.value) {
    await api.clanFeed(c.id)
    await api.checkinStatus(c.id)
  }
}
