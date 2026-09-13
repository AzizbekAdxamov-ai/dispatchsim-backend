// Data access for the driver chat. SQL lives in driverChat.sql.js.

import { query } from '../../db/pool.js'
import * as SQL from './driverChat.sql.js'

export async function openConversation(driverId, userId) {
  const result = await query(SQL.OPEN_CONVERSATION_SQL, [driverId, userId])
  return result.rows[0]
}

export async function getConversation(id, userId) {
  const result = await query(SQL.GET_CONVERSATION_SQL, [id, userId])
  return result.rows[0] ?? null
}

// One row, shaped into the two things the prompt needs: the person, and
// the load they are on (or null).
export async function getDriverContext(driverId) {
  const result = await query(SQL.GET_DRIVER_CONTEXT_SQL, [driverId])
  const r = result.rows[0]
  if (!r) return null
  return {
    driver: {
      id: r.id, name: r.name, cdlClass: r.cdlClass,
      homeBaseCity: r.homeBaseCity, homeBaseState: r.homeBaseState,
      dutyStatus: r.dutyStatus, payModel: r.payModel,
      payPercentBp: r.payPercentBp, payPerMileCents: r.payPerMileCents,
      truckId: r.truckId,
    },
    load: r.loadId
      ? {
        id: r.loadId, originCity: r.originCity, originState: r.originState,
        destinationCity: r.destinationCity, destinationState: r.destinationState,
        distanceMi: r.distanceMi,
      }
      : null,
  }
}

export async function listMessages(conversationId) {
  const result = await query(SQL.LIST_MESSAGES_SQL, [conversationId])
  return result.rows
}

// `kind` decides whether a later reply may overwrite this message.
// 'text' is a generated answer and is replaceable; 'report' (a road event)
// and 'refusal' are things that happened and are not.
//
// `client` lets the caller run this inside a transaction that already
// holds the conversation lock -- without it the insert would use a
// different pooled connection and the lock would protect nothing.
export async function addMessage(
  conversationId, role, content, { delaySec = 0, kind = 'text', client = null } = {},
) {
  const runner = client ?? { query }
  const result = await runner.query(
    SQL.ADD_MESSAGE_SQL, [conversationId, role, content, delaySec, kind],
  )
  return result.rows[0]
}

// Serialise the writers on one thread. Must be called inside a
// transaction, and the same client must be passed to the writes that
// follow it.
export async function lockConversation(client, conversationId) {
  await client.query(SQL.LOCK_CONVERSATION_SQL, [conversationId])
}

export async function replacePendingReply(conversationId, content, client = null) {
  const runner = client ?? { query }
  const result = await runner.query(SQL.REPLACE_PENDING_REPLY_SQL, [conversationId, content])
  return result.rows[0] ?? null
}

export async function hasPendingReply(conversationId) {
  const result = await query(SQL.HAS_PENDING_REPLY_SQL, [conversationId])
  return result.rows[0].pending
}


export async function listThreads(userId) {
  const result = await query(SQL.LIST_THREADS_SQL, [userId])
  return result.rows
}

export async function conversationsForDriver(driverId) {
  const result = await query(SQL.CONVERSATIONS_FOR_DRIVER_SQL, [driverId])
  return result.rows
}
