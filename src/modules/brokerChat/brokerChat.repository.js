// SQL for broker conversations. One table pair: broker_conversations holds
// the thread and the agreed rate, broker_messages holds the turns.
import { query } from '../../db/pool.js'

const CONVERSATION_COLUMNS = `
  c.id, c.posting_id AS "postingId", c.user_id AS "userId",
  c.agreed_rate_usd AS "agreedRateUsd", c.status,
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"
`

// The posting plus its broker profile — everything the prompt needs, in one
// round trip. Returns null when the posting is gone, expired, or has not
// dripped onto the board yet.
export async function getPostingWithBroker(postingId) {
  const result = await query(
    `SELECT p.id, p.origin_city AS "originCity", p.origin_state AS "originState",
            p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
            p.commodity, p.rate_usd AS "rateUsd", p.distance_mi AS "distanceMi",
            p.weight_lbs AS "weightLbs", p.equipment_type AS "equipmentType",
            p.equipment_length_ft AS "equipmentLengthFt",
            p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
            p.status, p.posted_at AS "postedAt", p.expires_at AS "expiresAt",
            b.id AS "brokerId", b.name, b.contact_name AS "contactName",
            b.persona, b.credit_rating AS "creditRating",
            b.mc_number AS "mcNumber", b.days_to_pay AS "daysToPay"
       FROM load_postings p
       LEFT JOIN brokers b ON b.id = p.broker_id
      WHERE p.id = $1`,
    [postingId],
  )
  return result.rows[0] ?? null
}

// Find or create the thread. ON CONFLICT makes this safe to call from two
// tabs at once — the unique index (posting_id, user_id) is what guarantees
// one thread per dispatcher per posting.
export async function openConversation(postingId, userId) {
  const result = await query(
    `INSERT INTO broker_conversations (posting_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (posting_id, user_id) DO UPDATE SET updated_at = now()
     RETURNING ${CONVERSATION_COLUMNS.replaceAll('c.', '')}`,
    [postingId, userId],
  )
  return result.rows[0]
}

export async function getConversation(conversationId, userId) {
  const result = await query(
    `SELECT ${CONVERSATION_COLUMNS} FROM broker_conversations c
      WHERE c.id = $1 AND c.user_id = $2`,
    [conversationId, userId],
  )
  return result.rows[0] ?? null
}

export async function listMessages(conversationId) {
  const result = await query(
    `SELECT id, role, content, created_at AS "createdAt"
       FROM broker_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [conversationId],
  )
  return result.rows
}

export async function addMessage(conversationId, role, content) {
  const result = await query(
    `INSERT INTO broker_messages (conversation_id, role, content)
     VALUES ($1, $2, $3)
     RETURNING id, role, content, created_at AS "createdAt"`,
    [conversationId, role, content],
  )
  await query('UPDATE broker_conversations SET updated_at = now() WHERE id = $1', [conversationId])
  return result.rows[0]
}

// Record the rate the dispatcher says they settled on. Deliberately NOT
// parsed out of the broker's prose: reading a number out of free text is
// fragile, and a wrong number here silently changes what the load is worth.
// The dispatcher states it, the constraint keeps it honest.
export async function setAgreedRate(conversationId, userId, rateUsd) {
  const result = await query(
    `UPDATE broker_conversations
        SET agreed_rate_usd = $3, status = 'agreed', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status <> 'closed'
      RETURNING ${CONVERSATION_COLUMNS.replaceAll('c.', '')}`,
    [conversationId, userId, rateUsd],
  )
  return result.rows[0] ?? null
}

// Messages this user sent today, for the daily cap. Counts only dispatcher
// turns — a broker reply is a consequence of one, never its own cost.
export async function countTodaysMessages(userId) {
  const result = await query(
    `SELECT count(*)::int AS n
       FROM broker_messages m
       JOIN broker_conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1
        AND m.role = 'dispatcher'
        AND m.created_at >= date_trunc('day', now())`,
    [userId],
  )
  return result.rows[0].n
}

// The dispatcher's threads, newest activity first. Joined to the posting so
// the list can show what each conversation is about without N+1 lookups.
export async function listConversations(userId) {
  const result = await query(
    `SELECT c.id, c.posting_id AS "postingId", c.agreed_rate_usd AS "agreedRateUsd",
            c.status, c.updated_at AS "updatedAt",
            p.origin_city AS "originCity", p.origin_state AS "originState",
            p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
            p.rate_usd AS "rateUsd", p.distance_mi AS "distanceMi",
            p.equipment_type AS "equipmentType",
            p.status AS "postingStatus", p.expires_at AS "expiresAt",
            b.name AS "brokerName", b.contact_name AS "brokerContactName",
            b.credit_rating AS "brokerCreditRating",
            (SELECT content FROM broker_messages m
              WHERE m.conversation_id = c.id
              ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage",
            (SELECT count(*)::int FROM broker_messages m WHERE m.conversation_id = c.id) AS "messageCount"
       FROM broker_conversations c
       JOIN load_postings p ON p.id = c.posting_id
       LEFT JOIN brokers b ON b.id = p.broker_id
      WHERE c.user_id = $1
      ORDER BY c.updated_at DESC
      LIMIT 50`,
    [userId],
  )
  return result.rows
}

// Full conversation data for rate confirmation PDF generation.
// Joins conversation → posting → broker in one round trip.
export async function getConversationForPDF(conversationId, userId) {
  const result = await query(
    `SELECT c.id, c.agreed_rate_usd AS "agreedRateUsd", c.status,
            c.updated_at AS "updatedAt",
            p.id AS "postingId", p.origin_city AS "originCity",
            p.origin_state AS "originState",
            p.destination_city AS "destinationCity",
            p.destination_state AS "destinationState",
            p.commodity, p.rate_usd AS "rateUsd",
            p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
            p.equipment_type AS "equipmentType",
            p.equipment_length_ft AS "equipmentLengthFt",
            p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
            p.booked_load_id AS "bookedLoadId",
            b.name AS "brokerName", b.contact_name AS "brokerContactName",
            b.mc_number AS "mcNumber", b.credit_rating AS "creditRating",
            b.days_to_pay AS "daysToPay"
       FROM broker_conversations c
       JOIN load_postings p ON p.id = c.posting_id
       LEFT JOIN brokers b ON b.id = p.broker_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [conversationId, userId],
  )
  return result.rows[0] ?? null
}

// The agreed rate for a posting, if this dispatcher negotiated one. Read at
// booking time so the number they settled on is what the load is worth.
export async function getAgreedRate(client, postingId, userId) {
  const result = await client.query(
    `SELECT agreed_rate_usd FROM broker_conversations
      WHERE posting_id = $1 AND user_id = $2 AND status = 'agreed'`,
    [postingId, userId],
  )
  return result.rows[0]?.agreed_rate_usd ?? null
}
