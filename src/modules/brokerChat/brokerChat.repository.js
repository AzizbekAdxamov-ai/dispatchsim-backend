// SQL for broker conversations. One table pair: broker_conversations holds
// the thread and the agreed rate, broker_messages holds the turns.
import { query, withTransaction } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import { chatIntent } from './negotiation.js'
import { rateQuote, ALL_IN } from './rateQuote.js'
import { blockUntil, BROKER_BLOCK_DAYS, BLOCK_REASON_CARRIER_CANCEL } from './blockPolicy.js'

// rate_con_rate_usd is deliberately ABSENT here.
//
// This constant feeds every conversation payload the client receives, and
// the number on the paper is not the dispatcher's to know until the paper
// arrives. Shipping it on the Agree response handed away the whole point
// of the rate confirmation: a broker whose document comes back 3-8% light
// (replyTiming.rateConAmount) was exposed in the JSON minutes before the
// message was delivered, so the only reader who ever fell for the trap
// was one who did not open dev tools.
//
// Booking reads it server-side through getAgreedRate, and the PDF prints
// it once rateConDelivered() says the broker has sent it.
const CONVERSATION_COLUMNS = `
  c.id, c.posting_id AS "postingId", c.user_id AS "userId",
  c.agreed_rate_usd AS "agreedRateUsd", c.status,
  c.negotiation_stage AS "negotiationStage", c.broker_offer_usd AS "brokerOfferUsd",
  c.recipient_email AS "recipientEmail", c.rate_push_count AS "ratePushCount",
  c.best_counter_used AS "bestCounterUsed", c.negotiation_revision AS "negotiationRevision",
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
            -- The broker knows the number whether or not the board printed
            -- it. This is the one place rate_usd is read unsuppressed, and
            -- it is correct: a "call for rate" load has a rate, and the
            -- whole point is that you have to ask the person who knows it.
            p.rate_hidden AS "rateHidden",
            p.rate_basis AS "rateBasis", p.fuel_surcharge_usd AS "fuelSurchargeUsd",
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

// Only what has actually arrived. A broker reply sits in the table with a
// future deliver_at and is invisible until it comes due -- the wait is
// enforced in the database, so closing the tab, reloading, or opening a
// second window cannot skip it.
export async function listMessages(conversationId) {
  const result = await query(
    `SELECT id, role, content, kind, created_at AS "createdAt"
       FROM broker_messages
      WHERE conversation_id = $1 AND deliver_at <= now()
      ORDER BY deliver_at ASC, created_at ASC, id ASC`,
    [conversationId],
  )
  return result.rows
}

// Is a reply written but not yet due? The UI shows a waiting state from
// this -- never the remaining seconds, which would turn the broker's
// silence back into a number the program prints.
export async function hasPendingReply(conversationId) {
  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM broker_messages
        WHERE conversation_id = $1 AND deliver_at > now()
     ) AS pending`,
    [conversationId],
  )
  return result.rows[0].pending
}

// delaySec is seconds from now until the message becomes visible. A
// dispatcher's own words always pass 0 -- what you type appears when you
// type it.
export async function addMessage(conversationId, role, content, { kind = 'text', delaySec = 0 } = {}) {
  const result = await query(
    `INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`,
    [conversationId, role, content, kind, delaySec],
  )
  await query('UPDATE broker_conversations SET updated_at = now() WHERE id = $1', [conversationId])
  return result.rows[0]
}

// A second message sent while a reply is still in flight must NOT queue a
// second reply. Somebody who types "hello" three times because nothing has
// come back yet would otherwise get three answers to one greeting, each
// costing its own model call.
//
// Instead the new reply takes the pending one's DELIVERY SLOT: the broker
// still answers once, at the moment they were always going to, and the
// answer accounts for everything that was said. Which is what a real
// broker does -- they read the whole thread when they finally get to it.
//
// One statement, so the delete and the insert cannot interleave with
// another send. Data-modifying CTEs always run to completion in Postgres,
// so `del` fires even though the outer query does not read it. Returns
// undefined when nothing was pending, and the caller then schedules a
// fresh delay. Pending rate confirmations are left alone (kind = 'text').
export async function replacePendingReply(conversationId, content) {
  const result = await query(
    `WITH pending AS (
       SELECT id, deliver_at FROM broker_messages
        WHERE conversation_id = $1 AND role = 'broker'
          AND kind = 'text' AND deliver_at > now()
     ),
     slot AS (SELECT min(deliver_at) AS deliver_at FROM pending),
     del AS (DELETE FROM broker_messages WHERE id IN (SELECT id FROM pending))
     INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
     SELECT $1, 'broker', $2, 'text', slot.deliver_at
       FROM slot WHERE slot.deliver_at IS NOT NULL
     RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`,
    [conversationId, content],
  )
  return result.rows[0] ?? null
}

