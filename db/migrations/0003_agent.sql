-- Schema `agent`, owned by the agent backend. See IMPLEMENTATION_PLAN §2.2, §5.2, §8.
SET search_path TO agent;

CREATE TABLE conversations (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL,          -- opaque reference into pantry
  user_id      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_messages (
  conversation_id uuid NOT NULL REFERENCES conversations,
  seq             int  NOT NULL,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE app_events (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL REFERENCES conversations,
  kind               text NOT NULL,
  payload            jsonb NOT NULL,
  dedupe_key         text NOT NULL,
  triggers_turn      boolean NOT NULL DEFAULT false,
  turn_claimed_until timestamptz,
  turn_attempts      int NOT NULL DEFAULT 0,
  turn_done_at       timestamptz,
  turn_failed        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,
  UNIQUE (conversation_id, dedupe_key)
);
CREATE INDEX app_events_pending_turns ON app_events (created_at)
  WHERE triggers_turn AND turn_done_at IS NULL AND NOT turn_failed;

CREATE TABLE conversation_locks (
  conversation_id uuid PRIMARY KEY REFERENCES conversations,
  holder          uuid NOT NULL,
  lease_until     timestamptz NOT NULL
);

CREATE TABLE request_log (
  conversation_id uuid NOT NULL,
  request_id      uuid NOT NULL,
  route           text NOT NULL,
  payload_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('in_progress','done','failed')),
  lease_until     timestamptz NOT NULL,
  turn_snapshot   jsonb,               -- e.g. {session_id, step_no} for expected_step (§7.4)
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_id)
);

CREATE TABLE timers (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations,
  session_id      uuid,
  step_no         int,
  label           text NOT NULL CHECK (char_length(label) <= 40),
  seconds         int  NOT NULL CHECK (seconds BETWEEN 10 AND 7200),
  status          text NOT NULL CHECK (status IN ('running','paused','fired','cancelled')),
  fires_at        timestamptz,
  remaining_s     int,
  fired_at        timestamptz,
  request_id      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, request_id),
  CHECK ((status = 'running') = (fires_at IS NOT NULL)),
  CHECK ((status = 'paused')  = (remaining_s IS NOT NULL))
);
CREATE INDEX timers_due ON timers (status, fires_at);

CREATE TABLE outbound_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations,
  turn_type       text NOT NULL CHECK (turn_type IN ('user','proactive','gate')),
  speech          text NOT NULL,
  cards           jsonb NOT NULL DEFAULT '[]',
  voice_prompt    jsonb,
  session_id      uuid,
  step_no         int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_by_conversation ON outbound_messages (conversation_id, id);

CREATE TABLE voice_windows (
  id                uuid PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversations,
  kind              text NOT NULL CHECK (kind IN ('proposal_confirm','timer_offer')),
  source_message_id bigint NOT NULL REFERENCES outbound_messages,
  proposal_id       uuid,
  version           int,
  timer_spec        jsonb,
  window_ends_at    timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('open','consumed','closed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'proposal_confirm') = (proposal_id IS NOT NULL AND version IS NOT NULL)),
  CHECK ((kind = 'timer_offer') = (timer_spec IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_window ON voice_windows (conversation_id) WHERE status = 'open';
CREATE UNIQUE INDEX one_window_per_message ON voice_windows (conversation_id, source_message_id);

CREATE TABLE tool_calls (
  conversation_id uuid NOT NULL REFERENCES conversations,
  tool_use_id     text NOT NULL,
  chat_request_id uuid,
  event_ids       uuid[],
  name            text NOT NULL,
  final_input     jsonb NOT NULL,
  request_id      uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','done')),
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tool_use_id)
);

-- ── Privileges: pantry_agent only ──
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA agent TO pantry_agent;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA agent TO pantry_agent;
GRANT DELETE ON request_log TO pantry_agent;  -- retention purge only
