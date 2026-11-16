-- 077: a posting held for one conversation once the price is agreed.
--
-- postings_time_order (010) requires expires_at <= pickup_at, so the hold
-- cannot be written into expires_at. It lives in its own columns: who holds
-- the posting and until when. The board hides a posting while it is held, and
-- the holder's conversation may outlive the posted expiry until the hold ends.
--
-- The two conversation columns make the "I can only keep this a few more
-- minutes" warning and the "that load got covered" message one-shot: each is
-- written by a conditional UPDATE, so two readers of the thread cannot both
-- post the message.

ALTER TABLE load_postings
  ADD COLUMN IF NOT EXISTS held_by_conversation_id uuid NULL REFERENCES broker_conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS held_until timestamptz NULL;

ALTER TABLE broker_conversations
  ADD COLUMN IF NOT EXISTS expiry_warned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS expiry_noticed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_load_postings_held
  ON load_postings (held_until) WHERE held_by_conversation_id IS NOT NULL;
