// Every SQL string the Telegram bridge runs. scripts/sql-check.js PREPAREs
// each export, so a query added here is parsed against the real schema
// without anyone remembering to register it.
//
// The outbox's shape is fixed by 046: a message enters telegram_deliveries
// exactly once (message_id is the PRIMARY KEY -- that is the idempotency),
// leaves marked sent, or stays with a counted attempt.

// -- Links ---------------------------------------------------------------

// The chat that just proved itself with a code becomes this user's chat.
// Re-linking with a new code replaces the row: one user, one chat, and
// the latest /link is the one the user means. chat_id is the PK, so a
// second user claiming the same chat OVERWRITES it -- the chat's latest
// proof wins, which is the only safe reading of two codes from one chat.
export const INSERT_LINK_SQL = `
  INSERT INTO telegram_links (chat_id, user_id, current_driver_id, linked_by_tg_user)
  VALUES ($1, $2, NULL, $3)
  ON CONFLICT (chat_id) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         current_driver_id = NULL,
         linked_at = now(),
         linked_by_tg_user = EXCLUDED.linked_by_tg_user
  RETURNING chat_id, user_id AS "userId", current_driver_id AS "currentDriverId",
            linked_at AS "linkedAt", linked_by_tg_user AS "linkedByTgUser"`

export const GET_LINK_BY_CHAT_SQL = `
  SELECT chat_id, user_id AS "userId", current_driver_id AS "currentDriverId",
         linked_at AS "linkedAt", linked_by_tg_user AS "linkedByTgUser"
    FROM telegram_links
   WHERE chat_id = $1`

export const GET_LINK_BY_USER_SQL = `
  SELECT chat_id, user_id AS "userId", current_driver_id AS "currentDriverId",
         linked_at AS "linkedAt", linked_by_tg_user AS "linkedByTgUser"
    FROM telegram_links
   WHERE user_id = $1`

// Unlinking forgets the chat but not the code history: the rows are gone,
// any old code left unused simply expires.
export const DELETE_LINK_SQL = `
  DELETE FROM telegram_links WHERE chat_id = $1 RETURNING chat_id`

// /d <ism> -- who the chat is currently talking to.
export const SET_CURRENT_DRIVER_SQL = `
  UPDATE telegram_links SET current_driver_id = $2 WHERE chat_id = $1
  RETURNING current_driver_id AS "currentDriverId"`

// -- Link codes ----------------------------------------------------------

export const INSERT_CODE_SQL = `
  INSERT INTO telegram_link_codes (code, user_id, expires_at)
  VALUES ($1, $2, $3)
  RETURNING code, user_id AS "userId", expires_at AS "expiresAt"`

// The one read the /link command does. Used or expired codes are the same
// "no such code" to the person typing it.
export const FIND_VALID_CODE_SQL = `
  SELECT code, user_id AS "userId"
    FROM telegram_link_codes
   WHERE code = $1 AND used_at IS NULL AND expires_at > now()`

// Consume the code. The WHERE repeats the validity check so two messages
// carrying the same code in the same second cannot both link -- the
// second update matches no row, and the caller treats that as already used.
export const MARK_CODE_USED_SQL = `
  UPDATE telegram_link_codes SET used_at = now()
   WHERE code = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING user_id AS "userId"`

// -- Outbox ---------------------------------------------------------------

// The claim. INSERT ... ON CONFLICT DO NOTHING RETURNING: a row back means
// this tick owns the message; no row means someone else already claimed it.
// The primary key does the serialising, not a check-then-insert.
export const CLAIM_DELIVERY_SQL = `
  INSERT INTO telegram_deliveries (message_id, chat_id)
  VALUES ($1, $2)
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id`

export const MARK_SENT_SQL = `
  UPDATE telegram_deliveries
     SET sent_at = now(), telegram_message_id = $2, last_error = NULL
   WHERE message_id = $1 AND sent_at IS NULL
  RETURNING message_id`

