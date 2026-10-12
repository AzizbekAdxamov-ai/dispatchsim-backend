// The chat evaluation run: the case bank (evalCases.js) against the REAL
// broker and driver prompts and the REAL model, with everything a grader
// needs to decide whether an answer was right -- and why it came out the
// way it did.
//
//   npm run chat:eval              # 10 broker + 10 Grace cases, ~20 requests
//   npm run chat:eval -- broker    # broker only (~10)
//   npm run chat:eval -- driver    # Grace only (~10)
//   npm run chat:eval -- broker --case EB01  # one broker case
//   npm run chat:eval -- driver --case ED01  # one Grace case
//
// Azizbek, 2026-10-09: from today the AIs are checked on a fixed set of
// trade phrases, and every answer is kept -- what it said, what data it
// had, whether it answered the question. That record is the base for
// better prompts now and for choosing a better model later: the same
// cases, run again, answer "better or worse" with evidence.
//
// What it writes (../reports/eval/):
//   run-<time>.md     the run to read and grade: per case the line, the
//                     data the model had, the reply, the automatic
//                     findings, and two blanks -- Accurate? Why?
//   dataset.jsonl     one row per case per run, appended, never rewritten:
//                     the line, the full system prompt (the data the model
//                     answered from), the reply, the findings, the model,
//                     the prompt version, and `human` (null until graded).
//
// Nothing is written to the database. Each case is one request; a second
// try (aiClient) adds one. A plan larger than the provider's daily budget
// is refused before the first request.

import 'dotenv/config'
import { mkdirSync, appendFileSync } from 'node:fs'
import { promptVersionOf } from '../src/lib/promptVersion.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, query } from '../src/db/pool.js'
import { chatConfigFor } from '../src/modules/chat/chatProvider.js'
import { chatText } from './seed/aiClient.js'
import { chatTextRecorded, usedToday, budgetRefusal } from '../src/modules/chat/scriptRequests.js'
import { dailyBudgetFor } from '../src/constants/chatBudget.js'
import appConfig from '../src/config.js'
import { marketFacts } from '../src/constants/marketRates.js'
import { relativeDay, clockDateTime } from '../src/constants/appClock.js'
import { talkFacts } from '../src/constants/freightTerms.js'
import { brokerTerms, termsLines } from '../src/constants/accessorials.js'
import * as brokerRepo from '../src/modules/brokerChat/brokerChat.repository.js'
import * as bp from '../src/modules/brokerChat/brokerChat.prompt.js'
import * as dp from '../src/modules/driverChat/driverChat.prompt.js'
import { getDriverContext } from '../src/modules/driverChat/driverChat.repository.js'
import { driverStanding } from '../src/modules/payroll/payroll.service.js'
import { getCarrier } from '../src/modules/carrier/carrier.repository.js'
import { BROKER_CASES, DRIVER_CASES, brokerFindings, driverFindings, CLASSIFIER_ONLY_FINDING } from './evalCases.js'
import { nycFixtureLoad, FIXTURE_LOAD_CASES } from './evalFixtures.js'
import { nextEvalRunId, writeEvalReport } from './evalReport.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const only = args.find((a) => a === 'broker' || a === 'driver') ?? 'both'
const caseFlag = args.find((a) => a.startsWith('--case='))?.slice('--case='.length)
const casePosition = args.indexOf('--case')
const caseId = caseFlag ?? (casePosition === -1 ? null : args[casePosition + 1])
const brokerCases = BROKER_CASES.filter((c) => !caseId || c.id === caseId)
const driverCases = DRIVER_CASES.filter((c) => !caseId || c.id === caseId)
if ((casePosition !== -1 && !caseId) || (caseFlag === '' && !caseId)
  || (caseId && ((only === 'broker' && !brokerCases.length)
  || (only === 'driver' && !driverCases.length)
  || (only === 'both' && brokerCases.length + driverCases.length !== 1)))) {
  console.error(`Unknown or mismatched case ID: ${caseId ?? '(missing)'}`)
  process.exit(1)
}
const outDir = join(here, '..', '..', 'reports', 'eval')
const startedAt = new Date()
const runId = nextEvalRunId(outDir, startedAt)
const md = []
const say = (line = '') => { md.push(line); console.log(line) }
const rows = []
let requests = 0
let retries = 0
let semanticFailure = false

