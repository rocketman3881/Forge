import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'
import { parseId } from '../lib/params.js'

export function weekStartUtc(date: Date): string {
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday),
  )
  return monday.toISOString().slice(0, 10)
}

export function registerCheckins(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Params: { clanId: string }; Body: { shipped: string; blocked: string; next: string } }>(
    '/clans/:clanId/checkins',
    {
      schema: {
        body: {
          type: 'object',
          required: ['shipped', 'blocked', 'next'],
          properties: {
            shipped: { type: 'string', minLength: 1, maxLength: 2000 },
            blocked: { type: 'string', minLength: 0, maxLength: 2000 },
            next: { type: 'string', minLength: 0, maxLength: 2000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const clanId = parseId(req.params.clanId)
      if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
      const member = await deps.db.query(
        `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [clanId, user.id],
      )
      if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })

      const week = weekStartUtc(new Date())
      const { rows } = await deps.db.query<{ inserted: boolean }>(
        `INSERT INTO checkins (clan_id, user_id, week_start, shipped, blocked, next_target)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clan_id, user_id, week_start)
         DO UPDATE SET shipped = EXCLUDED.shipped, blocked = EXCLUDED.blocked,
                       next_target = EXCLUDED.next_target
         RETURNING (xmax = 0) AS inserted`,
        [clanId, user.id, week, req.body.shipped, req.body.blocked, req.body.next],
      )
      return reply.code(rows[0]!.inserted ? 201 : 200).send({ weekStart: week })
    },
  )

  app.get<{ Params: { clanId: string } }>('/clans/:clanId/checkins/status', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = parseId(req.params.clanId)
    if (clanId === null) return reply.code(400).send({ error: 'invalid id' })
    const member = await deps.db.query(
      `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
      [clanId, user.id],
    )
    if (!member.rows[0]) return reply.code(403).send({ error: 'not a clan member' })

    const week = weekStartUtc(new Date())
    const { rows } = await deps.db.query<{ completed: number; total: number }>(
      `SELECT
         (SELECT count(DISTINCT c.user_id)::int FROM checkins c
           JOIN clan_members m ON m.clan_id = c.clan_id AND m.user_id = c.user_id
             AND m.status = 'active'
           WHERE c.clan_id = $1 AND c.week_start = $2) AS completed,
         (SELECT count(*)::int FROM clan_members
           WHERE clan_id = $1 AND status = 'active') AS total`,
      [clanId, week],
    )
    return reply.send({ weekStart: week, completed: rows[0]!.completed, total: rows[0]!.total })
  })
}
