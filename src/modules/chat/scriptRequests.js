// Provider requests the chat scripts spend, written down (058).
//
// The scripts call the same key as the app. Before this they counted their
// requests in a local variable and printed it, so the daily budget -- which
// reads the database -- never knew about them.

import { query } from '../../db/pool.js'
import { DAILY_USAGE_SQL } from './chatBudget.sql.js'
import { walletScopeFor } from './chatProvider.js'

export const INSERT_SCRIPT_REQUESTS_SQL = `
  INSERT INTO chat_script_requests (source, side, model, requests)
  VALUES ($1, $2, $3, $4)`

// Calls `chatText` and writes what it cost, whether it answered or threw.
// Every request is counted where it is sent (aiClient's onRequest), so the
// second try, backoff retries and the fallback model's request are in the
// number. `model` is the model that answered, or the configured one when
// nothing did. `onRequest` is also forwarded, for the script's own tally.
export async function chatTextRecorded({ chatText, source, side, config, record = defaultRecord, onRequest = null, ...rest }) {
  let spent = 0
  let model = config.model
  try {
    return await chatText({
      ...rest,
      config,
      onRequest: () => { spent += 1; onRequest?.() },
      onModel: (m) => { model = m; rest.onModel?.(m) },
    })
  } finally {
    if (spent > 0) {
      try {
        await record({ source, side, model, requests: spent })
      } catch {
        // No error text: a database error can carry query data. The run is
        // not stopped, but it must not look as if the count was kept.
        console.error(`WARNING: ${spent} provider request(s) could not be recorded; the daily count is low by that many.`)
      }
    }
  }
}

async function defaultRecord({ source, side, model, requests }) {
  await query(INSERT_SCRIPT_REQUESTS_SQL, [source, side, model, requests])
}

const NOBODY = '00000000-0000-0000-0000-000000000000'

// Requests already spent today on the wallet this side draws from: the
// app's turns and the scripts' own rows (058).
export async function usedToday(which) {
  const { rows } = await query(DAILY_USAGE_SQL, [NOBODY, walletScopeFor(which)])
  return rows[0].account_used
}

// The refusal for a plan that does not fit in what is left of today, or
// null when it fits. `used` is what is already spent, so a plan is judged
// against the room that remains, not the whole day.
export function budgetRefusal({ planned, budget, used, hint }) {
  const remaining = budget - used
  if (planned <= remaining) return null
  return `Planned ~${planned} requests; today ${used} of ${budget} are used and ${Math.max(0, remaining)} remain. ${hint}`
}
