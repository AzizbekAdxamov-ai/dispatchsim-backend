-- 060: what each provider request of a chat reply came to.
--
-- 2026-10-14: an evaluation case (EB04) answered from the fallback model and
-- nothing recorded why. The primary's 429 was caught, parsed for the one
-- decision it fed (switch model), and thrown away. Tokens had the same hole:
-- the provider reports them on every response and the app read them only to
-- build an error message, so "how much of the day's token allowance is left"
-- could not be answered from anything the app keeps.
--
-- `attempts` is an array, one element per HTTP request:
--   { n, model, cause, status, outcome, rateLimit, usage }
-- cause:   first | backoff | fallback | more_room | regenerate
-- outcome: ok | rate_limited | daily_cap | out_of_room | cut_off | empty |
--          http_error | network
-- rateLimit: the parsed 429 fields only (code, window, unit, limit, used,
--          requested, retryAfterSec, source). The provider's raw message is
--          NOT stored. usage: { prompt, completion, reasoning, cached, total }.
--
-- Rows written before this migration hold '[]': no record, not "no requests".
-- jsonb_typeof is checked so a stray object or string cannot slip in and
-- break the daily token query (jsonb_array_elements fails on non-arrays).

ALTER TABLE chat_turn_log
  ADD COLUMN IF NOT EXISTS attempts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat_turn_log DROP CONSTRAINT IF EXISTS chat_turn_log_attempts_array;
ALTER TABLE chat_turn_log
  ADD CONSTRAINT chat_turn_log_attempts_array CHECK (jsonb_typeof(attempts) = 'array');

ALTER TABLE chat_script_requests
  ADD COLUMN IF NOT EXISTS attempts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat_script_requests DROP CONSTRAINT IF EXISTS chat_script_requests_attempts_array;
ALTER TABLE chat_script_requests
  ADD CONSTRAINT chat_script_requests_attempts_array CHECK (jsonb_typeof(attempts) = 'array');
