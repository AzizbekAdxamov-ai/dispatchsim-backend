// SQL for the broker check journal.
import { query } from '../../db/pool.js'

// MC numbers are stored on brokers as text. Matching is exact after
// trimming and upper-casing, and after stripping a leading "MC" and any
// separator — a dispatcher who types "MC-123456", "mc 123456" or "123456"
// is looking up the same carrier, and failing them on punctuation would
// teach nothing about freight.
export async function findBrokerByMc(mcNumber) {
  const result = await query(
    `SELECT id, name, contact_name AS "contactName", mc_number AS "mcNumber",
            credit_rating AS "creditRating", days_to_pay AS "daysToPay"
       FROM brokers
      WHERE upper(regexp_replace(mc_number, '^[Mm][Cc][^0-9]*', '')) =
            upper(regexp_replace($1,        '^[Mm][Cc][^0-9]*', ''))`,
    [mcNumber],
  )
  return result.rows[0] ?? null
}

// Every lookup is recorded, hit or miss. broker_id NULL is a miss, and
// the CHECK in migration 018 keeps the snapshot columns NULL with it.
export async function recordCheck({ userId, mcNumber, broker }) {
  const result = await query(
    `INSERT INTO broker_checks (user_id, mc_number, broker_id, credit_rating, days_to_pay)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, mc_number AS "mcNumber", broker_id AS "brokerId",
               credit_rating AS "creditRating", days_to_pay AS "daysToPay",
               checked_at AS "checkedAt"`,
    [userId, mcNumber, broker?.id ?? null, broker?.creditRating ?? null, broker?.daysToPay ?? null],
  )
  return result.rows[0]
}

// The journal. Joined to brokers for the name, but the rating and payment
// days come from the CHECK row, not from the broker: this is a record of
// what the dispatcher saw when they looked, which is the only thing a log
// is good for.
export async function listChecks(userId, limit = 100) {
  const result = await query(
    `SELECT k.id, k.mc_number AS "mcNumber", k.broker_id AS "brokerId",
            k.credit_rating AS "creditRating", k.days_to_pay AS "daysToPay",
            k.checked_at AS "checkedAt",
            b.name AS "brokerName", b.contact_name AS "brokerContactName"
       FROM broker_checks k
       LEFT JOIN brokers b ON b.id = k.broker_id
      WHERE k.user_id = $1
      ORDER BY k.checked_at DESC
      LIMIT $2`,
    [userId, limit],
  )
  return result.rows
}

// The dispatcher's most recent look at one broker, for the posting panel.
// Returns null when they have never checked this one — which is the state
// the panel should say nothing about beyond offering the link.
export async function latestCheckForBroker(userId, brokerId) {
  if (!brokerId) return null
  const result = await query(
    `SELECT id, credit_rating AS "creditRating", days_to_pay AS "daysToPay",
            checked_at AS "checkedAt"
       FROM broker_checks
      WHERE user_id = $1 AND broker_id = $2
      ORDER BY checked_at DESC
      LIMIT 1`,
    [userId, brokerId],
  )
  return result.rows[0] ?? null
}
