import { expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/store.js'
import type { ApiClient, FeedEvent } from '../src/api.js'
import { init, connect, clan, how, formatEvidence } from '../src/commands.js'

let store: FileStore
let lines: string[]
const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) }

beforeEach(() => {
  store = new FileStore(mkdtempSync(join(tmpdir(), 'forge-cmd-')))
  lines = []
})

const feedEvent: FeedEvent = {
  id: 1, projectId: 1, vertical: 'revenue', rung: 2, evidenceRef: 'stripe:charge:ch_1',
  verifiedAt: '2026-08-11T00:00:00Z', handle: 'sarah', projectName: 'shop',
}

function stubApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    projects: async () => ({ value: [], staleSince: null }),
    createProject: async (name: string) => ({ id: 42, name }),
    linkRepo: async () => ({}),
    connectStripe: async () => ({}),
    setDeployUrl: async () => ({}),
    domainChallenge: async () => ({ record: '_forge.d.app', value: 'forge-verify=x' }),
    createClan: async (name: string) => ({ id: 7, name, inviteCode: 'inv123' }),
    joinClan: async () => ({ id: 7, name: 'crew' }),
    clanFeed: async () => ({ value: [feedEvent], staleSince: null }),
    ...overrides,
  } as unknown as ApiClient
}

it('init registers the project, links the origin repo, and installs the hook shim', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-repo-'))
  execFileSync('git', ['-C', repo, 'init', '-q'])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:tom/launchpage.git'])
  await init(stubApi(), store, io, repo)
  expect(store.getConfig().projectId).toBe(42)
  expect(lines.join('\n')).toContain('linked repo: tom/launchpage')
  const hook = join(repo, '.git', 'hooks', 'post-commit')
  expect(readFileSync(hook, 'utf8')).toContain('forge refresh')
  expect(statSync(hook).mode & 0o111).toBeTruthy()
})

it('connect requires init first and rejects unknown providers', async () => {
  await expect(connect(stubApi(), store, io, 'stripe', 'rk_x')).rejects.toThrow('forge init')
  store.setConfig({ projectId: 1 })
  await expect(connect(stubApi(), store, io, 'tiktok', 'x')).rejects.toThrow('unknown provider')
  await connect(stubApi(), store, io, 'domain', 'd.app')
  expect(lines.join('\n')).toContain('_forge.d.app  TXT  "forge-verify=x"')
})

it('clan create stores the clan id and prints the invite code', async () => {
  await clan(stubApi(), store, io, 'create', 'crew')
  expect(store.getConfig().clanId).toBe(7)
  expect(lines.join('\n')).toContain('inv123')
})

it('how finds the verified milestone evidence in the clan feed', async () => {
  store.setConfig({ clanId: 7 })
  await how(stubApi(), store, io, 'sarah', 'revenue2')
  expect(lines.join('\n')).toContain('via stripe: charge:ch_1')
  await how(stubApi(), store, io, 'sarah', 'ship1')
  expect(lines.join('\n')).toContain('no verified ship1 for sarah yet')
})

it('formatEvidence shows source and reference', () => {
  expect(formatEvidence(feedEvent)).toContain('sarah reached revenue rung 2 on shop')
})
