// The example bank, built from what has already been graded: every chat
// turn graded "yes", sorted by the situation the dispatcher's line puts the
// chat in, with its numbers and names swapped for {placeholders}.
//
//   npm run chat:examples
//   npm run chat:examples -- --top 5 --json --out /tmp/examples.md
//
//   --grades <file>        default ../../reports/training/grades.jsonl
//   --dataset <file>       default ../../reports/eval/dataset.jsonl
//   --turns-dir <dir>      default ../../reports/training   (turns-*.jsonl)
//   --scenarios-dir <dir>  default ../../reports            (chat-scenarios-*.md)
//   --out <file>           default <tmp dir>/dispatchsim-examples-<time>.md
//   --json                 also write <out>.json (every candidate, raw and templated)
//   --top <n>              examples shown per side and situation (default 8)
//
// Read-only; no database, no model. Never writes under the folders it reads
// (reports/): the report goes to a temp file unless --out says otherwise.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promptVersionOf } from '../src/lib/promptVersion.js'
import { readJsonl, parseGradeId, parseScenarioMarkdown, joinGraded } from './exampleSources.js'
import { buildBank, renderMarkdown, renderJson } from './exampleBank.js'

const here = dirname(fileURLToPath(import.meta.url))
const reports = join(here, '..', '..', 'reports')

function flagValue(argv, name, fallback) {
  const at = argv.indexOf(name)
  if (at < 0) return fallback
  const v = argv[at + 1]
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} wants a value`)
    process.exit(1)
  }
  return v
}

const argv = process.argv.slice(2)
const gradesFile = resolve(flagValue(argv, '--grades', join(reports, 'training', 'grades.jsonl')))
const datasetFile = resolve(flagValue(argv, '--dataset', join(reports, 'eval', 'dataset.jsonl')))
const turnsDir = resolve(flagValue(argv, '--turns-dir', join(reports, 'training')))
const scenariosDir = resolve(flagValue(argv, '--scenarios-dir', reports))
const top = Number(flagValue(argv, '--top', '8'))
const wantJson = argv.includes('--json')
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const out = resolve(flagValue(argv, '--out', join(tmpdir(), `dispatchsim-examples-${stamp}.md`)))
if (!Number.isInteger(top) || top < 1) {
  console.error('--top wants a whole number of 1 or more')
  process.exit(1)
}

// Never write into a folder this script reads from.
const inside = (child, parent) => {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}
for (const dir of [reports, scenariosDir, turnsDir, dirname(datasetFile), dirname(gradesFile)]) {
  if (inside(out, dir)) {
    console.error(`Refusing to write ${out}: it is inside ${dir}, which this script only reads.`)
    process.exit(1)
  }
}

const notes = []
const read = (file, what) => {
  if (!existsSync(file)) { notes.push(`${what} not found: ${file}`); return null }
  try { return readFileSync(file, 'utf8') } catch (e) { notes.push(`${what} unreadable: ${e.message}`); return null }
}
const readRows = (file, what) => {
  const text = read(file, what)
  if (text === null) return []
  try { return readJsonl(text) } catch (e) { notes.push(`${what} ${file}: ${e.message}`); return [] }
}

const grades = readRows(gradesFile, 'grades file')
const evalRows = readRows(datasetFile, 'evaluation dataset').filter((r) => String(r.id).startsWith('eval:'))

// Live rows: every turns file, oldest first, so the newest copy of an id wins.
const live = new Map()
if (existsSync(turnsDir)) {
  for (const name of readdirSync(turnsDir).filter((n) => /^turns-.*\.jsonl$/.test(n)).sort()) {
    for (const r of readRows(join(turnsDir, name), `turns file ${name}`)) {
      if (String(r.id).startsWith('live:')) live.set(r.id, r)
    }
  }
} else {
  notes.push(`turns folder not found: ${turnsDir}`)
}

// Scenario files: only the stamps the grades name.
const wanted = new Set(grades.map((g) => parseGradeId(g.id)).filter((p) => p?.source === 'scenarios').map((p) => p.stamp))
const scenarioTurns = []
for (const s of wanted) {
  const text = read(join(scenariosDir, `chat-scenarios-${s}.md`), `scenario file ${s}`)
  if (text !== null) scenarioTurns.push(...parseScenarioMarkdown(text, s))
}

const joined = joinGraded({ grades, evalRows, liveRows: [...live.values()], scenarioTurns })
const prompts = [
  join(here, '..', 'src', 'modules', 'brokerChat', 'brokerChat.prompt.js'),
  join(here, '..', 'src', 'modules', 'driverChat', 'driverChat.prompt.js'),
]
const currentVersions = prompts.filter((p) => existsSync(p)).map((p) => promptVersionOf(p))
const uniqueIds = new Set(grades.map((g) => g.id).filter(Boolean)).size
const bank = buildBank(joined, { gradesRead: grades.length, uniqueIds, top, currentVersions })
bank.meta.notes = notes
bank.meta.currentPromptVersions = currentVersions

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, renderMarkdown(bank))
if (wantJson) writeFileSync(`${out}.json`, renderJson(bank))

const m = bank.meta
console.log(`Grades: ${m.gradesRead} lines, ${m.uniqueIds} unique ids`)
console.log(`Joined (graded yes): ${m.joined} · excluded: ${m.excluded} · not joined: ${m.unjoined}`)
for (const [src, c] of Object.entries(m.perSource)) console.log(`  ${src}: joined ${c.joined}, excluded ${c.excluded}, unjoined ${c.unjoined}`)
console.log(`By situation: ${Object.entries(m.byType).map(([t, c]) => `${t} ${c.broker + c.driver}`).join(', ')}`)
console.log(`Candidates with an "unmatched" flag: ${m.withUnmatchedFlags} of ${m.candidates}; with any flag: ${m.withAnyFlag}`)
for (const n of notes) console.log(`Note: ${n}`)
console.log(`Written: ${out}${wantJson ? ` and ${out}.json` : ''}`)
