-- 016: broker conversations.
--
-- The conversation hangs off a POSTING, not a load. That follows from the
-- product decision (2026-08-31): a dispatcher talks to the broker BEFORE
-- booking — negotiates the rate, asks about the lane, then decides. Hanging
-- it off the load would mean the talking only starts after the commitment,
-- which is backwards from how the job actually works.
--
-- Because negotiation happens first, the conversation is where the agreed
-- rate lives. Booking reads `agreed_rate_usd` when it is set; without that
-- column the negotiation would be theatre with no effect on anything.

CREATE TABLE IF NOT EXISTS broker_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id      uuid NOT NULL REFERENCES load_postings(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL until the broker and the dispatcher settle on a number.
  agreed_rate_usd integer NULL,
  status          text NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One conversation per dispatcher per posting. Re-opening the panel
  -- continues the same thread instead of starting a parallel one.
  CONSTRAINT conversations_one_per_user UNIQUE (posting_id, user_id),
  CONSTRAINT conversations_status CHECK (status IN ('open', 'agreed', 'closed')),
  CONSTRAINT conversations_rate CHECK (agreed_rate_usd IS NULL OR agreed_rate_usd BETWEEN 100 AND 20000),
  -- 'agreed' and a rate go together: an agreement with no number is not an
  -- agreement, and a number without agreement has nothing to justify it.
  CONSTRAINT conversations_agreed_clean CHECK ((status = 'agreed') = (agreed_rate_usd IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS broker_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES broker_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_role CHECK (role IN ('dispatcher', 'broker')),
  CONSTRAINT messages_length CHECK (char_length(content) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS idx_broker_messages_thread
  ON broker_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_broker_conversations_user
  ON broker_conversations (user_id, updated_at DESC);
