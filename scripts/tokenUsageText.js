// The lines `npm run chat:usage` prints about tokens. Pure, so a test holds it.

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
  if (unrecorded > 0) {
    lines.push(`  ${unrecorded} rows without a token record (before 060) — approximate`)
  }
  if (source) lines.push(`  limits: ${source}${checked ? ` (checked ${checked})` : ''}`)
  lines.push("  counted from the app's own records; the database day may not match the provider's window")
  return lines
}