// Record the rate the dispatcher says they settled on. Deliberately NOT
// parsed out of the broker's prose: reading a number out of free text is
// fragile, and a wrong number here silently changes what the load is worth.
// The dispatcher states it, the constraint keeps it honest.
export async function setAgreedRate(conversationId, userId, rateUsd) {
  const result = await query(
    `UPDATE broker_conversations
        SET agreed_rate_usd = $3, status = 'agreed', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('open', 'agreed')
      RETURNING ${CONVERSATION_COLUMNS.replaceAll('c.', '')}`,
    [conversationId, userId, rateUsd],
  )
  return result.rows[0] ?? null
}

// Messages this user sent today, for the daily cap. Counts only dispatcher
// turns — a broker reply is a consequence of one, never its own cost.
// The per-chat daily counter that used to live here is gone -- see
// src/modules/chat/chatBudget.sql.js. It counted the broker chat against
// its own cap of 60 while the driver chat counted itself against another
// 60, on one key rated for fewer requests than the two of them together.

// The dispatcher's threads, newest activity first. Joined to the posting so
// the list can show what each conversation is about without N+1 lookups.
export async function listConversations(userId) {
  const result = await query(
    `SELECT c.id, c.posting_id AS "postingId", c.agreed_rate_usd AS "agreedRateUsd",
            c.status, c.updated_at AS "updatedAt",
            p.origin_city AS "originCity", p.origin_state AS "originState",
            p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
            CASE WHEN p.rate_hidden THEN NULL ELSE p.rate_usd END AS "rateUsd", p.distance_mi AS "distanceMi",
            CASE WHEN p.rate_hidden THEN NULL ELSE p.rate_basis END AS "rateBasis",
            CASE WHEN p.rate_hidden THEN NULL ELSE p.fuel_surcharge_usd END AS "fuelSurchargeUsd",
            p.equipment_type AS "equipmentType",
            p.status AS "postingStatus", p.expires_at AS "expiresAt",
            b.name AS "brokerName", b.contact_name AS "brokerContactName",
            -- No credit_rating here. The rating is something the dispatcher
            -- looks up in Broker Check; a thread list that prints it hands
            -- back exactly what the board stopped giving away.
            (SELECT content FROM broker_messages m
              WHERE m.conversation_id = c.id AND m.deliver_at <= now()
              ORDER BY m.deliver_at DESC LIMIT 1) AS "lastMessage",
            (SELECT count(*)::int FROM broker_messages m
              WHERE m.conversation_id = c.id AND m.deliver_at <= now()) AS "messageCount",
            EXISTS (SELECT 1 FROM broker_messages m
                     WHERE m.conversation_id = c.id AND m.deliver_at > now()) AS "awaitingReply"
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
    `SELECT c.id, c.agreed_rate_usd AS "agreedRateUsd",
            c.rate_con_rate_usd AS "rateConRateUsd", c.status, c.recipient_email AS "recipientEmail",
            c.rate_con_basis AS "rateConBasis", c.rate_con_fuel_surcharge_usd AS "rateConFuelSurchargeUsd",
            c.updated_at AS "updatedAt",
            p.id AS "postingId", p.origin_city AS "originCity",
            p.origin_state AS "originState",
            p.destination_city AS "destinationCity",
            p.destination_state AS "destinationState",
            p.commodity, p.rate_usd AS "rateUsd",
            p.rate_basis AS "rateBasis", p.fuel_surcharge_usd AS "fuelSurchargeUsd",
            p.distance_mi AS "distanceMi", p.weight_lbs AS "weightLbs",
            p.equipment_type AS "equipmentType",
            p.equipment_length_ft AS "equipmentLengthFt",
            p.pickup_at AS "pickupAt", p.delivery_at AS "deliveryAt",
            p.booked_load_id AS "bookedLoadId",
            b.name AS "brokerName", b.contact_name AS "brokerContactName",
            b.mc_number AS "mcNumber", b.credit_rating AS "creditRating",
            b.days_to_pay AS "daysToPay",
            u.company AS "carrierName", u.name AS "carrierContactName"
       FROM broker_conversations c
       JOIN load_postings p ON p.id = c.posting_id
       LEFT JOIN brokers b ON b.id = p.broker_id
       JOIN users u ON u.id = c.user_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [conversationId, userId],
  )
  return result.rows[0] ?? null
}

