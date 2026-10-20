-- A resumed chat request must know whether its turn already persisted the user's message and
-- step snapshot (IMPLEMENTATION_PLAN §8.2); a NULL snapshot alone cannot say so.
ALTER TABLE agent.request_log ADD COLUMN started boolean NOT NULL DEFAULT false;
