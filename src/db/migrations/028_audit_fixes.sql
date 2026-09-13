-- Two things the audit found, both of which made something look fine while
-- it was broken.

-- ---------------------------------------------------------------------
-- 1. driver_settlements' foreign keys made the company un-resettable
-- ---------------------------------------------------------------------
--
-- 025 declared both FKs ON DELETE RESTRICT. 026 and 027 use CASCADE, so
-- nothing else in this batch had the problem. Nothing was taught to delete
-- settlements, so `DELETE FROM loads` in scripts/reset-company.js hit the
-- constraint, and because that script wipes inside one transaction the
-- WHOLE reset aborted -- including the opening-balance re-insert. After a
-- single delivered load, handing a fresh company to the next student
-- stopped working. clear-fleet.js and late-proof.js failed the same way.
--
-- CASCADE is also the right meaning rather than just the convenient one: a
-- settlement is a fact ABOUT a load and a driver. Once the load is gone
-- there is nothing left for the row to be a settlement of, and keeping it
-- would leave money owed to nobody for work that no longer exists.
ALTER TABLE driver_settlements
  DROP CONSTRAINT IF EXISTS driver_settlements_load_id_fkey;
ALTER TABLE driver_settlements
  ADD CONSTRAINT driver_settlements_load_id_fkey
  FOREIGN KEY (load_id) REFERENCES loads(id) ON DELETE CASCADE;

ALTER TABLE driver_settlements
  DROP CONSTRAINT IF EXISTS driver_settlements_driver_id_fkey;
ALTER TABLE driver_settlements
  ADD CONSTRAINT driver_settlements_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 2. driver_messages needs to say what kind of message it is
-- ---------------------------------------------------------------------
--
-- replacePendingReply deletes every undelivered driver message and writes
-- one in its place. That is right for the case it was built for -- the
-- dispatcher sends a second question while the first answer is still on
-- its way, and a person reading both at the next stop answers once.
--
-- But the driver thread has a SECOND writer. loadEvents.service.js posts
-- road-event reports ("I am shut down outside Cheyenne") on the same
-- delay, and dispatch.service.js posts refusals. A dispatcher who typed
-- anything while one of those was pending destroyed it. The event stayed
-- visible on the load page and the alert board, so nothing looked broken;
-- the driver simply appeared never to have mentioned it.
--
-- 'text' is a generated reply and is replaceable. 'report' and 'refusal'
-- are things that happened, and nothing may overwrite them.
ALTER TABLE driver_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';

ALTER TABLE driver_messages DROP CONSTRAINT IF EXISTS driver_messages_kind;
ALTER TABLE driver_messages
  ADD CONSTRAINT driver_messages_kind CHECK (kind IN ('text', 'report', 'refusal'));

-- replacePendingReply now filters on kind as well as role, so the index
-- has to carry it or that query drops to a scan of the thread.
DROP INDEX IF EXISTS idx_driver_messages_thread;
CREATE INDEX IF NOT EXISTS idx_driver_messages_thread
  ON driver_messages (conversation_id, deliver_at, kind);