// Only errors created here with fixed text or a case-bank ID may be shown
// at the terminal. Database/provider errors can carry query or prompt data.
function safeEvalError(message) {
  const err = new Error(message)
  err.safeForConsole = true
  return err
}

// Which prompt produced the answer: a hash of the prompt builder's source.
// Two runs with the same version had the same instructions; a different
// version means the prompt changed between them.
// The same hash the live services write into chat_turn_log (056).
const promptVersion = (file) => promptVersionOf(join(here, '..', 'src', 'modules', file))

async function ask(config, messages, side) {
  let answeredModel = config.model
  try {
    const reply = await chatTextRecorded({
      chatText, source: 'eval', side, messages, config,
      onRequest: () => { requests += 1 },
      onRetry: () => { retries += 1 },
      onModel: (model) => { answeredModel = model },
    })
    return { reply: reply.trim(), model: answeredModel }
  } catch (err) {
    // Fail the run without printing a provider body that may echo prompt
    // content. A failed request is not a model answer or a gradeable row.
    const kind = err.quotaExhausted ? 'daily cap' : err.rateLimited ? 'rate limit' : 'request error'
    throw safeEvalError(`Chat evaluation stopped after ${requests} provider request(s): ${kind}`)
  }
}

function record(fields) {
  // id: how a grade finds this row (reports/training/grades.jsonl).
  const row = { id: `eval:${runId}:${fields.caseId}`, source: 'eval', ...fields }
  rows.push(row)
  say(`### ${row.caseId} (${row.style}) — ${row.terms.join(', ') || 'plain words'} · \`${row.id}\``)
  say(`**Data the model had:** ${row.dataSummary}`)
  say('')
  say(`- **Dispatcher:** \`${row.line}\``)
  say(`- **${row.chat === 'broker' ? 'Broker' : 'Grace'}:** ${row.reply}`)
  say(`- **Answering model:** \`${row.model}\``)
  say(`- **Automatic findings:** ${row.findings.length ? row.findings.join(' · ') : 'none'}`)
  say(`- **A right answer:** ${row.good}`)
  say('- **Accurate?** ___  **Why?** ___')
  say('')
}

// -- Broker ------------------------------------------------------------------

