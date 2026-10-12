-- 058: provider requests spent by the chat scripts, so the daily count sees them.
--
-- 2026-10-12: `npm run chat:usage` and the app's daily budget read 0/45
-- after at least 40 provider requests had gone out that day. The requests
-- were the evaluation and scenario scripts' (scripts/chat-eval.js,
-- scripts/chat-scenarios.js). They call the same provider key as the app
-- but write no threads, so DAILY_USAGE_SQL -- which counts the cost on the
-- dispatcher's message rows (055) -- never saw them, and a learner met the
-- provider's real limit with the budget still showing room.
--
-- One row per script call to the model, written by the script after the
-- call, failed calls included (a refused request still counts, as in the
-- app). `requests` is what aiClient's onRequest counted for that call:
-- backoff retries, the second try and a fallback-model request are all in it.
--
-- side says which chat's prompt the call was for; the wallet scope in
-- DAILY_USAGE_SQL filters on it exactly as it does for the app's rows.
-- No user: a script run belongs to nobody's share, only to the account's total.

CREATE TABLE IF NOT EXISTS chat_script_requests (
  id          bigserial   PRIMARY KEY,
  source      text        NOT NULL,
  side        text        NOT NULL,
  model       text        NOT NULL,
  requests    smallint    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_script_requests_source CHECK (source IN ('eval', 'scenarios')),
  CONSTRAINT chat_script_requests_side CHECK (side IN ('broker', 'driver')),
  CONSTRAINT chat_script_requests_nonneg CHECK (requests >= 0)
);

CREATE INDEX IF NOT EXISTS chat_script_requests_created ON chat_script_requests (created_at);
