import type { Store } from './store.js'

export interface Project {
  id: number
  name: string
  repoFullName: string | null
  deployUrl: string | null
}

export interface Ping {
  from: string
  message: string
  at: string
}

export interface SharedMetric {
  handle: string
  projectName: string
  metric: 'mrr' | 'views' | 'social'
  value: number
  capturedAt: string
}

export interface FeedEvent {
  id: number
  projectId: number
  vertical: 'build' | 'ship' | 'revenue'
  rung: number
  evidenceRef: string
  verifiedAt: string
  handle: string
  projectName: string
}

export interface MilestoneEvent {
  id: number
  projectId: number
  vertical: 'build' | 'ship' | 'revenue'
  rung: number
  evidenceRef: string
  verifiedAt: string
}

export interface Clan {
  id: number
  name: string
  members: Array<{ handle: string; status: string }>
}

export interface CheckinStatus {
  weekStart: string
  completed: number
  total: number
}

/** Read result: live value, or last-known cached value with `staleSince` set. */
export interface Maybe<T> {
  value: T
  staleSince: string | null
}

export class ApiError extends Error {}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new ApiError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
    }
    return json as T
  }

  private async cachedGet<T>(key: string, path: string, pick: (raw: never) => T, empty: T): Promise<Maybe<T>> {
    try {
      const raw = await this.request<never>('GET', path)
      const value = pick(raw)
      this.store.setCache(key, value)
      return { value, staleSince: null }
    } catch {
      const hit = this.store.getCache<T>(key)
      return hit
        ? { value: hit.value, staleSince: hit.cachedAt }
        : { value: empty, staleSince: new Date().toISOString() }
    }
  }

  // reads (offline-safe)
  projects(): Promise<Maybe<Project[]>> {
    return this.cachedGet('projects', '/projects', (r: { projects: Project[] }) => r.projects, [])
  }

  projectEvents(projectId: number): Promise<Maybe<MilestoneEvent[]>> {
    return this.cachedGet(`events-${projectId}`, `/projects/${projectId}/events`,
      (r: { events: MilestoneEvent[] }) => r.events, [])
  }

  clansMine(): Promise<Maybe<Clan[]>> {
    return this.cachedGet('clans', '/clans/mine', (r: { clans: Clan[] }) => r.clans, [])
  }

  clanFeed(clanId: number): Promise<Maybe<FeedEvent[]>> {
    return this.cachedGet(`feed-${clanId}`, `/clans/${clanId}/feed`,
      (r: { events: FeedEvent[] }) => r.events, [])
  }

  clanPings(clanId: number): Promise<Maybe<Ping[]>> {
    return this.cachedGet(`pings-${clanId}`, `/clans/${clanId}/pings`,
      (r: { pings: Ping[] }) => r.pings, [])
  }

  presence(clanId: number): Promise<{ online: string[] }> {
    return this.request('GET', `/clans/${clanId}/presence`)
  }

  sendPing(clanId: number, to: string, message: string): Promise<unknown> {
    return this.request('POST', `/clans/${clanId}/ping`, { to, message })
  }

  clanMetrics(clanId: number): Promise<Maybe<SharedMetric[]>> {
    return this.cachedGet(`metrics-${clanId}`, `/clans/${clanId}/metrics`,
      (r: { metrics: SharedMetric[] }) => r.metrics, [])
  }

  checkinStatus(clanId: number): Promise<Maybe<CheckinStatus>> {
    return this.cachedGet(`checkin-${clanId}`, `/clans/${clanId}/checkins/status`,
      (r: CheckinStatus) => r, { weekStart: '', completed: 0, total: 0 })
  }

  // writes (throw on failure)
  createProject(name: string): Promise<{ id: number; name: string }> {
    return this.request('POST', '/projects', { name })
  }

  createClan(name: string): Promise<{ id: number; name: string; inviteCode: string }> {
    return this.request('POST', '/clans', { name })
  }

  clanInvite(clanId: number): Promise<{ name: string; inviteCode: string }> {
    return this.request('GET', `/clans/${clanId}/invite`)
  }

  joinClan(code: string): Promise<{ id: number; name: string }> {
    return this.request('POST', '/clans/join', { code })
  }

  checkin(clanId: number, fields: { shipped: string; blocked: string; next: string }): Promise<unknown> {
    return this.request('POST', `/clans/${clanId}/checkins`, fields)
  }

  connectStripe(projectId: number, apiKey: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/stripe`, { apiKey })
  }

  linkRepo(projectId: number, repoFullName: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/repo`, { repoFullName })
  }

  setDeployUrl(projectId: number, deployUrl: string): Promise<unknown> {
    return this.request('PATCH', `/projects/${projectId}`, { deployUrl })
  }

  domainChallenge(projectId: number, domain: string): Promise<{ record: string; value: string }> {
    return this.request('POST', `/projects/${projectId}/domain`, { domain })
  }

  connectPlausible(projectId: number, siteId: string, apiKey: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/plausible`, { siteId, apiKey })
  }

  connectYoutube(projectId: number, handle: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/youtube`, { handle })
  }

  setShare(projectId: number, metric: SharedMetric['metric'], enabled: boolean): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/share`, { metric, enabled })
  }
}
