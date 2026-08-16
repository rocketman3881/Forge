import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { Db } from '../db/client.js'
import type { Notifier } from '../events/emit.js'
import type { MilestoneEvent } from '../events/log.js'
import { userFromToken } from '../auth/sessions.js'
import { parseId } from '../lib/params.js'

interface SocketLike {
  send(data: string): void
  readyState: number
}

export class ClanBroadcaster implements Notifier {
  private readonly clans = new Map<number, Map<SocketLike, string>>()

  constructor(private readonly db: Db) {}

  register(clanId: number, socket: SocketLike, handle = ''): () => void {
    let set = this.clans.get(clanId)
    if (!set) {
      set = new Map()
      this.clans.set(clanId, set)
    }
    set.set(socket, handle)
    this.broadcastPresence(clanId)
    return () => {
      set.delete(socket)
      if (set.size === 0) this.clans.delete(clanId)
      this.broadcastPresence(clanId)
    }
  }

  online(clanId: number): string[] {
    return [...new Set([...(this.clans.get(clanId)?.values() ?? [])].filter(Boolean))].sort()
  }

  private send(clanId: number, message: string): void {
    for (const socket of this.clans.get(clanId)?.keys() ?? []) {
      if (socket.readyState !== 1) continue
      try {
        socket.send(message)
      } catch {
        // dead sockets are cleaned up on close; never fail the emission
      }
    }
  }

  private broadcastPresence(clanId: number): void {
    this.send(clanId, JSON.stringify({ type: 'presence', online: this.online(clanId) }))
  }

  ping(clanId: number, from: string, to: string, message: string): void {
    this.send(clanId, JSON.stringify({ type: 'ping', from, to, message }))
  }

  async milestone(ev: MilestoneEvent & { handle: string; projectName: string }): Promise<void> {
    const { rows } = await this.db.query<{ clan_id: string | number }>(
      `SELECT clan_id FROM clan_members
       WHERE user_id = (SELECT owner_id FROM projects WHERE id = $1)`,
      [ev.projectId],
    )
    const message = JSON.stringify({ type: 'milestone', event: ev })
    for (const row of rows) {
      this.send(Number(row.clan_id), message)
    }
  }
}

export function registerClanSocket(
  app: FastifyInstance,
  deps: { db: Db; broadcaster: ClanBroadcaster },
): void {
  void app.register(websocket)
  void app.register(async (scoped) => {
    scoped.get<{ Params: { clanId: string }; Querystring: { token?: string } }>(
      '/clans/:clanId/ws',
      { websocket: true },
      async (connection, req) => {
        const socket = connection as unknown as SocketLike & { close(code: number): void }
        const raw = req.query.token ?? (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : undefined)
        const user = raw ? await userFromToken(deps.db, raw) : null
        const clanId = parseId(req.params.clanId)
        if (!user || clanId === null) return socket.close(4001)
        const member = await deps.db.query(
          `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
          [clanId, user.id],
        )
        if (!member.rows[0]) return socket.close(4003)
        const unregister = deps.broadcaster.register(clanId, socket, user.handle)
        ;(connection as unknown as { on(ev: string, fn: () => void): void }).on('close', unregister)
      },
    )
  })
}
