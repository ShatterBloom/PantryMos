-- The ChatGPT tokens are now stored encrypted under CHATGPT_TOKEN_KEY (apps/agent/src/chatgpt/sealing.ts).
-- A session saved before holds them in plain text: drop it; the next sign-in stores them sealed.
SET search_path TO agent;

DELETE FROM chatgpt_session;
