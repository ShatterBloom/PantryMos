# PantryMos

**Mos, your pantry's little helper**: a hands-free kitchen agent that keeps batch-level inventory.
It is built for the Amazon Developer Hackathon (Alexa+ track, simulated Alexa+ experience).

> Status: **M0 foundations**. Repo scaffold, database schema, MCP server with security controls, agent and web shells.

## Architecture

```
web (Vite + React) ──/api──▶ agent (Fastify, Bedrock tool use)
                                 │ MCP over Streamable HTTP (bearer token)
                                 │ internal API (service token)
                                 ▼
                           mcp-server (official MCP SDK) ──▶ PostgreSQL
```

- **The agent proposes, the user confirms, the server commits.** The model has no tool that changes inventory.
- `mcp-server` owns schema `pantry`, and `agent` owns schema `agent`. Each runs under its own Postgres role, with no access to the other's schema. Ledger tables are append-only at the privilege level.
- The MCP and internal listeners bind to `127.0.0.1` only. In Docker, the agent shares the MCP server's network namespace, and only the agent port is published.

## Requirements

- Node.js 24 (`.nvmrc`); TypeScript runs natively, with no build step
- pnpm 11
- Docker (for PostgreSQL)

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm db:up            # PostgreSQL on 127.0.0.1:5432
pnpm db:bootstrap     # roles + databases
pnpm db:migrate
pnpm db:seed          # demo household + agent MCP token

pnpm dev:mcp          # MCP on 127.0.0.1:7410, internal API on 127.0.0.1:7411
pnpm dev:agent        # API on 127.0.0.1:7400
pnpm dev:web          # http://127.0.0.1:5173
```

Or run the whole stack in containers:

```bash
docker compose up --build    # then open http://127.0.0.1:7400/api/health
```

## Tests

```bash
pnpm db:up
pnpm typecheck
pnpm test               # everything; recreates the `pantrymos_test` database on every run
pnpm test:unit          # pure logic, no database needed
pnpm test:integration   # real Postgres and real HTTP listeners
pnpm test:coverage      # all tests plus the coverage gate CI enforces
```

Tests live under `test/unit/` and `test/integration/` in each package.

## Trying the MCP server with MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:7410/mcp --transport http \
  --header "Authorization: Bearer $AGENT_MCP_TOKEN" --method tools/list
```

Browser-based Inspector sessions also need their origin in `MCP_ALLOWED_ORIGINS`.

## License

[MIT](LICENSE)