async function brokerRun(carrier) {
  const config = chatConfigFor('broker')
  say(`## Broker — primary ${config.model} · prompt ${promptVersion('brokerChat/brokerChat.prompt.js')}`)
  say('')
  const open = (await query(`
    SELECT p.id, p.origin_state AS "originState", p.destination_state AS "destinationState",
           p.equipment_type AS "equipmentType", p.rate_hidden AS "rateHidden"
      FROM load_postings p
     WHERE p.status = 'open' AND p.broker_id IS NOT NULL
       AND p.posted_at <= now() AND p.expires_at > now() + interval '15 minutes'
     ORDER BY p.posted_at DESC LIMIT 400`)).rows
  if (open.length === 0) throw safeEvalError('No open postings available for broker evaluation')

  const PICK = {
    dryvan: (p) => p.equipmentType === 'dry-van' && !p.rateHidden,
    posted: (p) => !p.rateHidden,
    weak: (p) => { const m = marketFacts(p); return !p.rateHidden && m && m.destination.linehaul < m.national },
    strong: (p) => { const m = marketFacts(p); return !p.rateHidden && m && m.destination.source === 'regional' && m.destination.linehaul >= m.national },
    regionalOrigin: (p) => marketFacts(p)?.origin.source === 'regional',
    reefer: (p) => p.equipmentType === 'reefer',
    openDeck: (p) => p.equipmentType === 'flatbed' || p.equipmentType === 'step-deck',
  }
  const used = new Set()
  for (const c of brokerCases) {
    // A fresh posting per case where there are enough, so one odd load
    // does not colour the whole run; reuse one only when none is left.
    const hit = open.find((p) => !used.has(p.id) && PICK[c.pick](p)) ?? open.find((p) => PICK[c.pick](p))
    if (!hit) {
      if (caseId) throw safeEvalError(`No open posting fits ${c.id}`)
      say(`_${c.id} skipped: no open posting fits "${c.pick}"._\n`)
      continue
    }
    used.add(hit.id)
    const posting = await brokerRepo.getPostingWithBroker(hit.id)
    const market = marketFacts(posting)
    const terms = brokerTerms(posting.name, posting.equipmentType)
    const line = typeof c.line === 'function' ? c.line(posting, market) : c.line
    const systemPrompt = bp.buildBrokerSystemPrompt({
      carrier,
      broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
      posting,
      talk: talkFacts([line], posting.equipmentType),
    })
    const { reply, model } = await ask(config, bp.buildMessages({ systemPrompt, history: [], newMessage: line }), 'broker')
    const rpm = (posting.rateUsd / posting.distanceMi).toFixed(2)
    const side = (s) => (s.source === 'regional' ? `${s.region} $${s.linehaul}` : `${s.region ?? '?'} (no regional figure)`)
    record({
      runId, at: new Date().toISOString(), chat: 'broker', caseId: c.id, style: c.style, terms: c.terms, line, good: c.good,
      model, promptVersion: promptVersion('brokerChat/brokerChat.prompt.js'),
      data: {
        postingId: posting.id, broker: posting.name, contact: posting.contactName,
        lane: `${posting.originCity}, ${posting.originState} -> ${posting.destinationCity}, ${posting.destinationState}`,
        equipment: posting.equipmentType, miles: posting.distanceMi, rateUsd: posting.rateUsd, rpm: Number(rpm),
        rateHidden: posting.rateHidden,
        pickup: `${relativeDay(new Date(posting.pickupAt).toISOString(), startedAt.toISOString())} ${clockDateTime(new Date(posting.pickupAt).toISOString())}`,
        market: market ? { origin: side(market.origin), reload: side(market.destination), national: market.national } : null,
        terms: termsLines(terms),
      },
      dataSummary: `${posting.originCity}, ${posting.originState} → ${posting.destinationCity}, ${posting.destinationState} · ${posting.equipmentType} · ${posting.distanceMi} mi · $${posting.rateUsd} ($${rpm}/mi)${posting.rateHidden ? ' · call for rate' : ''} · ${posting.contactName} at ${posting.name}`
        + (market ? ` · market: out of ${side(market.origin)}, reload ${side(market.destination)}, national $${market.national}` : '')
        + ` · terms: ${termsLines(terms).slice(0, 3).join(' ')}`,
      systemPrompt,
      reply,
      findings: brokerFindings(reply, c.expect({ posting, market, terms })),
      human: null,
    })
  }
}

// -- Grace -------------------------------------------------------------------

async function driverRun(carrier) {
  const config = chatConfigFor('driver')
  say(`## Grace — primary ${config.model} · prompt ${promptVersion('driverChat/driverChat.prompt.js')}`)
  say('')
  const name = process.env.TELEGRAM_DRIVER_NAME || 'Grace Lindqvist'
  const id = (await query('SELECT id FROM drivers WHERE name = $1', [name])).rows[0]?.id
  if (!id) throw safeEvalError('Configured driver not found')
  const ctx = await getDriverContext(id)
  const standing = await driverStanding(null, id)
  const now = Date.now()
  // ED08 needs a load into New York and ED02 needs any load to give an ETA
  // for, whatever she is really on -- labelled as not in the database
  // wherever it is shown. The pickup is her own city (evalFixtures.js).
  const nyc = nycFixtureLoad(ctx.driver, now)
  for (const c of driverCases) {
    const fixture = FIXTURE_LOAD_CASES.has(c.id)
    const load = fixture ? nyc : ctx.load
    const systemPrompt = dp.buildDriverSystemPrompt({ driver: ctx.driver, standing, load, carrier })
    const { reply, model } = await ask(config, dp.buildMessages({ systemPrompt, history: [], newMessage: c.line }), 'driver')
    const situation = dp.situationLines({ driver: ctx.driver, load }).map((l) => l.trim())
    record({
      runId, at: new Date().toISOString(), chat: 'driver', caseId: c.id, style: c.style, terms: c.terms, line: c.line, good: c.good,
      model, promptVersion: promptVersion('driverChat/driverChat.prompt.js'),
      data: {
        driver: ctx.driver.name, load: load ? `${load.originCity}, ${load.originState} -> ${load.destinationCity}, ${load.destinationState}${fixture ? ' (not in the database)' : ''}` : null,
        situation, requests: dp.requestLines(ctx.driver, load).map((l) => l.trim()).filter(Boolean),
        pay: { unpaidCount: standing.unpaidCount, owedUsd: standing.owedUsd, daysOverdue: standing.daysOverdue },
      },
      dataSummary: `${situation.join(' ')}${load ? ` · load ${load.originCity} → ${load.destinationCity}${fixture ? ' (not in the database)' : ''}` : ' · no load'}`
        + ` · pay: ${standing.unpaidCount > 0 ? `owed $${Math.round(standing.owedUsd)} (${standing.unpaidCount})` : 'nothing owed'}`,
      systemPrompt,
      reply,
      findings: driverFindings(reply, c.expect({ driver: ctx.driver, load, standing, fuelPct: dp.fuelPercent(ctx.driver) }), { onTheRoad: ctx.driver.onTheRoad }),
      human: null,
    })
  }
}

