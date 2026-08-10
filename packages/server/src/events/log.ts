import type { Db } from '../db/client.js'

export type Vertical = 'build' | 'ship' | 'revenue'

export interface MilestoneEvent {
  id: number
  projectId: number
  vertical: Vertical
  rung: number
  evidenceRef: string
  verifiedAt: string
}

interface Row {
  id: string | number
  project_id: string | number
  vertical: Vertical
  rung: number
  evidence_ref: string
  verified_at: string | Date
}

function toEvent(r: Row): MilestoneEvent {
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    vertical: r.vertical,
    rung: r.rung,
    evidenceRef: r.evidence_ref,
    verifiedAt: new Date(r.verified_at).toISOString(),
  }
}

export async function appendMilestone(
  db: Db,
  input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string },
): Promise<{ created: boolean; event: MilestoneEvent }> {
  const inserted = await db.query<Row>(
    `INSERT INTO milestone_events (project_id, vertical, rung, evidence_ref, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id, project_id, vertical, rung, evidence_ref, verified_at`,
    [input.projectId, input.vertical, input.rung, input.evidenceRef, input.dedupeKey],
  )
  if (inserted.rows[0]) return { created: true, event: toEvent(inserted.rows[0]) }

  const existing = await db.query<Row>(
    `SELECT id, project_id, vertical, rung, evidence_ref, verified_at
     FROM milestone_events
     WHERE (project_id = $1 AND vertical = $2 AND rung = $3) OR dedupe_key = $4
     ORDER BY (project_id = $1 AND vertical = $2 AND rung = $3) DESC
     LIMIT 1`,
    [input.projectId, input.vertical, input.rung, input.dedupeKey],
  )
  const row = existing.rows[0]
  if (!row) {
    throw new Error(
      `appendMilestone: insert conflicted but no existing event found (project ${input.projectId}, ${input.vertical}.${input.rung}, dedupe ${input.dedupeKey})`,
    )
  }
  return { created: false, event: toEvent(row) }
}

export async function listProjectEvents(db: Db, projectId: number): Promise<MilestoneEvent[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, project_id, vertical, rung, evidence_ref, verified_at
     FROM milestone_events WHERE project_id = $1
     ORDER BY verified_at ASC, id ASC`,
    [projectId],
  )
  return rows.map(toEvent)
}

export async function listClanFeed(
  db: Db,
  clanId: number,
  limit = 50,
): Promise<Array<MilestoneEvent & { handle: string; projectName: string }>> {
  const { rows } = await db.query<Row & { handle: string; project_name: string }>(
    `SELECT e.id, e.project_id, e.vertical, e.rung, e.evidence_ref, e.verified_at,
            u.handle, p.name AS project_name
     FROM milestone_events e
     JOIN projects p ON p.id = e.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE p.owner_id IN (SELECT user_id FROM clan_members WHERE clan_id = $1)
     ORDER BY e.verified_at DESC, e.id DESC
     LIMIT $2`,
    [clanId, limit],
  )
  return rows.map((r) => ({ ...toEvent(r), handle: r.handle, projectName: r.project_name }))
}
