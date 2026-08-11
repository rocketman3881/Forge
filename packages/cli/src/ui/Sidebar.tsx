import React from 'react'
import { Box, Text } from 'ink'
import type { Clan, CheckinStatus, FeedEvent, MilestoneEvent, Project } from '../api.js'

const VERTICALS = ['build', 'ship', 'revenue'] as const
const MAX_RUNG = 5

const COLORS: Record<(typeof VERTICALS)[number], string> = {
  build: 'cyan',
  ship: 'magenta',
  revenue: 'green',
}

export function Ladder({ rung, color }: { rung: number; color: string }): React.JSX.Element {
  return (
    <Text>
      <Text color={color}>{'▓'.repeat(rung)}</Text>
      <Text dimColor>{'░'.repeat(MAX_RUNG - rung)}</Text>
      <Text dimColor> {rung}/{MAX_RUNG}</Text>
    </Text>
  )
}

export function topRungs(events: MilestoneEvent[]): Record<(typeof VERTICALS)[number], number> {
  const top = { build: 0, ship: 0, revenue: 0 }
  for (const e of events) {
    if (e.rung > top[e.vertical]) top[e.vertical] = e.rung
  }
  return top
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export interface SidebarProps {
  projects: Project[]
  eventsByProject: Record<number, MilestoneEvent[]>
  clan: Clan | null
  checkin: CheckinStatus | null
  feed: FeedEvent[]
  staleSince: string | null
  celebration: FeedEvent | null
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">⚒ FORGE</Text>
      {props.staleSince && (
        <Text color="red">offline — showing state from {timeAgo(props.staleSince)}</Text>
      )}
      {props.celebration && (
        <Text backgroundColor="yellow" color="black">
          {' '}🎉 {props.celebration.handle} hit {props.celebration.vertical} rung {props.celebration.rung}{' '}
        </Text>
      )}

      {props.projects.length === 0 && <Text dimColor>no projects — run `forge init`</Text>}
      {props.projects.map((p) => {
        const rungs = topRungs(props.eventsByProject[p.id] ?? [])
        return (
          <Box key={p.id} flexDirection="column" marginTop={1}>
            <Text bold>{p.name}</Text>
            {VERTICALS.map((v) => (
              <Box key={v}>
                <Box width={9}>
                  <Text dimColor>{v}</Text>
                </Box>
                <Ladder rung={rungs[v]} color={COLORS[v]} />
              </Box>
            ))}
          </Box>
        )
      })}

      {props.clan && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{props.clan.name}</Text>
          <Text>
            check-ins:{' '}
            <Text color={props.checkin && props.checkin.completed >= props.checkin.total ? 'green' : 'yellow'}>
              {props.checkin?.completed ?? 0}/{props.checkin?.total ?? props.clan.members.length}
            </Text>{' '}
            this week
          </Text>
          {props.feed.slice(0, 5).map((e) => (
            <Text key={e.id} dimColor>
              {e.handle} · {e.projectName} · {e.vertical} {e.rung} · {timeAgo(e.verifiedAt)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
