// May this dispatcher send another message today?
//
// Asked by both chats before either calls a model. Two things can stop a
// send and they are different facts, so they are different answers:
//
//   wallet -- the key is out of requests for today. Nobody sharing it
//     sends, including a student who has barely typed. This is the
//     provider's wall.
//   share -- the key has requests left but this dispatcher has used their
//     part of them. Someone else can still send.
//
// Both are returned with their numbers, because "limit reached" without
// the arithmetic is a refusal whose reason has been removed.

import { query } from '../../db/pool.js'
import { AppError } from '../../lib/errors.js'
import { DAILY_USAGE_SQL } from './chatBudget.sql.js'
import { chatConfigFor, walletScopeFor } from './chatProvider.js'
import { dailyBudgetFor, providerFor, fairShare, budgetMessage } from '../../constants/chatBudget.js'

export async function dailyUsage(userId, which) {
  const config = chatConfigFor(which)
  const scope = walletScopeFor(which)
  const budget = dailyBudgetFor(config.baseUrl)

  const { rows } = await query(DAILY_USAGE_SQL, [userId, scope])
  const { used, account_used: accountUsed, seats } = rows[0]

  // seats counts people who have already sent something today. A
  // dispatcher opening their first thread is not in it yet, and dividing
  // by a number that leaves them out hands them a share that is already
  // spoken for -- with nobody at all on the board, a share of the whole
  // budget. They are added to the divisor, and the same adjusted number is
  // what the message reports, so the arithmetic on screen adds up.
  const seatsWithMe = seats + (used === 0 ? 1 : 0)

  return {
    which,
    scope,
    used,
    accountUsed,
    seats: seatsWithMe,
    share: fairShare(budget, seatsWithMe),
    budget,
    provider: providerFor(config.baseUrl).name,
  }
}

// Throws when the send cannot happen. Returns the usage when it can, so
// the caller can show what is left without asking again.
export async function assertCanSend(userId, which) {
  const usage = await dailyUsage(userId, which)

  if (usage.accountUsed >= usage.budget || usage.used >= usage.share) {
    throw new AppError('CHAT_DAILY_LIMIT', { message: budgetMessage(usage), ...usage })
  }

  return usage
}
