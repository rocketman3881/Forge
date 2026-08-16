import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import WebSocket from 'ws'
import type { ApiClient, FeedEvent } from '../api.js'
import { Sidebar, type SidebarProps } from './Sidebar.js'

interface AppProps {
  api: ApiClient
  serverUrl: string
  token: string
  pollMs?: number
}

export function App({ api, serverUrl, token, pollMs = 60_000 }: AppProps): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit()
  })
  const [columns, setColumns] = useState(stdout.columns ?? 80)
  const [state, setState] = useState<SidebarProps>({
    projects: [], eventsByProject: {}, clan: null, checkin: null,
    feed: [], staleSince: null, celebration: null, online: [], ping: null,
  })

  useEffect(() => {
    const onResize = () => setColumns(stdout.columns ?? 80)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [projects, clans] = await Promise.all([api.projects(), api.clansMine()])
      const clan = clans.value[0] ?? null
      const eventsByProject: SidebarProps['eventsByProject'] = {}
      for (const p of projects.value) {
        eventsByProject[p.id] = (await api.projectEvents(p.id)).value
      }
      const [checkin, feed] = clan
        ? await Promise.all([api.checkinStatus(clan.id), api.clanFeed(clan.id)])
        : [null, null]
      if (!alive) return
      setState((prev) => ({
        ...prev,
        projects: projects.value,
        eventsByProject,
        clan,
        checkin: checkin?.value ?? null,
        feed: feed?.value ?? [],
        staleSince: projects.staleSince,
      }))
    }
    void load()
    const timer = setInterval(() => void load(), pollMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, pollMs])

  useEffect(() => {
    if (!state.clan) return
    const clanId = state.clan.id
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/clans/${clanId}/ws?token=${token}`
    let sock: WebSocket | null = null
    let retry: NodeJS.Timeout | null = null
    let closed = false

    const connect = (): void => {
      if (closed) return
      sock = new WebSocket(wsUrl)
      sock.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as {
            type: string
            event: FeedEvent
            online?: string[]
            from?: string
            to?: string
            message?: string
          }
          if (msg.type === 'presence' && Array.isArray(msg.online)) {
            const online = msg.online
            setState((prev) => ({ ...prev, online }))
            return
          }
          if (msg.type === 'ping' && msg.from && msg.message) {
            const ping = { from: msg.from, to: msg.to ?? '', message: msg.message }
            setState((prev) => ({ ...prev, ping }))
            setTimeout(() => setState((prev) => (prev.ping === ping ? { ...prev, ping: null } : prev)), 12000)
            return
          }
          if (msg.type !== 'milestone') return
          setState((prev) => ({ ...prev, celebration: msg.event, feed: [msg.event, ...prev.feed] }))
          setTimeout(() => setState((prev) => ({ ...prev, celebration: null })), 8000)
        } catch {
          // malformed push: ignore, poll will reconcile
        }
      })
      sock.on('close', () => {
        // presence is socket-derived: drop to offline view and retry
        setState((prev) => ({ ...prev, online: [] }))
        if (!closed) retry = setTimeout(connect, 5000)
      })
      sock.on('error', () => {
        sock?.close()
      })
    }
    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      sock?.close()
    }
  }, [state.clan?.id, serverUrl, token])

  return (
    <Box width={columns} flexDirection="column" alignItems="flex-end">
      <Sidebar {...state} />
      <Box paddingX={2}>
        <Text dimColor>q to quit · keep this pane open, work in a split (⌘\)</Text>
      </Box>
    </Box>
  )
}
