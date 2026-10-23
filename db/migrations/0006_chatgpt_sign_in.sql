-- Sign in with ChatGPT (developers.openai.com/siwc): the agent talks to the model on the user's
-- ChatGPT plan. One sign-in per agent, like the one demo household it serves.
SET search_path TO agent;

-- This host's registration: a stable, opaque host id, and the client id OpenAI issued on the first
-- sign-in (reused to sign the same account in again; cleared on sign-out, so the next sign-in may
-- register another account). The "You're using your ChatGPT plan" notice is shown once per host.
CREATE TABLE chatgpt_registration (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  host_id    text NOT NULL,
  client_id  text,
  subject    text,
  welcomed   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-ins started and not yet called back: one row per attempt, used once.
CREATE TABLE chatgpt_sign_ins (
  state        text PRIMARY KEY,
  verifier     text NOT NULL,
  nonce        text NOT NULL,
  redirect_uri text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The signed-in account's tokens. The refresh token rotates: refreshes take this row's lock.
CREATE TABLE chatgpt_session (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  client_id     text NOT NULL,
  subject       text NOT NULL,
  email         text,
  id_token      text NOT NULL,
  access_token  text NOT NULL,
  refresh_token text NOT NULL,
  scopes        text[] NOT NULL,
  expires_at    timestamptz NOT NULL,
  -- The plan's model catalog at sign-in, in the server's order: [{slug, display_name}].
  models        jsonb NOT NULL DEFAULT '[]',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON chatgpt_registration, chatgpt_sign_ins, chatgpt_session TO pantry_agent;
