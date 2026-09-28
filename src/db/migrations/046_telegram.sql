-- 046: Telegram bridge -- the transport layer for the driver chat.
--
-- The chat itself already exists (026): threads, delayed replies, the
-- budget. This migration adds only what carrying those messages over
-- Telegram REQUIRES, and deliberately nothing on driver_messages: whether
-- a message reached Telegram is a property of the TRANSPORT, not of the
-- message. A second transport later (WhatsApp) would need a second
-- outbox, not a second column -- and a column that is NULL for every
-- message that never left the app is not a fact anyone can query.
--
-- Three tables:
--
--   telegram_links        which chat belongs to which dispatcher
--   telegram_link_codes   the one-time codes that establish that
--   telegram_deliveries   the outbox: messages claimed for sending
--
-- telegram_deliveries.message_id is the PRIMARY KEY -- that IS the
-- idempotency. "This message was already claimed" is enforced by the
-- database, in a transaction, not by a Set in a job's memory that dies
-- with the process.

CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id            bigint      PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The driver the chat is currently TALKING TO -- set with /d <ism>,
  -- so a plain "ok, on my way" has someone to belong to without a reply.
  -- SET NULL when the driver leaves: the link survives, the assumption
  -- must not.
  current_driver_id  text        REFERENCES drivers(id) ON DELETE SET NULL,
  linked_at          timestamptz NOT NULL DEFAULT now(),
  linked_by_tg_user  bigint      NOT NULL,
  -- One Telegram account is one dispatcher. A second chat claiming the
  -- same user is either a mistake or someone borrowing a seat -- both
  -- are refused here rather than sorted out in a group chat.
  CONSTRAINT telegram_links_one_per_user UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code       text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  -- Six characters from a 30-character alphabet. Anything longer is a
  -- session token, anything shorter is guessable; the format is the
  -- contract the /link command parses, so the DB holds the line too.
  CONSTRAINT telegram_link_codes_fmt CHECK (code ~ '^[A-Z0-9]{6}$')
);

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  message_id          uuid        PRIMARY KEY REFERENCES driver_messages(id) ON DELETE CASCADE,
  chat_id             bigint      NOT NULL,
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  telegram_message_id bigint,
  -- Five tries, then the app says "not delivered" next to the message.
  -- The bound lives in a CHECK so a runaway retry loop fails loudly here
  -- instead of hammering Telegram quietly forever.
  attempts            smallint    NOT NULL DEFAULT 0,
  last_error          text,
  CONSTRAINT telegram_deliveries_attempts CHECK (attempts BETWEEN 0 AND 5)
);

-- The push job's scan: unsent rows, oldest claim first.
CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_pending
  ON telegram_deliveries (claimed_at) WHERE sent_at IS NULL;
-- Reply routing: an incoming "reply to message X" maps back through here.
CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_tg
  ON telegram_deliveries (chat_id, telegram_message_id);
