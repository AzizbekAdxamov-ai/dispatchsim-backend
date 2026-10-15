// Writing chat_turn_log (056): one row per dispatcher turn, with the
// system prompt the model answered from. See the migration for why.

import { query } from '../../db/pool.js'
import { brokerReply, driverReply } from '../../../scripts/scenarioChecks.js'
import { UNDEFINED_COLUMN, warnOnce } from './legacySchema.js'

export const INSERT_TURN_SQL = `
  INSERT INTO chat_turn_log
    (chat, conversation_id, dispatcher_message, user_id, model, prompt_version, system_prompt,
     history, dispatcher_text, image_count, reply, regenerated_because, fell_back, error,
     provider_requests, findings, attempts)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb)`

// The same row for a database without migration 060 (no attempts column).
export const INSERT_TURN_NO_ATTEMPTS_SQL = `
  INSERT INTO chat_turn_log
    (chat, conversation_id, dispatcher_message, user_id, model, prompt_version, system_prompt,
     history, dispatcher_text, image_count, reply, regenerated_because, fell_back, error,
     provider_requests, findings)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`

// The row, pure. The same automatic checks chat:scenarios and chat:eval
// run (scenarioChecks.js), so a live turn and an evaluated one are flagged
// by one set of rules. A failed turn carries no reply and no findings --
// its error is the finding.
export function turnRow({
  chat, conversationId, dispatcherMessageId = null, userId = null, model, promptVersion,
  systemPrompt, history = [], text, imageCount = 0, reply = null, regeneratedBecause = null,
  fellBack = false, error = null, providerRequests = 0, onTheRoad = false, attempts = [],
}) {
  const answered = error == null && typeof reply === 'string'
  const previous = [...history].reverse().find((m) => m.role !== 'dispatcher')?.content ?? null
  const findings = answered
    ? (chat === 'broker' ? brokerReply(reply, previous) : driverReply(reply, previous, { onTheRoad }))
    : []
  return [
    chat, conversationId, dispatcherMessageId, userId, model, promptVersion, systemPrompt,
    JSON.stringify(history.map((m) => ({ role: m.role, content: m.content }))),
    text, imageCount, answered ? reply : null, regeneratedBecause, fellBack,
    answered ? null : String(error ?? 'no reply'), providerRequests, JSON.stringify(findings),
    JSON.stringify(attempts ?? []),
  ]
}

// On a database without migration 060 the insert fails with 42703; the turn
// is written again without its attempts (the last value of the row) instead
// of being lost.
export async function logTurn(row, run = query) {
  try {
    await run(INSERT_TURN_SQL, row)
  } catch (err) {
    if (err?.code !== UNDEFINED_COLUMN) throw err
    warnOnce('chat_turn_log.attempts', 'chat_turn_log has no attempts column (migration 060 not applied): logging turns without token records.')
    await run(INSERT_TURN_NO_ATTEMPTS_SQL, row.slice(0, -1))
  }
}
