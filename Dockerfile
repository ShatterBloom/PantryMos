# One image, three targets. Node 24 runs the TypeScript sources directly (type stripping).
# The web app is built in its own stage (it needs dev dependencies) and served by the agent.
FROM node:24-bookworm-slim AS web
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@pantrymos/web..."
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @pantrymos/web build

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
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV AGENT_WEB_DIR=/app/apps/web/dist
CMD ["node", "apps/agent/src/index.ts"]
