import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.js'

export interface AuthedUser {
  id: number
  handle: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(db: Db, userId: number, ttlMs = 30 * 24 * 3600 * 1000): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, new Date(Date.now() + ttlMs).toISOString()],
  )
  return token
}

export async function userFromToken(db: Db, token: string): Promise<AuthedUser | null> {
  const { rows } = await db.query<{ id: string | number; handle: string }>(
    `SELECT u.id, u.handle FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  )
  const row = rows[0]
  return row ? { id: Number(row.id), handle: row.handle } : null
}

export async function userFromRequest(
  db: Db,
  req: { headers: { authorization?: string } },
): Promise<AuthedUser | null> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  return userFromToken(db, auth.slice(7))
}
