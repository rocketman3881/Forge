import React from 'react'
import { Box, Text } from 'ink'
import type { Clan, CheckinStatus, FeedEvent, MilestoneEvent, Project } from '../api.js'

const VERTICALS = ['build', 'ship', 'revenue'] as const

const BANNER = [
  '╔═╗╔═╗╦═╗╔═╗╔═╗',
  '╠╣ ║ ║╠╦╝║ ╦║╣ ',
  '╚  ╚═╝╩╚═╚═╝╚═╝',
] as const

export function Banner(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {BANNER.map((line, i) => (
        <Text key={i} bold color="yellow">
          {line}
          {i === BANNER.length - 1 && <Text dimColor>  ⚒ verified progress</Text>}
        </Text>
      ))}
    </Box>
  )
}

const COLORS: Record<(typeof VERTICALS)[number], string> = {
  build: 'cyan',
  ship: 'magenta',
  revenue: 'green',
}

/** What each height means — shown next to the climb so it reads as history, not a meter. */
const MILESTONE_NAMES: Record<(typeof VERTICALS)[number], Record<number, string>> = {
  build: { 1: 'first commit', 2: 'first merged PR', 3: 'CI passing', 4: 'tests green 7d', 5: '100 commits' },
  ship: { 1: 'deployed live', 2: 'custom domain', 3: 'launched', 4: 'uptime 30d', 5: 'users active' },
  revenue: { 1: 'stripe live', 2: 'first dollar', 3: '10 customers', 4: 'first $100', 5: 'first $1k' },
}

/**
 * Open-ended climb: height reached so far, never distance-to-done.
 * A business has no finish line, so there is no full bar to fill.
 */
export function Ladder({ rung, color, latest }: { rung: number; color: string; latest?: string }): React.JSX.Element {
  if (rung === 0) {
    return (
      <Text dimColor>· not yet</Text>
    )
  }
  return (
    <Text>
      <Text color={color}>{'▲'.repeat(rung)}</Text>
      <Text color={color} bold> {rung}</Text>
      {latest && <Text dimColor> · {latest}</Text>}
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
  online: string[]
  ping: { from: string; to: string; message: string } | null
  projects: Project[]
  eventsByProject: Record<number, MilestoneEvent[]>
  clan: Clan | null
  checkin: CheckinStatus | null
  feed: FeedEvent[]
  staleSince: string | null
  celebration: FeedEvent | null
}

function SectionRule({ label }: { label: string }): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {'── '}
        {label}
        {' '}
        {'─'.repeat(Math.max(2, 24 - label.length))}
      </Text>
    </Box>
  )
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="yellow" borderDimColor>
      <Banner />
      {props.staleSince && (
        <Box marginTop={1}>
          <Text color="red">● offline — showing state from {timeAgo(props.staleSince)}</Text>
        </Box>
      )}
      {props.ping && (
        <Box marginTop={1}>
          <Text backgroundColor="magenta" color="black" bold>
            {' '}✉ {props.ping.from} → {props.ping.to}: {props.ping.message}{' '}
          </Text>
        </Box>
      )}
      {props.celebration && (
        <Box marginTop={1}>
          <Text backgroundColor="yellow" color="black" bold>
            {' '}🎉 {props.celebration.handle} hit {props.celebration.vertical} rung {props.celebration.rung}{' '}
          </Text>
        </Box>
      )}

      {props.projects.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>no projects — run `forge init`</Text>
        </Box>
      )}
      {props.projects.map((p) => {
        const events = props.eventsByProject[p.id] ?? []
        const rungs = topRungs(events)
        const latestFor = (v: (typeof VERTICALS)[number]): string | undefined => {
          const hit = [...events].reverse().find((e) => e.vertical === v)
          return hit ? MILESTONE_NAMES[v][hit.rung] ?? undefined : undefined
        }
        return (
          <Box key={p.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="yellow">◍ </Text>
              <Text bold>{p.name}</Text>
            </Text>
            {VERTICALS.map((v) => (
              <Box key={v} paddingLeft={2}>
                <Box width={9}>
                  <Text color={COLORS[v]}>{v}</Text>
                </Box>
                <Ladder rung={rungs[v]} color={COLORS[v]} latest={latestFor(v)} />
              </Box>
            ))}
          </Box>
        )
      })}

      {props.clan && (
        <Box flexDirection="column">
          <SectionRule label={`clan: ${props.clan.name}`} />
          <Box paddingLeft={2} flexDirection="column">
            <Text>
              <Text dimColor>check-ins </Text>
              <Text color={props.checkin && props.checkin.completed >= props.checkin.total ? 'green' : 'yellow'} bold>
                {props.checkin?.completed ?? 0}/{props.checkin?.total ?? props.clan.members.length}
              </Text>
              <Text dimColor> this week</Text>
            </Text>
            {props.clan.members.map((m) => (
              <Text key={m.handle}>
                <Text color={props.online.includes(m.handle) ? 'green' : 'gray'}>
                  {props.online.includes(m.handle) ? '● ' : '○ '}
                </Text>
                <Text>{m.handle}</Text>
                <Text dimColor>{props.online.includes(m.handle) ? ' online' : ' offline'}</Text>
              </Text>
            ))}
            {props.feed.slice(0, 5).map((e) => (
              <Text key={e.id}>
                <Text color="yellow">⚡ </Text>
                <Text>{e.handle}</Text>
                <Text dimColor> · {e.projectName} · </Text>
                <Text color={COLORS[e.vertical]}>{e.vertical} {e.rung}</Text>
                <Text dimColor> · {timeAgo(e.verifiedAt)}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}
