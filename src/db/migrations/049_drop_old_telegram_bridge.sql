-- 049: drop the old telegram bridge's own tables.
--
-- Migration 046/047 built the bridge as a separate process: a link code
-- bound a chat to a user, an outbox row was a claimed send, attachments
-- kept the file side of a photo. The bot folded into this project on
-- 2026-09-29 (src/bot, one process): the chat is named in .env, the reply
-- map lives in the bot's own state file, and nothing in src/ reads or
-- writes any of these four tables any more.
--
-- Proven on 2026-09-30 before this file was written:
--   grep -rn "telegram_links\|telegram_link_codes\|telegram_deliveries\|telegram_attachments"
--     src test   -- only comments, the 046/047 files themselves, and
--                   companyTables.js (whose entries this migration retires
--                   in the same commit).
-- All four were empty (0 rows) when dumped.
--
-- Backup taken before this ran: backups/2026-09-30-telegram-tables.sql
-- (pg_dump of the four tables). The tables are empty today; the dump is
-- the schema, kept because a schema is what a fresh database will never
-- be able to show again.
--
-- telegram_offset and telegram_not_linked in sim_state were the old
-- process's polling bookmark and its "chat not linked yet" notice. The
-- offset key was never written by this project; the notice died with the
-- link flow. Both deleted for every database this file runs on, present
-- or not.

DROP TABLE IF EXISTS telegram_attachments;
DROP TABLE IF EXISTS telegram_deliveries;
DROP TABLE IF EXISTS telegram_link_codes;
DROP TABLE IF EXISTS telegram_links;

DELETE FROM sim_state WHERE key IN ('telegram_offset', 'telegram_not_linked');
