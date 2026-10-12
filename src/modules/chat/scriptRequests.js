// Provider requests the chat scripts spend, written down (058).
//
// The scripts call the same key as the app. Before this they counted their
// requests in a local variable and printed it, so the daily budget -- which
// reads the database -- never knew about them.

import { query } from '../../db/pool.js'

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
