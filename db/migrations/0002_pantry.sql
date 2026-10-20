-- Schema `pantry`, owned by mcp-server. See IMPLEMENTATION_PLAN §2.1.
SET search_path TO pantry;

-- ── Tenancy and access ───────────────────────────────────
CREATE TABLE households (
  id        uuid PRIMARY KEY,
  name      text NOT NULL,
  timezone  text NOT NULL DEFAULT 'America/Los_Angeles'
);

CREATE TABLE api_clients (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- ── Catalog ──────────────────────────────────────────────
CREATE TABLE items (
  id                 uuid PRIMARY KEY,
  household_id       uuid NOT NULL REFERENCES households,
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  aliases            text[] NOT NULL DEFAULT '{}',
  base_unit          text NOT NULL CHECK (base_unit IN ('count','g','ml')),
  category           text NOT NULL CHECK (category IN
                       ('produce','dairy','meat','seafood','pantry','frozen','bakery','other')),
  default_shelf_days int CHECK (default_shelf_days > 0),
  created_by_op      uuid
);
CREATE UNIQUE INDEX items_name_ci ON items (household_id, lower(name));

CREATE TABLE unit_conversions (
  household_id  uuid NOT NULL REFERENCES households,
  item_id       uuid NOT NULL REFERENCES items,
  unit          text NOT NULL CHECK (unit ~ '^[a-z][a-z ]{0,19}$'
                                     AND unit NOT IN ('count','g','ml','kg','l')),
  base_qty      numeric NOT NULL CHECK (base_qty > 0),
  created_by_op uuid,
  PRIMARY KEY (item_id, unit)
);

-- ── Recipes (self-authored) ──────────────────────────────
CREATE TABLE recipes (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households,
  name         text NOT NULL,
  aliases      text[] NOT NULL DEFAULT '{}',
  servings     int NOT NULL CHECK (servings > 0)
);
CREATE UNIQUE INDEX recipes_name_ci ON recipes (household_id, lower(name));

CREATE TABLE recipe_ingredients (
  recipe_id   uuid NOT NULL REFERENCES recipes,
  item_id     uuid NOT NULL REFERENCES items,
  quantity    numeric NOT NULL CHECK (quantity > 0),
  optional    boolean NOT NULL DEFAULT false,
  substitutes jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (recipe_id, item_id)
);

CREATE TABLE recipe_steps (
  recipe_id     uuid NOT NULL REFERENCES recipes,
  step_no       int  NOT NULL CHECK (step_no >= 1),
  text          text NOT NULL,
  timer_seconds int  CHECK (timer_seconds BETWEEN 10 AND 7200),
  timer_label   text,
  PRIMARY KEY (recipe_id, step_no)
);

-- ── Cooking sessions ─────────────────────────────────────
CREATE TABLE cooking_sessions (
  id              uuid PRIMARY KEY,
  household_id    uuid NOT NULL REFERENCES households,
  conversation_id uuid NOT NULL,
  recipe_id       uuid NOT NULL REFERENCES recipes,
  servings        int  NOT NULL CHECK (servings > 0),
  state           text NOT NULL CHECK (state IN
                    ('cooking','awaiting_confirmation','consumed','cancelled','reverted')),
  total_steps     int  NOT NULL CHECK (total_steps >= 1),
  current_step    int  NOT NULL DEFAULT 1,
  planned_usage   jsonb NOT NULL,
  state_version   int  NOT NULL DEFAULT 1,
  started_at      timestamptz NOT NULL DEFAULT now(),
  consumed_at     timestamptz,
  ended_at        timestamptz,
  CHECK (current_step BETWEEN 1 AND total_steps)
);
CREATE UNIQUE INDEX one_active_session ON cooking_sessions (household_id)
  WHERE state IN ('cooking','awaiting_confirmation');

-- ── Proposals and confirmations ──────────────────────────
CREATE TABLE proposals (
  id                  uuid PRIMARY KEY,
  household_id        uuid NOT NULL REFERENCES households,
  conversation_id     uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN
                        ('intake','consume','revise_consumption','adjust','undo')),
  subject_key         text NOT NULL,
  target_session_id   uuid REFERENCES cooking_sessions,
  target_operation_id uuid,
  version             int  NOT NULL DEFAULT 1,
  input               jsonb NOT NULL,
  payload             jsonb NOT NULL,
  preconditions       jsonb NOT NULL,
  status              text NOT NULL CHECK (status IN
                        ('pending','committed','rejected','superseded','stale','expired')),
  stale_reason        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);
CREATE UNIQUE INDEX one_pending_per_subject ON proposals (household_id, subject_key)
  WHERE status = 'pending';

