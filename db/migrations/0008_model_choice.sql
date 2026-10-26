-- The model the agent talks to, chosen in the app from those MODEL_PROVIDERS configures. One per
-- agent, like the ChatGPT sign-in; a provider no longer configured counts as not chosen.
SET search_path TO agent;

CREATE TABLE model_choice (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider  text NOT NULL,
  chosen_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON model_choice TO pantry_agent;
