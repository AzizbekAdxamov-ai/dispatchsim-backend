import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cronMayWriteRemote } from '../src/jobs/dailyRefresh.js'
import { assertLocalHost, parseCliArgs, runRefresh, runPostingRefresh } from '../scripts/refresh-postings.js'

const REMOTE = 'postgres://u:p@ep-x.neon.tech/db'

test('guard passes for remote URL with allowRemote:true', () => {
  // Kills: the guard still reading process.argv, which broke the prod cron path.
  assert.doesNotThrow(() => assertLocalHost({ allowRemote: true, databaseUrl: REMOTE }))
})

test('guard throws for remote URL without allowRemote, passes for localhost', () => {
  // Kills: removing/loosening the remote host guard.
  assert.throws(() => assertLocalHost({ databaseUrl: REMOTE }), /without --allow-remote/)
  assert.doesNotThrow(() => assertLocalHost({ databaseUrl: 'postgres://u@localhost/db' }))
})

test('runRefresh and runPostingRefresh refuse remote without allowRemote', async () => {
  // Kills: the exported runners skipping the guard / ignoring the option.
  const prev = process.env.DATABASE_URL
  process.env.DATABASE_URL = REMOTE
  try {
    await assert.rejects(runRefresh(), /refuses to write/)
    await assert.rejects(runPostingRefresh(), /refuses to write/)
  } finally { process.env.DATABASE_URL = prev }
})

test('CLI parse: --allow-remote required to be true', () => {
  // Kills: CLI auto-allowing remote, or ignoring the flag.
  assert.equal(parseCliArgs([]).allowRemote, false)
  assert.equal(parseCliArgs(['--postings-only', '--count=5']).allowRemote, false)
  assert.deepEqual(parseCliArgs(['--allow-remote', '--postings-only', '--count=5']),
    { postingOnly: true, allowRemote: true, count: 5 })
})

test('cronMayWriteRemote: only on Vercel, never on a local server', () => {
  // Kills: allowRemote hardcoded true (or Boolean(...) dropped), letting a local server wired to the prod DB write to it from cron.
  assert.equal(cronMayWriteRemote({}), false)
  assert.equal(cronMayWriteRemote({ VERCEL: '' }), false)
  assert.equal(cronMayWriteRemote({ VERCEL: '1' }), true)
})

test('dailyRefresh passes cronMayWriteRemote() to both runners', () => {
  // Kills: dropping allowRemote from the cron/HTTP path, or bypassing the Vercel-only check.
  const src = readFileSync(new URL('../src/jobs/dailyRefresh.js', import.meta.url), 'utf8')
  assert.match(src, /runPostingRefresh\(\{ allowRemote: cronMayWriteRemote\(\) \}\)/)
  assert.match(src, /refresh\(\{ allowRemote: cronMayWriteRemote\(\) \}\)/)
})