// What the load is worth, read at booking time. COALESCE puts the rate
// confirmation FIRST on purpose: when the paper disagrees with the
// handshake, the paper is what the carrier gets paid, and a dispatcher
// who accepted a rate con without reading it should see that number on
// the load. agreed_rate_usd is the fallback for threads booked before
// migration 018 added the column.
export async function getAgreedRate(client, postingId, userId, agreement = null, { withQuote = false } = {}) {
  const result = await client.query(
    `SELECT coalesce(rate_con_rate_usd, agreed_rate_usd) AS rate,
            rate_con_basis AS "rateBasis", rate_con_fuel_surcharge_usd AS "fuelSurchargeUsd"
       FROM broker_conversations
      WHERE posting_id = $1 AND user_id = $2 AND status IN ('agreed', 'booked')
        AND ($3::uuid IS NULL OR (id = $3 AND negotiation_revision = $4
          AND rate_con_rate_usd IS NOT NULL
          AND EXISTS (SELECT 1 FROM broker_messages m WHERE m.conversation_id = broker_conversations.id
            AND m.kind = 'rate_con' AND m.deliver_at <= now())))
      FOR UPDATE`,
    [postingId, userId, agreement?.conversationId ?? null, agreement?.revision ?? null],
  )
  const row = result.rows[0]
  return withQuote && row ? rateQuote({ rateBasis: row.rateBasis ?? ALL_IN, fuelSurchargeUsd: row.fuelSurchargeUsd ?? 0 }, row.rate) : row?.rate ?? null
}

// The broker sends the paper. Stored on the conversation rather than
// parsed back out of the PDF later.
export async function setRateCon(conversationId, rateConRateUsd, source = {}) {
  const quote = rateQuote(source, rateConRateUsd)
  const result = await query(
    `UPDATE broker_conversations
        SET rate_con_rate_usd = $2, rate_con_basis = $3, rate_con_fuel_surcharge_usd = $4, updated_at = now()
      WHERE id = $1 AND status = 'agreed'
      RETURNING ${CONVERSATION_COLUMNS.replaceAll('c.', '')}`,
    [conversationId, rateConRateUsd, quote.rateBasis, quote.fuelSurchargeUsd],
  )
  return result.rows[0] ?? null
}

// A re-negotiation invalidates the paper that was already on its way.
// Returns how many rate confirmations were withdrawn.
export async function clearRateCon(conversationId) {
  await query('UPDATE broker_conversations SET rate_con_rate_usd = NULL, rate_con_basis = NULL, rate_con_fuel_surcharge_usd = NULL WHERE id = $1', [conversationId])
  const result = await query(
    `UPDATE broker_messages SET voided_at = now(), void_reason = 'superseded' WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL`,
    [conversationId],
  )
  return result.rowCount
}

// The accept step. Conditional on status = 'agreed', so two clicks from
// two tabs cannot both create a load: the second one gets no row back.
export async function markBooked(conversationId, userId) {
  const result = await query(
    `UPDATE broker_conversations
        SET status = 'booked', negotiation_stage = 'booked', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'agreed'
        AND rate_con_rate_usd IS NOT NULL
      RETURNING ${CONVERSATION_COLUMNS.replaceAll('c.', '')}`,
    [conversationId, userId],
  )
  return result.rows[0] ?? null
}

// Lock posting before conversation, the same order booking uses. No AI call runs
// inside a transaction. Reserving a revision makes an older in-flight answer inert.
async function lockedConversation(client, conversationId, userId) {
  const found = await client.query('SELECT posting_id FROM broker_conversations WHERE id = $1 AND user_id = $2', [conversationId, userId])
  if (!found.rows[0]) throw new AppError('CONVERSATION_NOT_FOUND')
  const p = await client.query('SELECT status, posted_at, expires_at, rate_basis AS "rateBasis", fuel_surcharge_usd AS "fuelSurchargeUsd" FROM load_postings WHERE id = $1 FOR SHARE', [found.rows[0].posting_id])
  const posting = p.rows[0]
  if (!posting || new Date(posting.posted_at) > new Date()) throw new AppError('POSTING_NOT_FOUND')
  if (posting.status !== 'open') throw new AppError('POSTING_TAKEN')
  if (new Date(posting.expires_at) <= new Date()) throw new AppError('POSTING_EXPIRED')
  const c = await client.query(`SELECT ${CONVERSATION_COLUMNS} FROM broker_conversations c WHERE c.id = $1 AND c.user_id = $2 FOR UPDATE`, [conversationId, userId])
  return { ...c.rows[0], postingRateBasis: posting.rateBasis, postingFuelSurchargeUsd: posting.fuelSurchargeUsd }
}

