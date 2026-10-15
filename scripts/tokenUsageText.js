// The lines `npm run chat:usage` prints about tokens. Pure, so a test holds it.

import { DAILY_TOKENS_SQL, DAILY_UNRECORDED_SQL } from '../src/modules/chat/chatBudget.sql.js'
import { UNDEFINED_COLUMN } from '../src/modules/chat/legacySchema.js'

const n = (v) => Number(v).toLocaleString('en-US')

// "tokens ~123,400/200,000 (62%) · 429: 2" -- or, with no published limit,
// the count alone. `row` is a DAILY_TOKENS_SQL row, `status` a dailyTokenStatus.
export function tokenUsageLines(row, status) {
  const head = status.limit
    ? `tokens ~${n(row.total)}/${n(status.limit)} (${Math.round(status.pct * 100)}%)`
    : `tokens ~${n(row.total)} (no published daily limit)`
  const lines = [`  ${head} · 429: ${row.rate_limited}`]
  if (status.warn) {
    lines.push(`  WARNING: ${Math.round(status.pct * 100)}% of the daily token limit is used. Nothing is blocked.`)
  }
  return lines
}

export function tokenFootnotes({ unrecorded, source, checked }) {
  const lines = []
  // Not "before 060": a budget refusal is also recorded with no attempts.
  if (unrecorded > 0) {
    lines.push(`  ${unrecorded} rows with no token record — approximate`)
  }
  if (source) lines.push(`  limits: ${source}${checked ? ` (checked ${checked})` : ''}`)
  lines.push('  refused (429) requests and responses without a usage block count as 0 tokens')
  lines.push("  counted from the app's own records; the database day may not match the provider's window")
  return lines
}

export const TOKEN_RECORDS_UNAVAILABLE = '  token records unavailable (migration 060 not applied)'

// The whole token section, from the two query results. `rows` are
// DAILY_TOKENS_SQL rows; `statusFor(model, total)` gives the model's
// dailyTokenStatus (the caller knows which provider each chat uses).
export function tokenSectionLines({ rows, unrecorded, statusFor }) {
  if (rows.length === 0) {
    return ['', '  tokens today: no token records yet', ...tokenFootnotes({ unrecorded, source: null, checked: null })]
  }
  const lines = ['', '  tokens today, by model']
  let footer = { source: null, checked: null }
  for (const row of rows) {
    const status = statusFor(row.model, row.total)
    if (status.limit) footer = { source: status.source, checked: status.checked }
    lines.push(`  ${row.model}`, ...tokenUsageLines(row, status))
  }
  return [...lines, ...tokenFootnotes({ unrecorded, ...footer })]
}

// Runs the two queries (`run(sql)` -> { rows }) and builds the section. On a
// database without migration 060 the queries fail with 42703; the section
// then says so and the rest of the report still prints. Any other error is
// real and is thrown.
export async function loadTokenSection(run, statusFor) {
  let rows
  let unrecorded
  try {
    rows = (await run(DAILY_TOKENS_SQL)).rows
    unrecorded = (await run(DAILY_UNRECORDED_SQL)).rows[0].unrecorded
  } catch (err) {
    if (err?.code !== UNDEFINED_COLUMN) throw err
    return ['', TOKEN_RECORDS_UNAVAILABLE]
  }
  return tokenSectionLines({ rows, unrecorded, statusFor })
}
