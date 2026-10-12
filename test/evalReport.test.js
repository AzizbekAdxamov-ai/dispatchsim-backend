// Kills: minute-only run IDs overwriting rapid one-case reports, and a
// second process replacing an existing report between name check and write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { nextEvalRunId, writeEvalReport } from '../scripts/evalReport.js'

const outDir = join('reports', 'eval')
const at = new Date('2026-10-12T09:42:17.123Z')

test('rapid run IDs include milliseconds and stay distinct in the same instant', () => {
  const first = nextEvalRunId(outDir, at, 'first', () => false)
  const second = nextEvalRunId(outDir, at, 'second', () => false)
  assert.match(first, /2026-10-12-09-42-17-123/)
  assert.notEqual(first, second)
})

test('an existing report name is skipped and the final write is exclusive', () => {
  const seen = []
  const id = nextEvalRunId(outDir, at, 'fixed', (file) => {
    seen.push(file)
    return seen.length < 3
  })
  assert.match(id, /-fixed-3$/)
  let written
  const file = writeEvalReport(outDir, id, 'new report', (...args) => { written = args })
  assert.equal(file, join(outDir, `run-${id}.md`))
  assert.deepEqual(written, [file, 'new report', { flag: 'wx' }])
})

test('chat evaluation uses the protected run ID for report and dataset rows', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const code = readFileSync(join(here, '..', 'scripts', 'chat-eval.js'), 'utf8')
  assert.match(code, /const runId = nextEvalRunId\(outDir, startedAt\)/)
  assert.match(code, /writeEvalReport\(outDir, runId,/)
  assert.match(code, /id: `eval:\$\{runId\}:\$\{fields\.caseId\}`/)
})
