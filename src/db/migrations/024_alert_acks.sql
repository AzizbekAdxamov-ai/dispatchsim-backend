-- Acknowledgements. Not alerts.
--
-- An alert is a CONDITION, and a condition is answered by asking the data,
-- not by remembering an answer from before. If alert rows were stored, the
-- moment a student paid an invoice there would be a stale row saying it was
-- overdue, and a cleanup job whose failure nobody would notice. Every alert
-- in this system is derived on read; when the condition stops being true,
-- the alert is gone with no cleanup at all.
--
-- The one thing that CANNOT be derived is "I have seen this and I am
-- choosing to live with it". That is a decision, it belongs to a person,
-- and it is the only thing this table holds.

CREATE TABLE IF NOT EXISTS alert_acks (
  -- Which alert. 'load.late:4471', 'cash.negative' -- the family plus the
  -- entity it is about, so acknowledging one late load does not silence
  -- the others.
  alert_key   text        NOT NULL,

  -- What was true when it was acknowledged.
  --
  -- Without this, "I know load 4471 is running behind" would keep the load
  -- silent after it went from behind to actually late -- the student would
  -- have dismissed a smaller fact and stopped hearing a larger one. Each
  -- alert family decides what a material change is and says so in its own
  -- definition; when the fingerprint differs from the acknowledged one, the
  -- alert speaks again.
  fingerprint text        NOT NULL,

  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acked_at    timestamptz NOT NULL DEFAULT now(),

  -- One acknowledgement per alert per person. Acknowledging the same alert
  -- twice replaces the fingerprint rather than adding a row, so the table
  -- stays the size of the board and not the size of the history.
  PRIMARY KEY (user_id, alert_key),

  CONSTRAINT alert_acks_key_shape CHECK (alert_key ~ '^[a-z]+\.[a-z-]+(:[A-Za-z0-9_-]+)?$'),
  CONSTRAINT alert_acks_fp_len    CHECK (char_length(fingerprint) BETWEEN 1 AND 200)
);

-- The read path is always "everything this user has acknowledged", because
-- the alert list is assembled in one pass and filtered in memory -- there
-- are tens of alerts, not thousands, and a join per alert family would be
-- more machinery than the problem deserves.
CREATE INDEX IF NOT EXISTS alert_acks_user_idx ON alert_acks (user_id);
