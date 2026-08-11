import type { Db } from '../db/client.js'
import { decryptSecret } from '../lib/crypto.js'
import { emitMilestone, type Notifier } from '../events/emit.js'

export interface GithubClient {
  repoState(token: string, repoFullName: string): Promise<{
    hasCommit: boolean; hasMergedPr: boolean; ciGreenOnDefault: boolean; hasRelease: boolean
  } | null>
}

export function makeGithubClient(): GithubClient {
  const api = async (token: string, path: string): Promise<unknown | null> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    return res.json()
  }
  return {
    repoState: async (token, repo) => {
      const commits = (await api(token, `/repos/${repo}/commits?per_page=1`)) as unknown[] | null
      const prs = (await api(
        token,
        `/search/issues?q=repo:${encodeURIComponent(repo)}+is:pr+is:merged&per_page=1`,
      )) as { total_count?: number } | null
      const repoMeta = (await api(token, `/repos/${repo}`)) as { default_branch?: string } | null
      const runs = repoMeta?.default_branch
        ? ((await api(
            token,
            `/repos/${repo}/actions/runs?branch=${repoMeta.default_branch}&status=success&per_page=1`,
          )) as { total_count?: number } | null)
        : null
      const releases = (await api(token, `/repos/${repo}/releases?per_page=1`)) as unknown[] | null
      if (commits === null || prs === null || repoMeta === null || releases === null) return null
      return {
        hasCommit: commits.length > 0,
        hasMergedPr: (prs.total_count ?? 0) > 0,
        ciGreenOnDefault: (runs?.total_count ?? 0) > 0,
        hasRelease: releases.length > 0,
      }
    },
  }
}

export async function runGithubPoll(deps: {
  db: Db; notifier: Notifier; secretKey: Buffer; github: GithubClient
}): Promise<void> {
  const { rows } = await deps.db.query<{ id: number; repo_full_name: string; secret_enc: string }>(
    `SELECT p.id, p.repo_full_name, ui.secret_enc
     FROM projects p
     JOIN user_integrations ui ON ui.user_id = p.owner_id AND ui.provider = 'github'
     WHERE p.repo_full_name IS NOT NULL`,
  )
  for (const row of rows) {
    let state: Awaited<ReturnType<GithubClient['repoState']>>
    try {
      state = await deps.github.repoState(decryptSecret(row.secret_enc, deps.secretKey), row.repo_full_name)
    } catch {
      continue
    }
    if (!state) continue
    const projectId = Number(row.id)
    const rungs: Array<[boolean, number, string]> = [
      [state.hasCommit, 1, 'hasCommit'],
      [state.hasMergedPr, 2, 'hasMergedPr'],
      [state.ciGreenOnDefault, 3, 'ciGreenOnDefault'],
      [state.hasRelease, 4, 'hasRelease'],
    ]
    for (const [flag, rung, name] of rungs) {
      if (!flag) continue
      await emitMilestone(deps.db, deps.notifier, {
        projectId, vertical: 'build', rung,
        evidenceRef: `github:poll:${name}`, dedupeKey: `gh-poll-${projectId}-b${rung}`,
      })
    }
  }
}