// One more try, counted. The claim stays -- a failed send must never be
// re-scanned as fresh, and attempts < 5 is what lets it be retried.
// The WHERE also refuses to count a row that already sent: a send that
// succeeded but whose confirmation was lost is marked sent, not retried.
export const MARK_FAILED_SQL = `
  UPDATE telegram_deliveries
     SET attempts = attempts + 1, last_error = $2
   WHERE message_id = $1 AND sent_at IS NULL AND attempts < 5
  RETURNING message_id, attempts`

// Messages the driver has "said" that no outbox row exists for yet. The
// chat comes from the writer's link, via the conversation's user -- a
// thread whose dispatcher has no chat is simply never scanned out.
// One shape here and in RETRY_MESSAGES_SQL, so the push job consumes both
// with one function.
export const PENDING_MESSAGES_SQL = `
  SELECT m.id AS "messageId", l.chat_id AS "chatId",
         d.name AS "driverName", t.id AS "truckId",
         m.content, m.deliver_at AS "deliverAt"
    FROM driver_messages m
    JOIN driver_conversations c ON c.id = m.conversation_id
    JOIN telegram_links l ON l.user_id = c.user_id
    JOIN drivers d ON d.id = c.driver_id
    LEFT JOIN trucks t ON t.driver_id = d.id
    LEFT JOIN telegram_deliveries td ON td.message_id = m.id
   WHERE m.role = 'driver' AND m.deliver_at <= now() AND td.message_id IS NULL
   ORDER BY m.deliver_at ASC, m.created_at ASC
   LIMIT $1`

// Claimed but FAILED-AND-COUNTED rows, with tries left: the retry pass.
//
// last_error IS NOT NULL is the gate, and it is the whole point: a row
// with a counted error is known not to have arrived, while a row whose
// send never reported anything (the process died between the API call
// and the mark) MAY be out already. Re-sending that one is the worse
// lie -- the driver says everything twice -- so it is left alone, and
// the cost is only that reply-routing cannot find it (046's comment
// names this trade).
export const RETRY_MESSAGES_SQL = `
  SELECT td.message_id AS "messageId", td.chat_id AS "chatId",
         d.name AS "driverName", t.id AS "truckId",
         m.content, m.deliver_at AS "deliverAt"
    FROM telegram_deliveries td
    JOIN driver_messages m ON m.id = td.message_id
    JOIN driver_conversations c ON c.id = m.conversation_id
    JOIN drivers d ON d.id = c.driver_id
    LEFT JOIN trucks t ON t.driver_id = d.id
   WHERE td.sent_at IS NULL AND td.last_error IS NOT NULL AND td.attempts < 5
   ORDER BY td.claimed_at ASC
   LIMIT $1`

// -- Incoming -------------------------------------------------------------

// A reply to one of the bot's messages names its thread: the outbox row
// the Telegram message id belongs to, and the conversation behind it.
// The link the reply points AT decides, so the dispatcher never has to
// say who they mean when they answer a driver directly.
export const REPLY_TARGET_SQL = `
  SELECT td.message_id AS "messageId", c.id AS "conversationId",
         c.driver_id AS "driverId", c.user_id AS "userId"
    FROM telegram_deliveries td
    JOIN driver_messages m ON m.id = td.message_id
    JOIN driver_conversations c ON c.id = m.conversation_id
   WHERE td.chat_id = $1 AND td.telegram_message_id = $2
   ORDER BY td.claimed_at DESC
   LIMIT 1`

// The thread's delivery facts, for the badge on undeliverable messages:
// nothing about delivery lives on driver_messages, so the read joins.
export const THREAD_DELIVERY_SQL = `
  SELECT td.message_id AS "messageId", td.sent_at AS "sentAt", td.attempts
    FROM telegram_deliveries td
    JOIN driver_messages m ON m.id = td.message_id
   WHERE m.conversation_id = $1`
