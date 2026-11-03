-- 067: broker blocks after a carrier cancels an agreed/booked load.
-- The default duration is a pending Azizbek decision (2026-11-04).
CREATE TABLE IF NOT EXISTS broker_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id boolean NOT NULL DEFAULT true REFERENCES carrier(id),
  broker_id uuid NULL REFERENCES brokers(id) ON DELETE CASCADE,
  broker_mc text NULL,
  broker_contact text NULL,
  blocked_until timestamptz NOT NULL,
  reason text NOT NULL,
  conversation_id uuid NULL REFERENCES broker_conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_blocks_reason_nonempty CHECK (char_length(trim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_broker_blocks_active
  ON broker_blocks (carrier_id, broker_id, blocked_until);
