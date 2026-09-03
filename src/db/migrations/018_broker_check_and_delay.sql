-- 018: three product changes decided 2026-09-02.
--
-- 1. The board stops showing the broker's credit rating and payment days.
--    Only the MC number appears. The rating is something the dispatcher
--    GOES AND CHECKS -- broker_checks is where that lookup is recorded.
--    A dispatcher who skips the check books blind and feels it in finance
--    two months later. That is the lesson; the board must not spoil it.
--
-- 2. There is no "book load" button any more. A load comes into existence
--    when the broker sends a rate confirmation and the dispatcher accepts
--    it. That is the real sequence, and it makes the paper -- not the
--    conversation -- the thing that decides what the load is worth.
--
-- 3. A broker does not answer in one second. broker_messages.deliver_at
--    holds a reply back until it is due. The delay is derived from the
--    broker's own credit rating, so waiting becomes information the
--    dispatcher earns rather than a number the program prints.

-- ---------------------------------------------------------------------
-- 1. Broker checks (the MC lookup journal)
-- ---------------------------------------------------------------------

-- One row per lookup, not one per broker: this is a log of what the
-- dispatcher did, so a re-check months later is a second entry, not an
-- overwrite. credit_rating and days_to_pay are SNAPSHOTS -- what the
-- lookup returned at the time -- for the same reason.
--
-- broker_id NULL means the MC number matched nothing. That is a real
-- outcome worth recording: a dispatcher who looks up a number and finds
-- no carrier record has learned something.
CREATE TABLE IF NOT EXISTS broker_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mc_number     text NOT NULL,
  broker_id     uuid NULL REFERENCES brokers(id) ON DELETE SET NULL,
  credit_rating text NULL,
  days_to_pay   integer NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checks_mc_len CHECK (char_length(mc_number) BETWEEN 1 AND 32),
  CONSTRAINT checks_rating CHECK (credit_rating IS NULL OR credit_rating IN ('A','B','C','D')),
  -- A hit carries the snapshot; a miss carries nothing to snapshot.
  CONSTRAINT checks_hit_clean CHECK (
    (broker_id IS NULL) = (credit_rating IS NULL AND days_to_pay IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_broker_checks_journal
  ON broker_checks (user_id, checked_at DESC);

-- Lookup for "have I checked this broker?" on the posting panel.
CREATE INDEX IF NOT EXISTS idx_broker_checks_broker
  ON broker_checks (user_id, broker_id, checked_at DESC);

-- ---------------------------------------------------------------------
-- 2. Delayed and typed messages
-- ---------------------------------------------------------------------

-- deliver_at defaults to now(), so every message already in the table
-- stays visible and dispatcher turns need no special handling -- what
-- you type appears the moment you send it. Only broker replies get a
-- future value.
ALTER TABLE broker_messages
  ADD COLUMN IF NOT EXISTS deliver_at timestamptz NOT NULL DEFAULT now();

-- 'rate_con' is the message that carries the rate confirmation. It is a
-- kind of message rather than its own table because it arrives in the
-- thread, in order, like anything else the broker sends.
ALTER TABLE broker_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';

ALTER TABLE broker_messages DROP CONSTRAINT IF EXISTS messages_kind;
ALTER TABLE broker_messages
  ADD CONSTRAINT messages_kind CHECK (kind IN ('text', 'rate_con'));

-- The thread query filters on deliver_at, so the index has to lead with it.
CREATE INDEX IF NOT EXISTS idx_broker_messages_due
  ON broker_messages (conversation_id, deliver_at);

-- ---------------------------------------------------------------------
-- 3. Rate confirmation on the conversation
-- ---------------------------------------------------------------------

-- The number the PAPER says, which is not always the number that was
-- agreed. A rate con that quietly comes back low is one of the oldest
-- traps in freight, and the load is created at THIS value -- reading the
-- document before accepting it is the whole point of the step.
ALTER TABLE broker_conversations
  ADD COLUMN IF NOT EXISTS rate_con_rate_usd integer NULL;

ALTER TABLE broker_conversations DROP CONSTRAINT IF EXISTS conversations_status;
ALTER TABLE broker_conversations
  ADD CONSTRAINT conversations_status
  CHECK (status IN ('open', 'agreed', 'booked', 'closed'));

-- Replaces conversations_agreed_clean, which said `(status = 'agreed') =
-- (agreed_rate_usd IS NOT NULL)` and would reject every booked thread.
ALTER TABLE broker_conversations DROP CONSTRAINT IF EXISTS conversations_agreed_clean;
ALTER TABLE broker_conversations
  ADD CONSTRAINT conversations_agreed_clean CHECK (
    CASE status
      WHEN 'open'   THEN agreed_rate_usd IS NULL
      WHEN 'agreed' THEN agreed_rate_usd IS NOT NULL
      WHEN 'booked' THEN agreed_rate_usd IS NOT NULL
      ELSE true
    END
  );

ALTER TABLE broker_conversations DROP CONSTRAINT IF EXISTS conversations_ratecon_range;
ALTER TABLE broker_conversations
  ADD CONSTRAINT conversations_ratecon_range
  CHECK (rate_con_rate_usd IS NULL OR rate_con_rate_usd BETWEEN 100 AND 20000);

-- A booked thread must have the paper it was booked from.
ALTER TABLE broker_conversations DROP CONSTRAINT IF EXISTS conversations_booked_has_ratecon;
ALTER TABLE broker_conversations
  ADD CONSTRAINT conversations_booked_has_ratecon
  CHECK (status <> 'booked' OR rate_con_rate_usd IS NOT NULL);
