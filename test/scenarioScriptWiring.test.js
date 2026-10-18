// The scenario runner needs a database/provider to execute. These wiring
// checks keep its failure and per-turn evidence paths from silently drifting.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = () => readFileSync(new URL('../scripts/chat-scenarios.js', import.meta.url), 'utf8')

// Kills: a provider error turned into a `(FAILED...)` broker line, then fed
// into history so later S9 turns run against a reply nobody actually gave.
test('scenario provider failure aborts and preserves only completed transcript turns', () => {
  const src = source()
  assert.match(src, /catch \{[\s\S]*?error\.safeForConsole = true\s+throw error/)
  assert.doesNotMatch(src, /return `\(FAILED:/)
  assert.match(src, /say\(`- \*\*D:\*\*.*?`\)\s+const out = await answer\(/)
  assert.equal((src.match(/say\(`- \*\*D:\*\*.*?`\)\s+const out = await answer\(/g) ?? []).length, 2)
  assert.match(src, /if \(aborted\) say\('_Aborted run: completed turns only\._'\)/)
  assert.match(src, /if \(aborted\) process\.exitCode = 1/)
})

// Kills: scenario turns reporting only the configured primary model and run
// totals; fallback, regeneration and per-turn token cost would be invisible.
test('each scenario turn reports actual model, prompt version and attempts', () => {
  const src = source()
  assert.match(src, /onModel: \(answered\) => \{ model = answered \}/)
  assert.match(src, /onAttempt: \(attempt\) => \{ attempts\.push\(attempt\) \}/)
  assert.match(src, /attempts\.push\(\.\.\.result\.attempts\)/)
  assert.match(src, /return \{ \.\.\.out, model, attempts:/)
  assert.match(src, /\*\*Answering model:\*\*.*?out\.model.*?reasoning_effort.*?promptVersion/)
  assert.match(src, /\*\*Requests:\*\* \$\{attemptsLine\(out\.attempts\)\}/)
  assert.match(src, /sayReply\('B', out, bp, findings, config, brokerPromptVersion\)/)
  assert.match(src, /sayReply\('G', out, dp, findings, config, driverPromptVersion\)/)
})
