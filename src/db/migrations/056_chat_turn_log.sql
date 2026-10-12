-- 056: every chat turn the models answer, with what they answered from.
--
-- Azizbek, 2026-10-09: the AIs are to be trained on their own record --
-- what was asked, what data the model had, what it said, whether that was
-- right. The threads (broker_messages, driver_messages) keep only the two
-- texts; the data behind the answer (the system prompt: the load, the
-- market, the terms, the driver's day) was built per turn and thrown away.
-- A reply without its prompt cannot be judged ("was that number in what it
-- was told?") and cannot be replayed against a better prompt or model.
--
-- One row per dispatcher turn, written by the chat services after the
-- turn ends, failed turns included (reply NULL, error set) -- a failure is
-- part of the record too. No foreign keys on purpose: a thread can be
-- reset, and the record of how the model behaved in it is still wanted.
--
-- human_grade / human_note: filled when someone grades the turn.

CREATE TABLE IF NOT EXISTS chat_turn_log (
  id                  bigserial   PRIMARY KEY,
  chat                text        NOT NULL,
  conversation_id     uuid        NOT NULL,
  dispatcher_message  uuid        NULL,
  user_id             uuid        NULL,
  model               text        NOT NULL,
  prompt_version      text        NOT NULL,
  system_prompt       text        NOT NULL,
  history             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  dispatcher_text     text        NOT NULL,
  image_count         smallint    NOT NULL DEFAULT 0,
  reply               text        NULL,
  regenerated_because text        NULL,
  fell_back           boolean     NOT NULL DEFAULT false,
  error               text        NULL,
  provider_requests   smallint    NOT NULL DEFAULT 0,
  findings            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  human_grade         text        NULL,
  human_note          text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_turn_log_chat CHECK (chat IN ('broker', 'driver')),
  CONSTRAINT chat_turn_log_grade CHECK (human_grade IS NULL OR human_grade IN ('yes', 'partly', 'no')),
  -- A turn either answered or failed, never both and never neither.
  CONSTRAINT chat_turn_log_outcome CHECK ((reply IS NULL) <> (error IS NULL))
);

CREATE INDEX IF NOT EXISTS chat_turn_log_created ON chat_turn_log (created_at);
