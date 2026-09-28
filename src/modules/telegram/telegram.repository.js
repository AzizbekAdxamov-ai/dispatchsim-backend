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

// -- Incoming: name lookup, roster, job bookkeeping -----------------------

// ALL drivers sharing the name -- two matches is a question back to the
// person typing, never a coin flip in the code.
export async function driversByName(name, client = null) {
  const result = await run(client, SQL.DRIVERS_BY_NAME_SQL, [name])
  return result.rows
}

export async function driversList(client = null) {
  const result = await run(client, SQL.DRIVERS_LIST_SQL, [])
  return result.rows
}

export async function driverById(driverId, client = null) {
  const result = await run(client, SQL.DRIVER_BY_ID_SQL, [driverId])
  return result.rows[0] ?? null
}

export async function getPollOffset(client = null) {
  const result = await run(client, SQL.GET_OFFSET_SQL, [])
  const raw = result.rows[0]?.offset
  const offset = Number(raw)
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0
}

export async function setPollOffset(offset, client = null) {
  await run(client, SQL.SET_OFFSET_SQL, [offset])
}

// The "not linked" notice map lives in sim_state as one jsonb object
// ({ "<chatId>": isoDate }), read and written by the poll loop only.
export async function getNoticeMap(client = null) {
  const result = await run(client, SQL.GET_NOTICE_MAP_SQL, [])
  const value = result.rows[0]?.value
  return value && typeof value === 'object' ? value : {}
}

export async function setNoticeMap(map, client = null) {
  await run(client, SQL.SET_NOTICE_MAP_SQL, [JSON.stringify(map)])
}
