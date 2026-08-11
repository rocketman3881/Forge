import { expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileStore } from '../src/store.js'
import { ApiClient } from '../src/api.js'

let store: FileStore
beforeEach(() => {
  store = new FileStore(mkdtempSync(join(tmpdir(), 'forge-api-')))
})

function okFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
}

const failFetch: typeof fetch = async () => {
  throw new Error('network down')
}

it('fetches live data, sends the bearer token, and caches it', async () => {
  let seenAuth = ''
  const f: typeof fetch = async (_url, init) => {
    seenAuth = String((init?.headers as Record<string, string>).authorization)
    return new Response(JSON.stringify({ projects: [{ id: 1, name: 'p' }] }), { status: 200 })
  }
  const api = new ApiClient('http://s', 'tok', store, f)
  const res = await api.projects()
  expect(res).toEqual({ value: [{ id: 1, name: 'p' }], staleSince: null })
  expect(seenAuth).toBe('Bearer tok')
})

it('serves last-known state with staleness when the network fails', async () => {
  const live = new ApiClient('http://s', 'tok', store, okFetch({ projects: [{ id: 1, name: 'p' }] }))
  await live.projects()
  const offline = new ApiClient('http://s', 'tok', store, failFetch)
  const res = await offline.projects()
  expect(res.value).toEqual([{ id: 1, name: 'p' }])
  expect(res.staleSince).not.toBeNull()
})

it('offline with no cache yields empty value, never a throw', async () => {
  const api = new ApiClient('http://s', 'tok', store, failFetch)
  const res = await api.clanFeed(3)
  expect(res.value).toEqual([])
  expect(res.staleSince).not.toBeNull()
})

it('non-2xx on writes throws with the server error body', async () => {
  const api = new ApiClient('http://s', 'tok', store,
    (async () => new Response(JSON.stringify({ error: 'clan is full' }), { status: 409 })) as typeof fetch)
  await expect(api.joinClan('abc')).rejects.toThrow('clan is full')
})
