import { execFileSync, execSync, spawn } from 'node:child_process'
import { openSync, readFileSync, rmSync, writeFileSync, writeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Store } from './store.js'
import type { CheckinStatus, MilestoneEvent, Project } from './api.js'

const PID_FILE = join(homedir(), '.forge', 'overlay.pid')
const ESC = '\u001b'
const SAVE = `${ESC}7`
const RESTORE = `${ESC}8`
const RESET = `${ESC}[0m`
const REDRAW_MS = 2_000

interface Line {
  text: string
  plain: number
}

const line = (text: string): Line => ({
  text,
  plain: text.replace(/\u001b\[[0-9;]*m/g, '').length,
})

function panelLines(store: Store): Line[] {
  const projects = store.getCache<Project[]>('projects')?.value ?? []
  const dim = (s: string) => `${ESC}[2m${s}${RESET}`
  const gold = (s: string) => `${ESC}[33m${s}${RESET}`
  const lines: Line[] = [line(`${gold('⚒ forge')} ${dim('· live')}`)]
  if (projects.length === 0) {
    lines.push(line(dim('no cache — forge refresh')))
    return lines
  }
  // open-ended climb, matching the sidebar: height reached, no finish line
  const bar = (raw: number, color: string) => {
    const rung = Math.max(0, Math.min(9, Math.trunc(raw)))
    return rung === 0 ? `${ESC}[2m·${RESET}` : `${ESC}[${color}m${'▲'.repeat(rung)}${rung}${RESET}`
  }
  for (const p of projects.slice(0, 3)) {
    const events = store.getCache<MilestoneEvent[]>(`events-${p.id}`)?.value ?? []
    const top = { build: 0, ship: 0, revenue: 0 }
    for (const e of events) {
      if (e.rung > top[e.vertical]) top[e.vertical] = e.rung
    }
    lines.push(line(`${gold('◍')} ${p.name}`))
    lines.push(line(`  b ${bar(top.build, '36')} s ${bar(top.ship, '35')} r ${bar(top.revenue, '32')}`))
  }
  const clanId = store.getConfig().clanId
  const checkin = clanId ? store.getCache<CheckinStatus>(`checkin-${clanId}`)?.value : null
  if (checkin && checkin.total > 0) {
    lines.push(line(dim(`check-ins ${checkin.completed}/${checkin.total} this week`)))
  }
  return lines
}

function ttySize(ttyPath: string): { rows: number; cols: number } {
  try {
    const out = execSync(`stty size < ${ttyPath}`, { encoding: 'utf8' }).trim().split(/\s+/)
    return { rows: Number(out[0]) || 24, cols: Number(out[1]) || 80 }
  } catch {
    return { rows: 24, cols: 80 }
  }
}

/** Daemon body: repaint the panel at the top-right of the given tty forever. */
export function overlayDaemon(store: Store, ttyPath: string): void {
  if (!/^\/dev\/[\w/.-]+$/.test(ttyPath)) throw new Error(`not a tty path: ${ttyPath}`)
  const fd = openSync(ttyPath, 'w')
  const draw = (): void => {
    const { cols } = ttySize(ttyPath)
    const lines = panelLines(store)
    const width = Math.min(Math.max(...lines.map((l) => l.plain)) + 2, cols)
    const col = Math.max(1, cols - width + 1)
    let out = SAVE
    lines.forEach((l, i) => {
      const pad = ' '.repeat(Math.max(0, width - l.plain))
      out += `${ESC}[${i + 1};${col}H${l.text}${pad}`
    })
    out += RESTORE
    try {
      writeSync(fd, out)
    } catch {
      process.exit(0) // tty gone: terminal closed
    }
  }
  draw()
  setInterval(draw, REDRAW_MS)
}

export function overlayStart(io: { log: (l: string) => void }): void {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8'))
    try {
      process.kill(pid, 0)
      io.log('overlay already running — `forge overlay stop` first')
      return
    } catch {
      rmSync(PID_FILE, { force: true }) // stale pid
    }
  }
  let ttyPath: string
  try {
    ttyPath = execFileSync('tty', { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
  } catch {
    throw new Error('not a terminal — run from an interactive shell')
  }
  const child = spawn(process.execPath, [process.argv[1], 'overlay', '--daemon', ttyPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  io.log(`overlay pinned top-right (pid ${child.pid}) — stop with: forge overlay stop`)
}

export function overlayStop(io: { log: (l: string) => void }): void {
  if (!existsSync(PID_FILE)) {
    io.log('overlay not running')
    return
  }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try {
    process.kill(pid)
  } catch {
    // already dead
  }
  rmSync(PID_FILE, { force: true })
  io.log('overlay stopped — it will fade as the screen redraws (or run `clear`)')
}
