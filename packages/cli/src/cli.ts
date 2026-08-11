#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { KeychainStore } from './store.js'
import { ApiClient } from './api.js'
import { login } from './auth.js'
import { App } from './ui/App.js'
import { CheckinForm } from './ui/CheckinForm.js'
import { init, connect, clan, how, refresh } from './commands.js'

const HELP = `forge — verified founder accountability, in your terminal

  forge                     sidebar (live progress + clan feed)
  forge login               sign in with GitHub
  forge init                register this repo as a project + hook shim
  forge connect github <owner/repo>
  forge connect stripe <restricted read-only key>
  forge connect deploy <https://url>
  forge connect domain <example.com>
  forge clan create <name> | forge clan join <code>
  forge checkin             weekly three-field check-in
  forge how <user> <milestone>   e.g. forge how sarah revenue2
  forge refresh             warm the offline cache

  FORGE_SERVER overrides the backend url (default http://localhost:3000)
`

const io = {
  log: (l: string) => console.log(l),
  error: (l: string) => console.error(l),
}

async function main(): Promise<void> {
  const store = new KeychainStore()
  const serverUrl = process.env.FORGE_SERVER ?? store.getConfig().serverUrl ?? 'http://localhost:3000'
  const [cmd, ...args] = process.argv.slice(2)

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.log(HELP)
    return
  }

  if (cmd === 'login') {
    const token = await login(serverUrl)
    await store.setToken(token)
    store.setConfig({ serverUrl })
    io.log('signed in ✓')
    return
  }

  let token = await store.getToken()
  if (!token) {
    token = await login(serverUrl)
    await store.setToken(token)
    store.setConfig({ serverUrl })
  }
  const api = new ApiClient(serverUrl, token, store)

  switch (cmd) {
    case undefined: {
      render(React.createElement(App, { api, serverUrl, token }))
      return
    }
    case 'init':
      return init(api, store, io)
    case 'connect':
      return connect(api, store, io, args[0] ?? '', args[1])
    case 'clan':
      return clan(api, store, io, args[0] ?? '', args[1])
    case 'checkin': {
      const clanId = store.getConfig().clanId ?? (await api.clansMine()).value[0]?.id
      if (!clanId) throw new Error('no clan — run `forge clan join <code>` first')
      const projectId = store.getConfig().projectId
      const events = projectId ? (await api.projectEvents(projectId)).value : []
      const latest = events.at(-1)
      const prefill = latest ? `${latest.vertical} rung ${latest.rung} (${latest.evidenceRef})` : ''
      render(
        React.createElement(CheckinForm, {
          prefillShipped: prefill,
          onSubmit: async (fields) => {
            await api.checkin(clanId, fields)
          },
        }),
      )
      return
    }
    case 'how': {
      if (!args[0] || !args[1]) throw new Error('usage: forge how <user> <milestone>')
      return how(api, store, io, args[0], args[1])
    }
    case 'refresh':
      return refresh(api)
    default:
      io.error(`unknown command "${cmd}"\n`)
      io.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err: Error) => {
  io.error(err.message)
  process.exitCode = 1
})
