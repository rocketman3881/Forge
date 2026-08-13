import { expect, it } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Sidebar, topRungs } from '../src/ui/Sidebar.js'
import type { MilestoneEvent } from '../src/api.js'

const ev = (vertical: MilestoneEvent['vertical'], rung: number): MilestoneEvent => ({
  id: rung, projectId: 1, vertical, rung, evidenceRef: 'x', verifiedAt: new Date().toISOString(),
})

it('topRungs takes the max per vertical', () => {
  expect(topRungs([ev('build', 1), ev('build', 3), ev('ship', 2)])).toEqual({
    build: 3, ship: 2, revenue: 0,
  })
})

it('renders ladders, clan check-ins, and feed', () => {
  const { lastFrame } = render(
    <Sidebar
      projects={[{ id: 1, name: 'launchpage', repoFullName: 'tom/x', deployUrl: null }]}
      eventsByProject={{ 1: [ev('build', 3), ev('revenue', 2)] }}
      clan={{ id: 1, name: 'crew', members: [{ handle: 'tomr', status: 'active' }, { handle: 'sarah', status: 'active' }] }}
      checkin={{ weekStart: '2026-08-10', completed: 1, total: 2 }}
      feed={[{ ...ev('revenue', 2), handle: 'tomr', projectName: 'launchpage' }]}
      staleSince={null}
      celebration={null}
    />,
  )
  const frame = lastFrame()!
  expect(frame).toContain('╔═╗╔═╗╦═╗╔═╗╔═╗')
  expect(frame).toContain('⚒ verified progress')
  expect(frame).toContain('launchpage')
  expect(frame).toContain('███▁▁ 3/5')
  expect(frame).toContain('██▁▁▁ 2/5')
  expect(frame).toContain('1/2 this week')
  expect(frame).toContain('tomr · launchpage · revenue 2')
  expect(frame).not.toContain('offline')
})

it('shows the staleness banner and celebration bar', () => {
  const { lastFrame } = render(
    <Sidebar
      projects={[]} eventsByProject={{}} clan={null} checkin={null} feed={[]}
      staleSince={new Date(Date.now() - 12 * 60_000).toISOString()}
      celebration={{ ...ev('revenue', 2), handle: 'sarah', projectName: 'shop' }}
    />,
  )
  const frame = lastFrame()!
  expect(frame).toContain('offline — showing state from 12m ago')
  expect(frame).toContain('🎉 sarah hit revenue rung 2')
  expect(frame).toContain('no projects')
})
