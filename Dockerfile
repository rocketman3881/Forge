# Forge server — single always-on instance (WebSockets + in-process workers).
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Install deps first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @forge/server --prod

COPY packages/server packages/server

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@forge/server", "start"]
