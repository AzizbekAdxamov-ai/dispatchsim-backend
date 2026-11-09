-- 074: the shipper and receiver names on a rate confirmation are frozen
-- when the paper is issued.
--
-- They were a pure function of the posting id and the name lists in
-- stops.js, recomputed on every read, so editing a list changed the names on
-- a rate confirmation that had already been sent and signed. They are now
-- stored on the conversation the first time the paper is issued and read
-- back from there. Rows issued before this migration are filled lazily on
-- their next read (same names as today); there is no backfill.
ALTER TABLE broker_conversations
  ADD COLUMN IF NOT EXISTS rate_con_stops jsonb NULL;

ALTER TABLE broker_conversations
  DROP CONSTRAINT IF EXISTS broker_conversations_rate_con_stops_object;
ALTER TABLE broker_conversations
  ADD CONSTRAINT broker_conversations_rate_con_stops_object
  CHECK (rate_con_stops IS NULL OR jsonb_typeof(rate_con_stops) = 'object');
