-- Schemas and ownership boundaries.
-- Roles pantry_mcp and pantry_agent are created by scripts/db-bootstrap.ts;
-- create them NOLOGIN here as a fallback so migrations are self-contained.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pantry_mcp') THEN
    CREATE ROLE pantry_mcp NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pantry_agent') THEN
    CREATE ROLE pantry_agent NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS pantry;
CREATE SCHEMA IF NOT EXISTS agent;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA pantry FROM PUBLIC;
REVOKE ALL ON SCHEMA agent  FROM PUBLIC;

-- Each service sees only its own schema.
GRANT USAGE ON SCHEMA pantry TO pantry_mcp;
GRANT USAGE ON SCHEMA agent  TO pantry_agent;
