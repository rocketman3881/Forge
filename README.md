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
