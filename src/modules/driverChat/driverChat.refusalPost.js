// Put the refusal into the conversation with the person who made it.
//
// Separate from driverChat.service.js on purpose: this is the only path
// into the thread that does not come from the dispatcher typing, and it
// must not drag the model client, the daily message cap, or the AI config
// along with it. A refusal is not a generated reply -- it is composed from
// the numbers by driverChat.refusal.js so it can never disagree with
// driver_settlements.
//
// Called from dispatch.service.js AFTER the dispatch transaction has
// already failed, and always with the error swallowed by the caller. The
// dispatcher has been told why the dispatch failed by the API response;
// this line is the same fact arriving where a conversation lives.

import * as repo from './driverChat.repository.js'
import { refusalLine } from './driverChat.refusal.js'
import { driverReplyDelaySec } from './driverChat.replyTiming.js'
import { REASONS } from '../../constants/availabilityReasons.js'

export async function postRefusal({ userId, details, code }) {
  if (!userId || !details?.driverId) return null

  // details spread FIRST, then reason. The other order looked correct and
  // was dead: `details` always carries its own `reason` key, so the spread
  // silently overwrote the computed one. Harmless while every caller sets
  // details.reason, and a silent failure the moment one does not -- the
  // person who left would say nothing at all.
  const reason = code === 'DRIVER_QUIT' ? REASONS.QUIT : details.reason
  const content = refusalLine({ ...details, driverId: details.driverId, reason })
  // A reason with no line posts nothing rather than posting 'undefined'
  // into a person's conversation.
  if (!content) return null

  const conversation = await repo.openConversation(details.driverId, userId)

  // Delayed like any other reply. A refusal that appeared instantly while
  // every other message from this driver takes two minutes would read as
  // the system talking, not the person.
  const context = await repo.getDriverContext(details.driverId)
  const delaySec = driverReplyDelaySec(context?.driver?.dutyStatus)

  // kind 'refusal': something that happened, not a generated reply. A
  // later chat message must never overwrite it -- see migration 028.
  //
  // It does NOT go through replacePendingReply either, for the same
  // reason: replacing a pending answer with a refusal would be fine, but
  // the reverse (a chat reply eating the refusal) is what that statement
  // used to do. A refusal is simply appended.
  return repo.addMessage(conversation.id, 'driver', content, { delaySec, kind: 'refusal' })
}
