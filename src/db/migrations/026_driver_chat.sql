-- 026: driver conversations.
--
-- The thread hangs off a DRIVER, not a load. A broker conversation is
-- about one posting and ends when the load is booked or walked away from;
-- a driver is someone you work with for months. Threading it per load
-- would reset the relationship every time a run finished, which is exactly
-- backwards for the thing this chat exists to carry: a person who has been
-- waiting three weeks for their money remembers, and their dispatcher
-- should have to look at that history.
--
-- This is also where the refusal gets EXPLAINED. It is not where the
-- refusal is decided. dispatchLoad asks driver_settlements and throws
-- DRIVER_REFUSED_WORK; the chat is the person telling you why. If the
-- model were the enforcement, a student could talk it into agreeing and
-- the dispatch would still fail -- and the character would have lied.

CREATE TABLE IF NOT EXISTS driver_conversations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id  text        NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One thread per dispatcher per driver. Opening the panel again
  -- continues the same conversation instead of starting a parallel one.
  CONSTRAINT driver_conversations_one_per_user UNIQUE (driver_id, user_id)
);

CREATE TABLE IF NOT EXISTS driver_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES driver_conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL,
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A driver is driving. They answer when they can stop, which is the
  -- same reason broker_messages has this column: an instant reply removes
  -- the one pressure that makes dispatch a skill.
  deliver_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT driver_messages_role   CHECK (role IN ('dispatcher', 'driver')),
  CONSTRAINT driver_messages_length CHECK (char_length(content) BETWEEN 1 AND 4000)
);

-- The thread query filters on deliver_at, so the index leads with it.
CREATE INDEX IF NOT EXISTS idx_driver_messages_thread
  ON driver_messages (conversation_id, deliver_at);
CREATE INDEX IF NOT EXISTS idx_driver_conversations_user
  ON driver_conversations (user_id, updated_at DESC);
