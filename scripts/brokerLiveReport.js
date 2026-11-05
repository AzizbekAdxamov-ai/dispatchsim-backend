// Pure reporting helpers. Importing this module never contacts a provider.
export const FIXTURE_SCOPE = 'In-memory fixture repositories and synthetic loads/carrier; real provider only. No live database, browser/UI, PDF rendering, signature or external email verification. deliverAll() bypasses document/reply delivery delays. Flags cover automated checks only; human tone review is still required.'

function jsonArray(value) {
  if (Array.isArray(value)) return value
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

export function readTurnLog(row) {
  const attempts = jsonArray(row[16])
  const findings = jsonArray(row[15])
  const lastAnswered = [...attempts].reverse().find((a) => a.outcome === 'ok' || a.status === 200)
  const usage = attempts.map((a) => a.usage?.total).filter(Number.isFinite)
  return {
    reply: row[10] ?? null, model: lastAnswered?.model ?? row[4] ?? null,
    providerRequests: Number.isFinite(row[14]) ? row[14] : null,
    regenerated: row[11] ?? null, usedFallback: row[12] === true,
    error: row[13] ?? null, findings, attempts,
    reportedTokens: usage.reduce((sum, n) => sum + n, 0),
    tokenUsageComplete: attempts.length > 0 && usage.length === attempts.length,
  }
}

export function turnIssues(turn) {
  return [...new Set([
    ...(turn.flags ?? []),
    ...(turn.usedFallback ? ['fell back to a deterministic reply'] : []),
    ...(turn.regenerated ? [`regenerated: ${turn.regenerated}`] : []),
    ...(turn.error ? [`provider/service error: ${turn.error}`] : []),
    ...(!turn.model ? ['answered model unavailable'] : []),
    ...(turn.findings ?? []).map((f) => `shared finding: ${typeof f === 'string' ? f : JSON.stringify(f)}`),
    ...(turn.attempts ?? []).filter((a) => a.status >= 400 || (a.outcome && a.outcome !== 'ok' && a.outcome !== 'success'))
      .map((a) => `provider attempt ${a.n ?? '?'}: ${a.status ?? '?'} ${a.outcome ?? ''}`),
  ])]
}

export function reportTotals(loads) {
  const turns = loads.flatMap((load) => load.turns)
  return {
    turns: turns.length,
    providerRequests: turns.reduce((n, t) => n + (t.providerRequests ?? 0), 0),
    requestCountComplete: turns.every((t) => Number.isFinite(t.providerRequests)),
    reportedTokens: turns.reduce((n, t) => n + (t.reportedTokens ?? 0), 0),
    tokenUsageComplete: turns.length > 0 && turns.every((t) => t.tokenUsageComplete),
    fallbacks: turns.filter((t) => t.usedFallback).length,
    regenerations: turns.filter((t) => t.regenerated).length,
    errors: turns.filter((t) => t.error).length,
    flaggedTurns: turns.filter((t) => turnIssues(t).length).length,
  }
}

export function renderLiveReport(mode, loads, config, { startedAt, finishedAt, plannedLoads }) {
  const totals = reportTotals(loads)
  const lines = [`# Broker ${mode} live report — ${finishedAt.slice(0, 10)}`, '',
    `- Scope: ${FIXTURE_SCOPE}`, `- Configured model: ${config.model}`,
    `- Started: ${startedAt}; finished: ${finishedAt}`,
    `- Completed loads: ${loads.filter((l) => !l.error).length}/${plannedLoads}`,
    `- Totals: ${JSON.stringify(totals)}`, '', '## Transcripts']
  for (const load of loads) {
    lines.push('', `### ${load.name} — ${load.contactName}`, `Fixture lane: ${load.lane}`,
      `Fixture appointments: pickup=${load.pickupAt}; delivery=${load.deliveryAt}`)
    for (const turn of load.turns) {
      lines.push('', `Dispatcher: ${turn.asked}`, `Displayed: ${turn.reply ?? '(no reply)'}`,
        `Raw provider replies: ${JSON.stringify(turn.rawReplies ?? [])}`,
        `Telemetry: ${JSON.stringify({ model: turn.model, providerRequests: turn.providerRequests,
          reportedTokens: turn.reportedTokens, tokenUsageComplete: turn.tokenUsageComplete,
          regenerated: turn.regenerated, usedFallback: turn.usedFallback, error: turn.error,
          startedAt: turn.startedAt, finishedAt: turn.finishedAt, attempts: turn.attempts })}`,
        `Decision/state trace: ${JSON.stringify(turn.trace ?? null)}`)
      for (const issue of turnIssues(turn)) lines.push(`!! ${issue}`)
    }
    if (load.error) lines.push(`!! INCOMPLETE: ${load.error}`)
    for (const flag of load.flowFlags ?? []) lines.push(`!! FLOW: ${flag}`)
  }
  return `${lines.join('\n')}\n`
}
