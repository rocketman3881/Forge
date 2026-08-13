# Forge

Terminal-native founder accountability: a sidebar where your clan sees each
other's verified project progress. Spec: docs/superpowers/specs/.

## Development

Requires Node 22+ and pnpm.

    pnpm install
    pnpm test                      # all packages (tests use in-memory Postgres)

## Running the server locally

    DATABASE_URL=postgres://localhost/forge \
    FORGE_SECRET=$(openssl rand -hex 32) \
    GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
    pnpm --filter @forge/server dev

### Environment

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `FORGE_SECRET` | 64 hex chars — secret-encryption key; generate with `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhooks; enables integration routes |
| `PUBLIC_URL` | Public base URL used for webhook callbacks (default `http://localhost:3000`) |
| `PORT` | Listen port (default `3000`) |
| `FORGE_WORKERS` | Set to `off` to disable background polling |

## Deploying (Railway, ~$5/mo MVP)

The server must run as a single always-on instance (WebSockets, in-process
workers, in-memory OAuth state). `Dockerfile` + `railway.json` are included.

1. Push to GitHub, then railway.com → New Project → Deploy from GitHub repo.
2. Add a Postgres service in the same project (`DATABASE_URL` is auto-injected;
   migrations run at boot).
3. Set variables on the app service: `FORGE_SECRET` (`openssl rand -hex 32`),
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`,
   `PUBLIC_URL=https://api.<your-domain>`.
4. Point a CNAME `api.<your-domain>` at the Railway-issued hostname and add it
   as a custom domain (TLS is automatic).
5. Register a GitHub App (preferred over a classic OAuth app) with callback
   `https://api.<your-domain>/auth/github/callback` and webhook
   `https://api.<your-domain>/webhooks/github`.

Users then run the CLI with `FORGE_SERVER=https://api.<your-domain>`.

## Using the CLI

    pnpm --filter forge-cli build
    node packages/cli/dist/cli.js help

    forge login               # GitHub sign-in via browser
    forge init                # register this repo as a project + hook shim
    forge connect stripe <restricted read-only key>
    forge connect deploy https://your-app.example
    forge clan create <name>  # or: forge clan join <code>
    forge                     # live sidebar
    forge checkin             # weekly three-field check-in
    forge how sarah revenue2  # show the verified evidence

Set `FORGE_SERVER` to point at your backend (default `http://localhost:3000`).
Offline, the sidebar shows last-known state with a staleness banner.
