-- 047: telegram attachments -- the file side of incoming photos.
--
-- The message TEXT lands in driver_messages like any other turn (with a
-- "[photo] " prefix, so the app thread shows what arrived). The bytes
-- never enter the database: Telegram keeps the file, this table keeps
-- only the reference needed to understand what the row means.
--
-- A row exists per photo a dispatcher sent through the bridge. Media
-- groups can carry several photos for one caption, so message_id is not
-- unique -- each photo gets its row, each shares the caption.

CREATE TABLE IF NOT EXISTS telegram_attachments (
  id          bigserial   PRIMARY KEY,
  message_id  uuid        NOT NULL REFERENCES driver_messages(id) ON DELETE CASCADE,
  -- Telegram's file_id: a handle, not a URL and not the bytes. It is
  -- what getFile needs if the photo must be looked at again.
  file_id     text        NOT NULL,
  -- Telegram photos arrive as JPEG; the column exists so a later
  -- transport (document, video note) does not have to guess.
  mime        text        NOT NULL DEFAULT 'image/jpeg',
  caption     text        NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_attachments_message
  ON telegram_attachments (message_id);
