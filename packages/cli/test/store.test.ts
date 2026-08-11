import { expect, it, beforeEach } from 'vitest'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/store.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-test-'))
})

it('round-trips the session token with owner-only permissions', async () => {
  const store = new FileStore(home)
  expect(await store.getToken()).toBeNull()
  await store.setToken('tok_abc')
  expect(await store.getToken()).toBe('tok_abc')
  const mode = statSync(join(home, '.forge', 'token')).mode & 0o777
  expect(mode).toBe(0o600)
})

it('round-trips config and merges partial updates', async () => {
  const store = new FileStore(home)
  expect(store.getConfig()).toEqual({})
  store.setConfig({ serverUrl: 'http://x' })
  store.setConfig({ projectId: 7 })
  expect(store.getConfig()).toEqual({ serverUrl: 'http://x', projectId: 7 })
})

it('caches values with a timestamp and survives corrupt files', async () => {
  const store = new FileStore(home)
  expect(store.getCache('projects')).toBeNull()
  store.setCache('projects', [{ id: 1 }])
  const hit = store.getCache('projects')!
  expect(hit.value).toEqual([{ id: 1 }])
  expect(Date.now() - new Date(hit.cachedAt).getTime()).toBeLessThan(5000)
})
