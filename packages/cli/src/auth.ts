import { createServer } from 'node:http'
import { execFile } from 'node:child_process'

export type Opener = (url: string) => void

export function defaultOpener(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  execFile(cmd, [url], () => {
    // best-effort: the URL is also printed for manual copy/paste
  })
}

const RELAY_PAGE = `<!doctype html><meta charset="utf-8"><title>Forge</title>
<body style="font-family:monospace;background:#111;color:#eee;padding:2rem">
<p id="msg">Signing you in…</p>
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  if (token) {
    fetch('/token?token=' + encodeURIComponent(token)).then(() => {
      document.getElementById('msg').textContent = 'Signed in — you can close this tab and return to the terminal.'
    })
  } else {
    document.getElementById('msg').textContent = 'No token found in the redirect. Try again.'
  }
</script>`

/**
 * Runs the loopback login dance: starts a local server, opens the browser at
 * the backend's OAuth start URL, and resolves with the session token relayed
 * back by the loopback page.
 */
export function login(
  serverUrl: string,
  opener: Opener = defaultOpener,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/cb') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(RELAY_PAGE)
        return
      }
      if (url.pathname === '/token') {
        const token = url.searchParams.get('token')
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        if (token) {
          clearTimeout(timer)
          server.close()
          resolve(token)
        }
        return
      }
      res.writeHead(404).end()
    })
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('login timed out — no token received'))
    }, timeoutMs)
    timer.unref()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const redirect = encodeURIComponent(`http://127.0.0.1:${port}/cb`)
      const startUrl = `${serverUrl}/auth/github/start?redirect_uri=${redirect}`
      console.log(`Opening browser for GitHub sign-in…\nIf nothing opens, visit:\n  ${startUrl}`)
      opener(startUrl)
    })
    server.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
