import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)

export interface ForgeConfig {
  serverUrl?: string
  projectId?: number
  clanId?: number
  /** invite code captured by the installer; consumed on first login */
  pendingJoin?: string
}

export interface CacheHit<T> {
  value: T
  cachedAt: string
}

export interface Store {
  getToken(): Promise<string | null>
  setToken(token: string): Promise<void>
  getConfig(): ForgeConfig
  setConfig(partial: ForgeConfig): void
  getCache<T>(key: string): CacheHit<T> | null
  setCache<T>(key: string, value: T): void
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export class FileStore implements Store {
  private readonly dir: string

  constructor(home = homedir()) {
    this.dir = join(home, '.forge')
  }

  async getToken(): Promise<string | null> {
    try {
      return readFileSync(join(this.dir, 'token'), 'utf8').trim() || null
    } catch {
      return null
    }
  }

  async setToken(token: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, 'token')
    writeFileSync(path, token, { mode: 0o600 })
    chmodSync(path, 0o600)
  }

  getConfig(): ForgeConfig {
    return readJson(join(this.dir, 'config.json')) as ForgeConfig
  }

  setConfig(partial: ForgeConfig): void {
    mkdirSync(this.dir, { recursive: true })
    const merged = { ...this.getConfig(), ...partial }
    writeFileSync(join(this.dir, 'config.json'), JSON.stringify(merged, null, 2))
  }

  getCache<T>(key: string): CacheHit<T> | null {
    const all = readJson(join(this.dir, 'cache.json'))
    const hit = all[key] as CacheHit<T> | undefined
    return hit && typeof hit.cachedAt === 'string' ? hit : null
  }

  setCache<T>(key: string, value: T): void {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, 'cache.json')
    const all = readJson(path)
    all[key] = { value, cachedAt: new Date().toISOString() }
    writeFileSync(path, JSON.stringify(all))
  }
}

/** macOS keychain-backed token store; falls back to FileStore elsewhere or on error. */
export class KeychainStore extends FileStore {
  override async getToken(): Promise<string | null> {
    if (process.platform !== 'darwin') return super.getToken()
    try {
      const { stdout } = await exec('security', [
        'find-generic-password', '-s', 'forge-cli', '-w',
      ])
      return stdout.trim() || null
    } catch {
      return super.getToken()
    }
  }

  override async setToken(token: string): Promise<void> {
    if (process.platform !== 'darwin') return super.setToken(token)
    try {
      await exec('security', [
        'add-generic-password', '-s', 'forge-cli', '-a', 'forge', '-w', token, '-U',
      ])
    } catch {
      await super.setToken(token)
    }
  }
}
