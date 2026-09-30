// The one query the bot writes for itself. Everything else it needs is
// asked through the modules the app already uses -- driverChat's
// repository and service, payroll, carrier -- because a second way to
// read a conversation is a second way for it to be wrong.
//
// Exported so scripts/sql-check.js can PREPARE it against the real
// schema: it is hand-written SQL that no test with a database exercises
// on every run, which is exactly the kind that rots quietly.

// Driver messages that are due and have not been pushed to the group.
//
// "Due" is deliver_at <= now(): the chat's delay model (026, and
// driverChat.replyTiming.js) decides WHEN a driver answers, and this
// query only notices that the moment has come. Every kind is carried,
// not just 'text' -- a road-event report and a refusal are things that
// happened, and the group is where the dispatcher is reading.
//
// "Not pushed" is the (deliver_at, id) pair being past the watermark the
// bot keeps in its own state file. The pair matters: two replies can
// fall due in the same millisecond, and a timestamp alone would step
// over the second one and never come back for it. Row-wise comparison is
// PostgreSQL's own ordering of the tuple, the same order the ORDER BY
// uses, so "after the last one sent" means one thing in both places.
//
// $1/$2 are that watermark (NULL/NULL on a cold start: send everything
// due, oldest first), $3 the dispatcher whose threads this group is,
// $4 the page size.
export const DUE_DRIVER_MESSAGES_SQL = `
  SELECT m.id,
         m.content,
         m.deliver_at  AS "deliverAt",
         to_char(m.deliver_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                       AS "deliverAtText",
         d.id          AS "driverId",
         d.name        AS "driverName",
         t.id          AS "truckId"
    FROM driver_messages m
    JOIN driver_conversations c ON c.id = m.conversation_id
    JOIN drivers d              ON d.id = c.driver_id
    LEFT JOIN trucks t          ON t.driver_id = d.id
   WHERE m.role = 'driver'
     AND m.deliver_at <= now()
     AND c.user_id = $3
     AND ($1::timestamptz IS NULL OR (m.deliver_at, m.id) > ($1::timestamptz, $2::uuid))
   ORDER BY m.deliver_at, m.id
   LIMIT $4`

// The account whose threads this bot speaks for, by email.
//
// One row, read once at boot. This replaces the /link handshake: a code
// typed into a group used to bind a chat to a user because any student
// could be on the other end. One dispatcher, one group, one line in
// .env -- and a wrong address stops the bot at boot instead of at the
// first message.
export const DISPATCHER_BY_EMAIL_SQL = `
  SELECT id, email, name FROM users WHERE email = lower($1)`

// -- The roster ----------------------------------------------------------
//
// Three small reads, moved here from telegram.sql.js when the bridge was
// taken apart. They are the only part of that module the bot still
// needed, and leaving them there would have kept 350 lines of link
// codes, delivery claims and offset bookkeeping alive to carry them.

export const DRIVERS_BY_NAME_SQL = `
  SELECT id, name FROM drivers WHERE lower(name) = lower($1) ORDER BY id`

// The standing /d choice re-checked: the driver still exists (a driver
// who quit must not silently catch messages).
export const DRIVER_BY_ID_SQL = `
  SELECT id, name FROM drivers WHERE id = $1`

// The roster /drivers and ask-who print.
export const DRIVERS_LIST_SQL = `
  SELECT id, name, duty_status AS "dutyStatus" FROM drivers ORDER BY name`
