// Parse-check the hand-written SQL that no test exercises.
//
//   node scripts/sql-check.js
//
// PREPARE makes PostgreSQL parse and plan a statement against the real
// schema without running it: a typo, a wrong column name, or an illegal
// CTE fails here instead of at 2am in a chat window. Everything happens
// inside a transaction that is rolled back, so no row is touched and no
// prepared statement survives.
//
// This exists because replacePendingReply's data-modifying CTE cannot be
// checked by `node --check` -- to Node it is just a string.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'

const STATEMENTS = [
  ['replacePendingReply', `
    WITH pending AS (
      SELECT id, deliver_at FROM broker_messages
       WHERE conversation_id = $1 AND role = 'broker'
         AND kind = 'text' AND deliver_at > now()
    ),
    slot AS (SELECT min(deliver_at) AS deliver_at FROM pending),
    del AS (DELETE FROM broker_messages WHERE id IN (SELECT id FROM pending))
    INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
    SELECT $1, 'broker', $2, 'text', slot.deliver_at
      FROM slot WHERE slot.deliver_at IS NOT NULL
    RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`],

  ['listMessages (delivered only)', `
    SELECT id, role, content, kind, created_at AS "createdAt"
      FROM broker_messages
     WHERE conversation_id = $1 AND deliver_at <= now()
     ORDER BY deliver_at ASC, created_at ASC, id ASC`],

  ['addMessage (delayed)', `
    INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
    VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
    RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`],

  ['setRateCon', `
    UPDATE broker_conversations
       SET rate_con_rate_usd = $2, updated_at = now()
     WHERE id = $1 AND status = 'agreed'
     RETURNING id, rate_con_rate_usd`],

  ['markBooked', `
    UPDATE broker_conversations
       SET status = 'booked', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'agreed'
       AND rate_con_rate_usd IS NOT NULL
     RETURNING id, status`],

  ['clearRateCon (delete)', `
    DELETE FROM broker_messages WHERE conversation_id = $1 AND kind = 'rate_con'`],

  ['rateConDelivered', `
    SELECT EXISTS (
      SELECT 1 FROM broker_messages
       WHERE conversation_id = $1 AND kind = 'rate_con' AND deliver_at <= now()
    ) AS delivered`],

  ['hasPendingReply', `
    SELECT EXISTS (
      SELECT 1 FROM broker_messages
       WHERE conversation_id = $1 AND deliver_at > now()
    ) AS pending`],

  ['getAgreedRate (paper first)', `
    SELECT coalesce(rate_con_rate_usd, agreed_rate_usd) AS rate
      FROM broker_conversations
     WHERE posting_id = $1 AND user_id = $2 AND status IN ('agreed', 'booked')`],

  ['findBrokerByMc', `
    SELECT id, name, contact_name AS "contactName", mc_number AS "mcNumber",
           credit_rating AS "creditRating", days_to_pay AS "daysToPay"
      FROM brokers
     WHERE upper(regexp_replace(mc_number, '^[Mm][Cc][^0-9]*', '')) =
           upper(regexp_replace($1,        '^[Mm][Cc][^0-9]*', ''))`],

  ['recordCheck', `
    INSERT INTO broker_checks (user_id, mc_number, broker_id, credit_rating, days_to_pay)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, mc_number AS "mcNumber", broker_id AS "brokerId",
              credit_rating AS "creditRating", days_to_pay AS "daysToPay",
              checked_at AS "checkedAt"`],

  ['listChecks', `
    SELECT k.id, k.mc_number AS "mcNumber", k.broker_id AS "brokerId",
           k.credit_rating AS "creditRating", k.days_to_pay AS "daysToPay",
           k.checked_at AS "checkedAt",
           b.name AS "brokerName", b.contact_name AS "brokerContactName"
      FROM broker_checks k
      LEFT JOIN brokers b ON b.id = k.broker_id
     WHERE k.user_id = $1
     ORDER BY k.checked_at DESC
     LIMIT $2`],
]

const client = await pool.connect()
let failed = 0

try {
  await client.query('BEGIN')
  for (const [name, sql] of STATEMENTS) {
    try {
      await client.query(`PREPARE chk_${STATEMENTS.findIndex((s) => s[0] === name)} AS ${sql}`)
      console.log(`  ok    ${name}`)
    } catch (err) {
      failed += 1
      console.log(`  FAIL  ${name}`)
      console.log(`        ${err.message}`)
      if (err.position) console.log(`        pozitsiya: ${err.position}`)
    }
  }
} finally {
  // Nothing was executed, and the rollback also drops the prepared names.
  await client.query('ROLLBACK')
  client.release()
  await pool.end()
}

console.log(`\n${STATEMENTS.length - failed}/${STATEMENTS.length} muvaffaqiyatli`)
process.exit(failed ? 1 : 0)
