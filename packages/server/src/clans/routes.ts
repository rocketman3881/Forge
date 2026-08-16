import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client.js'
import { userFromRequest } from '../auth/sessions.js'

export function registerClans(app: FastifyInstance, deps: { db: Db }): void {
  app.post<{ Body: { name: string } }>(
    '/clans',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const inviteCode = randomBytes(6).toString('base64url')
      const { rows } = await deps.db.query<{ id: string | number }>(
        `INSERT INTO clans (name, invite_code) VALUES ($1, $2) RETURNING id`,
        [req.body.name, inviteCode],
      )
      const clanId = Number(rows[0]!.id)
      await deps.db.query(`INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`, [
        clanId, user.id,
      ])
      return reply.code(201).send({ id: clanId, name: req.body.name, inviteCode })
    },
  )

  app.post<{ Body: { code: string } }>(
    '/clans/join',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 50 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const user = await userFromRequest(deps.db, req)
      if (!user) return reply.code(401).send({ error: 'unauthenticated' })
      const clan = await deps.db.query<{ id: string | number; name: string }>(
        `SELECT id, name FROM clans WHERE invite_code = $1`,
        [req.body.code],
      )
      const found = clan.rows[0]
      if (!found) return reply.code(404).send({ error: 'unknown invite code' })
      const clanId = Number(found.id)

      const member = await deps.db.query(
        `SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2`,
        [clanId, user.id],
      )
      if (member.rows[0]) return reply.send({ id: clanId, name: found.name })

      const count = await deps.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM clan_members WHERE clan_id = $1`,
        [clanId],
      )
      if (count.rows[0]!.n >= 6) return reply.code(409).send({ error: 'clan is full' })

      try {
        await deps.db.query(`INSERT INTO clan_members (clan_id, user_id) VALUES ($1, $2)`, [
          clanId, user.id,
        ])
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        const code = err instanceof Error && 'code' in err ? (err as { code?: string }).code : ''
        if (msg.includes('is full') || code === '23514') return reply.code(409).send({ error: 'clan is full' })
        throw err
      }
      return reply.send({ id: clanId, name: found.name })
    },
  )

  // Any member can re-read the invite code to share it.
  app.get<{ Params: { clanId: string } }>('/clans/:clanId/invite', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const clanId = Number(req.params.clanId)
    if (!Number.isInteger(clanId) || clanId <= 0) return reply.code(400).send({ error: 'invalid id' })
    const { rows } = await deps.db.query<{ name: string; invite_code: string }>(
      `SELECT c.name, c.invite_code FROM clans c
       JOIN clan_members m ON m.clan_id = c.id AND m.user_id = $2
       WHERE c.id = $1`,
      [clanId, user.id],
    )
    if (!rows[0]) return reply.code(403).send({ error: 'not a clan member' })
    return reply.send({ name: rows[0].name, inviteCode: rows[0].invite_code })
  })

  app.get('/clans/mine', async (req, reply) => {
    const user = await userFromRequest(deps.db, req)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    const { rows } = await deps.db.query<{
      id: string | number; name: string; handle: string; status: string
    }>(
      `SELECT c.id, c.name, u.handle, m.status
       FROM clans c
       JOIN clan_members m ON m.clan_id = c.id
       JOIN users u ON u.id = m.user_id
       WHERE c.id IN (SELECT clan_id FROM clan_members WHERE user_id = $1)
       ORDER BY c.id ASC, u.handle ASC`,
      [user.id],
    )
    const clans = new Map<number, { id: number; name: string; members: { handle: string; status: string }[] }>()
    for (const r of rows) {
      const id = Number(r.id)
      if (!clans.has(id)) clans.set(id, { id, name: r.name, members: [] })
      clans.get(id)!.members.push({ handle: r.handle, status: r.status })
    }
    return reply.send({ clans: [...clans.values()] })
  })
}
