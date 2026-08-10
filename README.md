# Forge

Terminal-native founder accountability: a sidebar where your clan sees each
other's verified project progress. Spec: docs/superpowers/specs/.

## Development

Requires Node 22+ and pnpm.

    pnpm install
    pnpm test                      # all packages (tests use in-memory Postgres)

## Running the server locally

    DATABASE_URL=postgres://localhost/forge \
    GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
    pnpm --filter @forge/server dev
