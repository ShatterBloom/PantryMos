# One image, three targets. Node 24 runs the TypeScript sources directly (type stripping).
FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY db ./db
USER node

FROM base AS migrate
CMD ["sh", "-c", "node scripts/db-bootstrap.ts && node scripts/db-migrate.ts && node scripts/seed-dev.ts"]

FROM base AS mcp-server
CMD ["node", "apps/mcp-server/src/index.ts"]

FROM base AS agent
CMD ["node", "apps/agent/src/index.ts"]
