// Everything the chat models have answered, in one file for grading and
// training: the live turns (chat_turn_log, 056) and every evaluation run
// (reports/eval/dataset.jsonl), with grades joined in.
//
//   npm run chat:export                       everything
//   npm run chat:export -- --since 2026-10-09 live turns from that day on
//
// Writes ../reports/training/turns-<time>.jsonl and prints the counts.
// Read-only on the database.

import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../src/db/pool.js'
import { liveRow, readJsonl, withGrades, summary } from './trainingRows.js'

const here = dirname(fileURLToPath(import.meta.url))
const reports = join(here, '..', '..', 'reports')
const argv = process.argv.slice(2)
const sinceArg = argv[argv.indexOf('--since') + 1]
const since = argv.includes('--since') && /^\d{4}-\d{2}-\d{2}$/.test(sinceArg ?? '') ? sinceArg : null
if (argv.includes('--since') && !since) {
  console.error('--since wants a date: --since 2026-10-09')
  process.exit(1)
}

const read = (p) => (existsSync(p) ? readJsonl(readFileSync(p, 'utf8')) : [])

try {
  const { rows } = await pool.query(
    `SELECT * FROM chat_turn_log WHERE ($1::date IS NULL OR created_at >= $1::date) ORDER BY id`, [since],
  )
  const all = withGrades(
    [...read(join(reports, 'eval', 'dataset.jsonl')), ...rows.map(liveRow)],
    read(join(reports, 'training', 'grades.jsonl')),
  )
  mkdirSync(join(reports, 'training'), { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const file = join(reports, 'training', `turns-${stamp}.jsonl`)
  writeFileSync(file, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''))
  const s = summary(all)
  console.log(`Turns: ${s.total} (live ${s.live}, evaluation ${s.eval}) · graded ${s.graded}, not yet ${s.ungraded} · with automatic findings ${s.flagged} · failed ${s.failed}`)
  console.log(`Written: ${file}`)
} finally {
  await pool.end()
}
