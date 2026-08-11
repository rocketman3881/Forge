import type { Db } from '../db/client.js'
import { appendMilestone, type MilestoneEvent, type Vertical } from './log.js'

export interface Notifier {
  milestone(event: MilestoneEvent & { handle: string; projectName: string }): Promise<void>
}

export const nullNotifier: Notifier = { milestone: async () => {} }

export async function emitMilestone(
  db: Db,
  notifier: Notifier,
  input: { projectId: number; vertical: Vertical; rung: number; evidenceRef: string; dedupeKey: string },
): Promise<{ created: boolean; event: MilestoneEvent }> {
  const res = await appendMilestone(db, input)
  if (res.created) {
    const { rows } = await db.query<{ handle: string; name: string }>(
      `SELECT u.handle, p.name FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = $1`,
      [input.projectId],
    )
    const row = rows[0]
    if (row) {
      try {
        await notifier.milestone({ ...res.event, handle: row.handle, projectName: row.name })
      } catch {
        // notification failures never fail an emission
      }
    }
  }
  return res
}