// -- Run ---------------------------------------------------------------------

const runBroker = only !== 'driver' && brokerCases.length > 0
const runDriver = only !== 'broker' && driverCases.length > 0
const planned = (runBroker ? brokerCases.length : 0) + (runDriver ? driverCases.length : 0)
const sides = [runBroker && 'broker', runDriver && 'driver'].filter(Boolean)
const budget = Math.min(...sides.map((w) => dailyBudgetFor(chatConfigFor(w).baseUrl, appConfig.chatRequestsPerDay)))
const used = Math.max(...await Promise.all(sides.map(usedToday)))
const refusal = budgetRefusal({ planned, budget, used, hint: 'Run broker and driver separately, or wait for tomorrow.' })
if (refusal) {
  console.error(refusal)
  await pool.end()
  process.exit(1)
}

let aborted = null
try {
  const carrier = await getCarrier()
  say(`# Chat evaluation — ${startedAt.toISOString()}`)
  say(`Cases: ${planned} · planned requests ~${planned} of a daily budget of ${budget} (a second try adds one).`)
  say('')
  if (runBroker) await brokerRun(carrier)
  if (runDriver) await driverRun(carrier)
  if (rows.length === 0) throw safeEvalError('No cases completed')
  semanticFailure = rows.some((row) => row.findings.includes(CLASSIFIER_ONLY_FINDING))
  if (semanticFailure) say('Reply validation failed: a classifier label was returned instead of a chat reply.')
  else say('Grade each case: **Accurate?** yes / partly / no, and **Why?** in a few words. The grades go into dataset.jsonl (`human`).')
} catch (err) {
  // The request error from ask() is already sanitized. A database error
  // might contain query data, so only state the fact of the failed run.
  aborted = err
  const reason = err.safeForConsole ? ` ${err.message}` : ''
  console.error(`Chat evaluation aborted after ${requests} provider request(s); ${rows.length} case(s) completed.${reason}`)
} finally {
  if (rows.length > 0) {
    const flagged = rows.filter((r) => r.findings.length > 0)
    say(aborted ? '## Aborted run — completed cases only' : semanticFailure ? '## Reply validation failed' : '## Summary')
    say('')
    say(`Cases completed: ${rows.length} · with automatic findings: ${flagged.length}${flagged.length ? ` (${flagged.map((r) => r.caseId).join(', ')})` : ''}`)
    say(`Requests sent: ${requests}${retries ? ` (${retries} second ${retries === 1 ? 'try' : 'tries'})` : ''}`)
    mkdirSync(outDir, { recursive: true })
    const mdFile = writeEvalReport(outDir, runId, md.join('\n') + '\n')
    appendFileSync(join(outDir, 'dataset.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    console.log(`\nWritten: ${mdFile}\nAppended ${rows.length} completed rows to ${join(outDir, 'dataset.jsonl')}`)
  } else {
    console.log('No cases completed; no evaluation report or dataset rows written.')
  }
  await pool.end()
}
if (aborted || semanticFailure) process.exitCode = 1