export async function beginChatTurn(conversationId, userId, text) {
  return withTransaction(async (client) => {
    const conversation = await lockedConversation(client, conversationId, userId)
    const intent = chatIntent(text, { rateBasis: conversation.postingRateBasis, fuelSurchargeUsd: conversation.postingFuelSurchargeUsd })
    const invalidate = intent.kind === 'hold' || intent.kind === 'walk' || intent.kind === 'push'
      || (['offer', 'accept_amount'].includes(intent.kind) && conversation.agreedRateUsd !== null && intent.rateUsd !== conversation.agreedRateUsd)
    const updated = await client.query(`UPDATE broker_conversations SET negotiation_revision = negotiation_revision + 1,
      agreed_rate_usd = CASE WHEN $3 THEN NULL ELSE agreed_rate_usd END,
      rate_con_rate_usd = CASE WHEN $3 THEN NULL ELSE rate_con_rate_usd END,
      rate_con_basis = CASE WHEN $3 THEN NULL ELSE rate_con_basis END,
      rate_con_fuel_surcharge_usd = CASE WHEN $3 THEN NULL ELSE rate_con_fuel_surcharge_usd END,
      recipient_email = CASE WHEN $3 THEN NULL ELSE recipient_email END,
      status = CASE WHEN $3 THEN 'open' ELSE status END,
      negotiation_stage = CASE WHEN $3 THEN $4 ELSE negotiation_stage END, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING negotiation_revision`,
    [conversationId, userId, invalidate, intent.kind === 'hold' ? 'held' : 'negotiating'])
    if (invalidate) await client.query("UPDATE broker_messages SET voided_at = now(), void_reason = 'superseded' WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL", [conversationId])
    // Superseded pending prose must not say a previous rate was accepted after a hold.
    await client.query("DELETE FROM broker_messages WHERE conversation_id = $1 AND role = 'broker' AND kind = 'text' AND deliver_at > now()", [conversationId])
    const message = await client.query(`INSERT INTO broker_messages (conversation_id, role, content)
      VALUES ($1, 'dispatcher', $2) RETURNING id, role, content, kind, created_at AS "createdAt"`, [conversationId, text])
    return { conversation: { ...conversation, negotiationRevision: updated.rows[0].negotiation_revision }, dispatcherMessage: message.rows[0] }
  })
}

export async function completeChatTurn({ conversationId, userId, revision, decision, reply, delaySec, paperDelaySec, paperRate }) {
  return withTransaction(async (client) => {
    const conversation = await lockedConversation(client, conversationId, userId)
    if (conversation.negotiationRevision !== revision) return false
    const s = decision.state
    const paperQuote = decision.issuePaper ? rateQuote(decision.rateQuote ?? {}, paperRate) : null
    if (decision.invalidatePaper) await client.query("UPDATE broker_messages SET voided_at = now(), void_reason = 'superseded' WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL", [conversationId])
    await client.query(`UPDATE broker_conversations SET broker_offer_usd = $3,
      agreed_rate_usd = $4, status = CASE WHEN $4::integer IS NULL THEN 'open' ELSE 'agreed' END,
      negotiation_stage = $5, recipient_email = $6, rate_push_count = $7, best_counter_used = $8,
      rate_con_rate_usd = CASE WHEN $9 THEN $10::integer WHEN $11 THEN NULL ELSE rate_con_rate_usd END,
      rate_con_basis = CASE WHEN $9 THEN $12::text WHEN $11 THEN NULL ELSE rate_con_basis END,
      rate_con_fuel_surcharge_usd = CASE WHEN $9 THEN $13::integer WHEN $11 THEN NULL ELSE rate_con_fuel_surcharge_usd END,
      updated_at = now() WHERE id = $1 AND user_id = $2`,
    [conversationId, userId, s.offer, s.agreed, s.stage, s.recipient, s.pushes, s.bestCounterUsed, decision.issuePaper, paperRate, decision.invalidatePaper,
      paperQuote?.rateBasis ?? null, paperQuote?.fuelSurchargeUsd ?? null])
    await client.query(`INSERT INTO broker_messages (conversation_id, role, content, deliver_at)
      VALUES ($1, 'broker', $2, now() + make_interval(secs => $3))`, [conversationId, reply, delaySec])
    if (decision.issuePaper) {
      // Conversation lock + existence check make retries and duplicate email sends idempotent.
      await client.query(`INSERT INTO broker_messages (conversation_id, role, content, kind, deliver_at)
        SELECT $1, 'broker', 'Rate confirmation attached. Please review the details before signing.', 'rate_con',
          now() + make_interval(secs => $2)
        WHERE NOT EXISTS (SELECT 1 FROM broker_messages WHERE conversation_id = $1 AND kind = 'rate_con')`,
      [conversationId, delaySec + Math.max(1, paperDelaySec)])
    }
    return true
  })
}

