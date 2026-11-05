-- 069: a price the carrier closed at before their MC checked out.
-- The broker accepts the price and waits only for the MC; when the MC
-- verifies on a later turn, this amount becomes the agreed rate.
ALTER TABLE broker_conversations ADD COLUMN IF NOT EXISTS pending_close_usd integer NULL;
ALTER TABLE broker_conversations DROP CONSTRAINT IF EXISTS broker_conversations_pending_close_positive;
ALTER TABLE broker_conversations ADD CONSTRAINT broker_conversations_pending_close_positive
  CHECK (pending_close_usd IS NULL OR pending_close_usd > 0);
