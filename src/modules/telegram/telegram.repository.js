// Data access for the Telegram bridge. SQL lives in telegram.sql.js.
//
// One rule the whole module inherits from 046: the outbox row is created
// by the database deciding, not the code. claimDelivery returns the row
// only when THIS caller won it.

import { query } from '../../db/pool.js'
import * as SQL from './telegram.sql.js'

// `client` lets callers run these inside their own transaction (the
// outbound job claims and marks on the same connection; tests run inside
// inRollback). Without one, the pooled connection is used.
function run(client, sql, params) {
  const runner = client ?? { query }
  return runner.query(sql, params)
}

// -- Links ----------------------------------------------------------------

export async function upsertLink({ chatId, userId, linkedByTgUser }, client = null) {
  const result = await run(client, SQL.INSERT_LINK_SQL, [chatId, userId, linkedByTgUser])
  return result.rows[0]
}

export async function getLinkByChat(chatId, client = null) {
  const result = await run(client, SQL.GET_LINK_BY_CHAT_SQL, [chatId])
  return result.rows[0] ?? null
}

export async function getLinkByUser(userId, client = null) {
  const result = await run(client, SQL.GET_LINK_BY_USER_SQL, [userId])
  return result.rows[0] ?? null
}

export async function deleteLink(chatId, client = null) {
  const result = await run(client, SQL.DELETE_LINK_SQL, [chatId])
  return result.rows[0] ?? null
}

export async function setCurrentDriver(chatId, driverId, client = null) {
  const result = await run(client, SQL.SET_CURRENT_DRIVER_SQL, [chatId, driverId])
  return result.rows[0] ?? null
}

// -- Link codes -----------------------------------------------------------

export async function insertCode({ code, userId, expiresAt }, client = null) {
  const result = await run(client, SQL.INSERT_CODE_SQL, [code, userId, expiresAt])
  return result.rows[0]
}

export async function findValidCode(code, client = null) {
  const result = await run(client, SQL.FIND_VALID_CODE_SQL, [code])
  return result.rows[0] ?? null
}

// Returns the code's owner when this call is the one that consumed it;
// null when the code was already used or has expired -- the caller treats
// null as "no such code", the same sentence either way.
export async function markCodeUsed(code, client = null) {
  const result = await run(client, SQL.MARK_CODE_USED_SQL, [code])
  return result.rows[0] ?? null
}

// -- Outbox ---------------------------------------------------------------

// The claim. A row back = this caller owns the message. No row = someone
// else already claimed it, and the caller must not send.
export async function claimDelivery({ messageId, chatId }, client = null) {
  const result = await run(client, SQL.CLAIM_DELIVERY_SQL, [messageId, chatId])
  return result.rows[0] ?? null
}

export async function markSent(messageId, telegramMessageId, client = null) {
  const result = await run(client, SQL.MARK_SENT_SQL, [messageId, telegramMessageId])
  return result.rows[0] ?? null
}

// Null when the row already sent or is out of tries -- the caller leaves
// it alone in both cases.
export async function markFailed(messageId, lastError, client = null) {
  const result = await run(client, SQL.MARK_FAILED_SQL, [messageId, lastError])
  return result.rows[0] ?? null
}

export async function pendingMessages(limit, client = null) {
  const result = await run(client, SQL.PENDING_MESSAGES_SQL, [limit])
  return result.rows
}

export async function retryMessages(limit, client = null) {
  const result = await run(client, SQL.RETRY_MESSAGES_SQL, [limit])
  return result.rows
}

// -- Incoming -------------------------------------------------------------

export async function findReplyTarget({ chatId, telegramMessageId }, client = null) {
  const result = await run(client, SQL.REPLY_TARGET_SQL, [chatId, telegramMessageId])
  return result.rows[0] ?? null
}

export async function threadDeliveries(conversationId, client = null) {
  const result = await run(client, SQL.THREAD_DELIVERY_SQL, [conversationId])
  return result.rows
}
