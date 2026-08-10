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
     WHERE (project_id = $1 AND vertical = $2 AND rung = $3) OR dedupe_key = $4`,
    [input.projectId, input.vertical, input.rung, input.dedupeKey],
  )
  return { created: false, event: toEvent(existing.rows[0]!) }
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