CREATE TABLE proposal_versions (
  proposal_id   uuid NOT NULL REFERENCES proposals,
  version       int  NOT NULL,
  payload       jsonb NOT NULL,
  preconditions jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, version)
);

CREATE TABLE confirmations (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households,
  proposal_id  uuid NOT NULL REFERENCES proposals,
  version      int  NOT NULL,
  user_id      text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('ui_click','voice_rule')),
  request_id   uuid NOT NULL,
  utterance    text CHECK (char_length(utterance) <= 60),
  outcome      text NOT NULL CHECK (outcome IN ('committed','stale','expired')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, version),
  UNIQUE (household_id, request_id)
);

-- ── Operations and ledger ────────────────────────────────
CREATE TABLE operations (
  id                    uuid PRIMARY KEY,
  household_id          uuid NOT NULL REFERENCES households,
  kind                  text NOT NULL CHECK (kind IN
                          ('intake','consume','revise_consumption','adjust','undo')),
  proposal_id           uuid NOT NULL REFERENCES proposals,
  proposal_version      int  NOT NULL,
  confirmation_id       uuid NOT NULL REFERENCES confirmations,
  session_id            uuid REFERENCES cooking_sessions,
  reverts_operation_ids uuid[] NOT NULL DEFAULT '{}',
  reverted_by_op        uuid REFERENCES operations,
  summary               jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, proposal_version)
);

CREATE TABLE batches (
  id                uuid PRIMARY KEY,
  household_id      uuid NOT NULL REFERENCES households,
  item_id           uuid NOT NULL REFERENCES items,
  quantity          numeric NOT NULL CHECK (quantity >= 0),
  purchased_at      date NOT NULL,
  opened_at         date,
  package_date      date,
  package_date_type text CHECK (package_date_type IN ('use_by','best_by','unknown')),
  priority_date     date NOT NULL,
  priority_source   text NOT NULL CHECK (priority_source IN ('package','estimate')),
  status            text NOT NULL CHECK (status IN ('active','depleted','discarded')),
  version           int  NOT NULL DEFAULT 1,
  created_by_op     uuid NOT NULL REFERENCES operations,
  CHECK ((package_date IS NULL) = (package_date_type IS NULL)),
  CHECK (opened_at IS NULL OR opened_at >= purchased_at)
);
CREATE INDEX batches_fefo ON batches (household_id, item_id, status, priority_date, purchased_at, id);

CREATE TABLE inventory_events (
  id               uuid PRIMARY KEY,
  household_id     uuid NOT NULL REFERENCES households,
  operation_id     uuid NOT NULL REFERENCES operations,
  batch_id         uuid NOT NULL REFERENCES batches,
  item_id          uuid NOT NULL REFERENCES items,
  delta            numeric NOT NULL CHECK (delta <> 0),
  reason           text NOT NULL CHECK (reason IN
                     ('purchase','consume','consume_revision','adjust','discard','undo')),
  session_id       uuid REFERENCES cooking_sessions,
  reverts_event_id uuid REFERENCES inventory_events,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'purchase' OR delta > 0),
  CHECK ((reason = 'undo') = (reverts_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_revert_per_event ON inventory_events (reverts_event_id)
  WHERE reverts_event_id IS NOT NULL;
CREATE INDEX inventory_events_batch ON inventory_events (batch_id);
CREATE INDEX inventory_events_session_item ON inventory_events (session_id, item_id);

-- ── Request idempotency ──────────────────────────────────
CREATE TABLE request_log (
  household_id uuid NOT NULL,
  request_id   uuid NOT NULL,
  scope        text NOT NULL,
  payload_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, request_id)
);

-- ── Shopping list ────────────────────────────────────────
CREATE TABLE shopping_list_items (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households,
  item_id      uuid REFERENCES items,
  free_text    text CHECK (char_length(free_text) BETWEEN 1 AND 60),
  quantity     numeric CHECK (quantity > 0),
  unit         text,
  source       text NOT NULL CHECK (source IN ('manual','shortfall')),
  session_id   uuid REFERENCES cooking_sessions,
  done         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (item_id IS NOT NULL OR free_text IS NOT NULL),
  CHECK ((quantity IS NULL) = (unit IS NULL))
);

-- ── Privileges: pantry_mcp only. Append-only tables get no UPDATE/DELETE. ──
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pantry TO pantry_mcp;
REVOKE UPDATE ON inventory_events, proposal_versions FROM pantry_mcp;
GRANT DELETE ON request_log TO pantry_mcp;   -- retention purge only