// Has the rate confirmation actually landed in the thread yet? Accepting
// a document that has not arrived is not a thing a dispatcher can do.
export async function rateConDelivered(conversationId) {
  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM broker_messages
        WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL AND deliver_at <= now()
     ) AS delivered`,
    [conversationId],
  )
  return result.rows[0].delivered
}

// What one dispatcher turn cost at the provider (055): every request its
// reply took, second tries included. Written after the reply, success or
// failure -- a failed call that sent three requests still spent three.
export async function setProviderRequests(messageId, n) {
  await query('UPDATE broker_messages SET provider_requests = $2 WHERE id = $1', [messageId, n])
}

export async function invalidatePaper(conversationId) {
  await query(`UPDATE broker_conversations
    SET agreed_rate_usd = NULL, rate_con_rate_usd = NULL, rate_con_basis = NULL,
        rate_con_fuel_surcharge_usd = NULL, recipient_email = NULL,
        negotiation_stage = 'held', status = 'open', updated_at = now()
    WHERE id = $1`, [conversationId])
  const result = await query(`DELETE FROM broker_messages
     WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL`, [conversationId])
  return result.rowCount
}

export async function createBrokerBlock({ conversationId, brokerId = null, brokerMc = null, brokerContact = null, reason = BLOCK_REASON_CARRIER_CANCEL } = {}) {
  const result = await query(`INSERT INTO broker_blocks
    (broker_id, broker_mc, broker_contact, blocked_until, reason, conversation_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, blocked_until AS "blockedUntil", reason`,
  [brokerId, brokerMc, brokerContact, blockUntil(new Date(), BROKER_BLOCK_DAYS), reason, conversationId])
  return result.rows[0]
}

export async function cancelAndBlock({ conversationId, text, line, brokerId = null, brokerMc = null, brokerContact = null } = {}) {
  return withTransaction(async (client) => {
    await client.query(`UPDATE broker_conversations SET agreed_rate_usd = NULL, rate_con_rate_usd = NULL,
      rate_con_basis = NULL, rate_con_fuel_surcharge_usd = NULL, recipient_email = NULL,
      negotiation_stage = 'held', status = 'open', updated_at = now() WHERE id = $1`, [conversationId])
    await client.query(`UPDATE broker_messages SET voided_at = now(), void_reason = 'carrier_cancelled'
      WHERE conversation_id = $1 AND kind = 'rate_con' AND voided_at IS NULL`, [conversationId])
    const block = await client.query(`INSERT INTO broker_blocks
      (broker_id, broker_mc, broker_contact, blocked_until, reason, conversation_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [brokerId, brokerMc, brokerContact, blockUntil(new Date(), BROKER_BLOCK_DAYS), BLOCK_REASON_CARRIER_CANCEL, conversationId])
    const dispatcher = await client.query(`INSERT INTO broker_messages (conversation_id, role, content)
      VALUES ($1, 'dispatcher', $2) RETURNING id, role, content, kind, created_at AS "createdAt"`, [conversationId, text])
    await client.query(`INSERT INTO broker_messages (conversation_id, role, content)
      VALUES ($1, 'broker', $2)`, [conversationId, line])
    return { ...dispatcher.rows[0], blockId: block.rows[0].id }
  })
}

export async function isBrokerBlocked({ brokerId = null, brokerMc = null } = {}) {
  const result = await query(`SELECT EXISTS (
    SELECT 1 FROM broker_blocks
    WHERE blocked_until > now() AND (($1::uuid IS NOT NULL AND broker_id = $1) OR ($2::text IS NOT NULL AND broker_mc = $2))
  ) AS blocked`, [brokerId, brokerMc])
  return result.rows[0]?.blocked === true
}
