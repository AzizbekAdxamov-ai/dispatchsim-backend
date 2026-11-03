// Scripted conversations with the REAL broker and driver prompts and the
// REAL model -- the way a dispatcher actually types, using the trade's
// words -- written to a transcript for review.
//
//   npm run chat:scenarios                       # both, ~20 model requests
//   npm run chat:scenarios -- broker             # broker only (~13)
//   npm run chat:scenarios -- driver             # Grace only (~7)
//   npm run chat:scenarios -- --scenario S2,G1   # only those scenarios
//   npm run chat:scenarios -- broker --times 3   # every scenario 3 times (~39)
//   npm run chat:scenarios -- broker --gap 20    # wait 20 s between requests (per-minute token limit)
//   npm run chat:scenarios -- --service          # what the live app would show: the same reply
//                                                # check and ONE regeneration per turn (up to 2x requests)
//
// --times runs the same conversations on the same loads again, so a
// finding can be counted ("S4 agreed in 2 of 3") instead of seen once.
// A plan larger than the provider's daily budget is refused before the
// first request: they are taken out of the same day as the app's.
// Each call's cost is written to chat_script_requests (058), which the
// daily budget and chat:usage count.
//
// Why a script and not the app: the conversations have to be the same
// every run so two runs can be compared, and they have to hit the exact
// prompt builders the app uses (system prompt, market block, the terms
// the carrier used, the broker's own accessorial terms; Grace's place,
// her requests, her empty run). No threads or messages are written; the only
// rows are the request counts (058). The provider's own daily limit
// still applies -- each turn is one request -- so the count is printed
// first.
//
// The transcript goes to ../reports/chat-scenarios-<time>.md. Every reply
// carries the same checks the services run before showing a reply:
// banned word, leaked reasoning, too long. Here they are reported, not
// regenerated (unless --service, which does what the live service does and
// shows the model's first reply beside the final one) -- the point is to
// see what the model does. On top of those,
// the checks in scenarioChecks.js -- each one a failure seen in a real run
// -- and a count of them at the end.

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, query } from '../src/db/pool.js'
import { chatConfigFor } from '../src/modules/chat/chatProvider.js'
import { chatText } from './seed/aiClient.js'
import { sleep } from './seed/config.js'
import { parseGap, parseIdList, makeRequestPacer, attemptsLine } from './evalAttempts.js'
import { promptVersionOf } from '../src/lib/promptVersion.js'
import { chatTextRecorded, usedToday, budgetRefusal } from '../src/modules/chat/scriptRequests.js'
import { tooLongForChat, dailyBudgetFor, groqReasoningParams } from '../src/constants/chatBudget.js'
import appConfig from '../src/config.js'
import { asciiPunct } from '../src/lib/plainText.js'
import {
  brokerReply, driverReply, correctCount, BROKER_EXPECT, DRIVER_EXPECT, summarize,
  s9Ask, s9Email, s9Mc, s9WrongMc, afterTomorrowSixCentral, bookedBeforeAskingMc,
} from './scenarioChecks.js'
import { findCity } from './seed/cities.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { marketFacts } from '../src/constants/marketRates.js'
import { relativeDay, APP_TIMEZONE } from '../src/constants/appClock.js'
import { talkFacts } from '../src/constants/freightTerms.js'
import { brokerTerms, termsLines } from '../src/constants/accessorials.js'
import * as brokerRepo from '../src/modules/brokerChat/brokerChat.repository.js'
import * as bp from '../src/modules/brokerChat/brokerChat.prompt.js'
import * as dp from '../src/modules/driverChat/driverChat.prompt.js'
import { getDriverContext } from '../src/modules/driverChat/driverChat.repository.js'
import { driverStanding } from '../src/modules/payroll/payroll.service.js'
import { getCarrier } from '../src/modules/carrier/carrier.repository.js'
import { serviceReply } from './serviceReply.js'
import { brokerReplyProblem, brokerRetryPrompt } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem, driverRetryPrompt } from '../src/modules/driverChat/replyProblem.js'
import { truckFacts } from '../src/modules/brokerChat/truckTalk.js'
import { offerFacts } from '../src/modules/driverChat/offerTalk.js'
import { stripSpeakerLabel } from '../src/lib/speakerLabel.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const service = args.includes('--service')
const sideArg = args.find((a) => a === 'broker' || a === 'driver') ?? 'both'
const timesArg = args.find((a) => a.startsWith('--times'))
const times = timesArg
  ? Number(timesArg.includes('=') ? timesArg.split('=')[1] : args[args.indexOf(timesArg) + 1])
  : 1
if (!Number.isInteger(times) || times < 1) {
  console.error('--times wants a whole number of runs, 1 or more.')
  process.exit(1)
}
// --gap <seconds>: a pause before every request but the first, so the
// per-minute token limit is not hit by turns sent back to back.
const gap = parseGap(args)
if (gap.error) {
  console.error(gap.error)
  process.exit(1)
}
const gapSec = gap.seconds
const pauseBeforeRequest = makeRequestPacer({ gapSec, sleep })
const out = []
const say = (line = '') => { out.push(line); console.log(line) }
let requests = 0
let retries = 0
const results = []

// Turns per scenario -- the dispatcher lines below, counted. The keys are
// what --scenario accepts.
const TURNS = {
  S1: 3, S2: 3, S3: 2, S4: 1, S5: 1, S6: 1, S7: 1, S8: 1,
  S9a: 6, S9b: 6, S9c: 5,
  G1: 2, G2: 2, G3: 3,
}
const sideOf = (key) => (key.startsWith('G') ? 'driver' : 'broker')

// --scenario S2,G1: only those. Every key must exist, and sit on the side
// asked for (`broker` + G1 is a mistake worth naming).
const scenarioList = parseIdList(args, '--scenario')
if (scenarioList.error) {
  console.error(scenarioList.error)
  process.exit(1)
}
const chosen = scenarioList.ids ?? Object.keys(TURNS).filter((k) => sideArg === 'both' || sideOf(k) === sideArg)
for (const key of chosen) {
  if (!(key in TURNS)) {
    console.error(`Unknown scenario: ${key}`)
    process.exit(1)
  }
  if (sideArg !== 'both' && sideOf(key) !== sideArg) {
    console.error(`Scenario ${key} is not a ${sideArg} scenario`)
    process.exit(1)
  }
}
// Which sides have anything to run.
const only = !chosen.some((k) => sideOf(k) === 'broker') ? 'driver' : !chosen.some((k) => sideOf(k) === 'driver') ? 'broker' : 'both'
const wanted = (key) => chosen.includes(key)
const reasoningEffort = (config) => groqReasoningParams(config.baseUrl, config.model, config.chat).reasoning_effort ?? 'n/a'
const brokerPromptVersion = promptVersionOf(fileURLToPath(new URL('../src/modules/brokerChat/brokerChat.prompt.js', import.meta.url)))
const driverPromptVersion = promptVersionOf(fileURLToPath(new URL('../src/modules/driverChat/driverChat.prompt.js', import.meta.url)))

function flags(text, prompt, findings = []) {
  const f = []
  const banned = prompt.trippedBannedWord(text)
  if (banned) f.push(`BANNED WORD: ${banned}`)
  if (prompt.leaksReasoning(text)) f.push('LEAKS REASONING')
  if (tooLongForChat(text)) f.push(`TOO LONG (${text.trim().length} chars)`)
  if (text.startsWith('(FAILED')) f.push('FAILED')
  f.push(...findings.map((x) => `CHECK: ${x}`))
  return f.length ? ` **[${f.join(' · ')}]**` : ''
}

// Counted where requests are actually sent (aiClient onRequest), so a
// second try and a backoff retry are in the number.
async function ask(config, messages, side, cause) {
  let model = config.model
  const attempts = []
  try {
    const reply = await chatTextRecorded({
      chatText, source: 'scenarios', side, messages,
      config,
      beforeRequest: pauseBeforeRequest,
      ...(cause ? { cause } : {}),
      onRequest: () => { requests += 1 },
      onRetry: () => { retries += 1 },
      onModel: (answered) => { model = answered },
      onAttempt: (attempt) => { attempts.push(attempt) },
    })
    return { reply: reply.trim(), model, attempts }
  } catch {
    // A failed provider call is no broker/driver answer. Stop this run; the
    // finally block writes completed turns, without a fake reply in history.
    const error = new Error(`Provider request failed after ${requests} request(s); current scenario stopped. ${attemptsLine(attempts)}`)
    error.safeForConsole = true
    throw error
  }
}

// One turn's reply. Raw: the model's first reply. Service: the live
// service's path (serviceReply.js) with the shared checks; the system
// prompt of the retry is the one the live service would send.
async function answer({ config, side, messages, systemPrompt, clean, problemOf, retryPrompt, fallback }) {
  if (!service) {
    const first = await ask(config, messages(systemPrompt), side)
    return { reply: first.reply, raw: first.reply, model: first.model, attempts: first.attempts,
      regeneratedBecause: null, fellBack: false, stillFailing: null }
  }
  const attempts = []
  let model = config.model
  const call = async (sys, cause) => {
    const result = await ask(config, messages(sys), side, cause)
    attempts.push(...result.attempts)
    model = result.model
    return clean(result.reply)
  }
  const out = await serviceReply({
    first: () => call(systemPrompt),
    again: (sys) => call(sys, 'regenerate'),
    problemOf, retryPrompt, fallback, systemPrompt,
  })
  return { ...out, model, attempts: attempts.map((a, i) => ({ ...a, n: i + 1 })) }
}

// The lines of one turn: the model's first reply when the final one differs.
function sayReply(label, out, prompt, findings, config, promptVersion) {
  say(`- **${label} (raw):** ${out.raw}`)
  if (out.regeneratedBecause) {
    say(`- _regenerated because it ${out.regeneratedBecause}_`)
  }
  say(`- **${label} (final):** ${out.reply}${out.fellBack ? ' _(holding line)_' : ''}${flags(out.reply, prompt, findings)}`)
  if (out.stillFailing) say(`- _still failing after the second try: it ${out.stillFailing}_`)
  say(`- **Answering model:** \`${out.model}\` · **reasoning_effort:** ${reasoningEffort({ ...config, model: out.model })} · **prompt:** ${promptVersion}`)
  say(`- **Requests:** ${attemptsLine(out.attempts)}`)
}

// -- Broker -----------------------------------------------------------------

async function openPostings() {
  const r = await query(`
    SELECT p.id, p.origin_state AS "originState", p.destination_state AS "destinationState",
           p.equipment_type AS "equipmentType", p.pickup_at AS "pickupAt", p.broker_id AS "brokerId",
           p.origin_city AS "originCity", p.rate_hidden AS "rateHidden"
      FROM load_postings p
     WHERE p.status = 'open' AND p.broker_id IS NOT NULL
       AND p.posted_at <= now() AND p.expires_at > now() + interval '15 minutes'
     ORDER BY p.posted_at DESC LIMIT 400`)
  return r.rows
}

function pick(rows, used, test) {
  const row = rows.find((p) => !used.has(p.id) && test(p))
  if (row) used.add(row.id)
  return row ?? null
}

// "tomorrow" or the weekday, the two ways the pickup day can rightly be said.
function pickupDayPattern(pickupAt) {
  const iso = new Date(pickupAt).toISOString()
  const rel = relativeDay(iso, new Date().toISOString())
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: APP_TIMEZONE }).format(new Date(pickupAt))
  return [rel, weekday, weekday.slice(0, 3)].filter(Boolean).join('|')
}

async function brokerConversation({ key, title, posting, lines }, carrier, config, run) {
  const m = marketFacts(posting)
  const terms = brokerTerms(posting.name, posting.equipmentType)
  say(`### ${title}${times > 1 ? ` — run ${run}/${times}` : ''}`)
  say(`${posting.originCity}, ${posting.originState} → ${posting.destinationCity}, ${posting.destinationState} · ${posting.equipmentType} · ${posting.distanceMi} mi · $${posting.rateUsd} ($${(posting.rateUsd / posting.distanceMi).toFixed(2)}/mi)${posting.rateHidden ? ' · CALL FOR RATE' : ''}`)
  say(`Broker: ${posting.contactName} at ${posting.name} (${posting.creditRating}) · pickup ${relativeDay(new Date(posting.pickupAt).toISOString(), new Date().toISOString())}`)
  // A side with no regional figure carries the national one; printed as
  // the region's own, it read as a fact DAT never published (Upper
  // Mountain, 2026-10-06).
  const side = (s) => (s.source === 'regional' ? `${s.region} $${s.linehaul}` : `${s.region ?? 'that state'} (no regional figure)`)
  if (m) say(`Market: out of ${side(m.origin)} · reload out of ${side(m.destination)} · national $${m.national}`)
  say(`Broker's terms: ${termsLines(terms).join(' ')}`)
  say('')
  const expect = BROKER_EXPECT[key]?.({
    posting, market: m, terms, ask: Math.round(posting.rateUsd * 1.12), pickupDay: pickupDayPattern(posting.pickupAt),
    email: s9Email(carrier),
  }) ?? {}
  const history = []
  let previous = null
  for (const [turn, raw] of lines.entries()) {
    const text = typeof raw === 'function' ? raw(posting, m, { previous, carrier }) : raw
    const dispatcherSoFar = [...history.filter((h) => h.role === 'dispatcher').map((h) => h.content), text]
    // One clock for the prompt and the truck check, as in the live service.
    const now = new Date()
    const truck = truckFacts({ texts: dispatcherSoFar, posting, now })
    // Who is calling and what is missing, as the live service computes it.
    const booking = bookingFacts({ texts: dispatcherSoFar, carrier, posting, now })
    const brokerSaid = history.filter((h) => h.role === 'broker').map((h) => h.content)
    const systemPrompt = bp.buildBrokerSystemPrompt({
      carrier,
      broker: { name: posting.name, contactName: posting.contactName, persona: posting.persona },
      posting,
      now,
      talk: talkFacts(dispatcherSoFar, posting.equipmentType),
      said: dispatcherSoFar,
      booking,
      brokerSaid,
    })
    say(`- **D:** \`${text}\``)
    const out = await answer({
      config, side: 'broker', systemPrompt,
      messages: (sys) => bp.buildMessages({ systemPrompt: sys, history, newMessage: text }),
      clean: (t) => stripSpeakerLabel(t, posting.contactName),
      problemOf: (r) => brokerReplyProblem(r, {
        truck, booking, posting, now, text, said: dispatcherSoFar, brokerSaid,
      }),
      retryPrompt: brokerRetryPrompt,
      fallback: bp.FALLBACK_REPLY,
    })
    const reply = out.reply
    const findings = reply.startsWith('(FAILED')
      ? ['no reply']
      : [...brokerReply(reply, previous, text), ...(expect[turn]?.(asciiPunct(reply)) ?? [])]
    results.push({ scenario: key, run, findings })
    sayReply('B', out, bp, findings, config, brokerPromptVersion)
    history.push({ role: 'dispatcher', content: text }, { role: 'broker', content: reply })
    previous = reply
  }
  // Marcus's read-back is once per chat at most (062): more is the tic again.
  if (correctCount(history.filter((h) => h.role === 'broker').map((h) => h.content)) > 1) {
    results.push({ scenario: key, run, findings: ['correct? more than once'] })
  }
  // The booking call must ask for the MC before it says anything is booked.
  if (key.startsWith('S9') && bookedBeforeAskingMc(history.filter((h) => h.role === 'broker').map((h) => h.content))) {
    results.push({ scenario: key, run, findings: ['booked before asking MC'] })
  }
  const talk = talkFacts(history.filter((h) => h.role === 'dispatcher').map((h) => h.content), posting.equipmentType)
  say(`- _Counted trade words:_ ${talk.used.join(', ') || 'none'} · _raised:_ ${talk.confirm.filter((c) => c.raised).map((c) => c.label).join(', ') || 'none'}`)
  say('')
}

// The loads are chosen once and every run uses the same ones -- a count
// across runs means something only if the runs are of the same thing.
async function planBroker(ours) {
  const rows = await openPostings()
  if (rows.length === 0) { say('No open postings. Run: npm run refresh:postings'); return [] }
  const used = new Set()
  const plan = []
  const add = async (key, title, row, lines) => {
    if (!row) { say(`_${key} skipped: no open posting fits._\n`); return null }
    const posting = await brokerRepo.getPostingWithBroker(row.id)
    plan.push({ key, title, posting, lines })
    return posting
  }
  const weak = (p) => { const m = marketFacts(p); return m && m.destination.linehaul < m.national }
  const strong = (p) => { const m = marketFacts(p); return m && m.destination.source === 'regional' && m.destination.linehaul >= m.national }
  const tomorrow = (p) => relativeDay(new Date(p.pickupAt).toISOString(), new Date().toISOString()) === 'tomorrow'

  await add('S1', 'S1 — rookie, plain words', pick(rows, used, (p) => p.equipmentType === 'dry-van'),
    ['hi i want this load', 'how much u pay', 'can u pay more'])
  const s2 = await add('S2', 'S2 — casual pro, trade words', pick(rows, used, (p) => p.equipmentType === 'dry-van'), [
    'hey bro, that all in? im like 60 dh',
    'whats detention after free time, tonu if they cancel? layover?',
    'appt or fcfs at pu? any lumper at delivery?',
  ])
  await add('S3', 'S3 — hard negotiator, weak reload (real argument)', pick(rows, used, weak), [
    (p, m) => `DAT has ${m.destination.region.toLowerCase()} at ${m.destination.linehaul}, reload out of there is dead, ill be deadheading out. need $${Math.round(p.rateUsd * 1.12)}`,
    'meet me in the middle?',
  ])
  await add('S4', 'S4 — false claim, strong destination', pick(rows, used, strong),
    [(p) => `reload out of ${p.destinationCity.toLowerCase()} is terrible bro, i need more`])
  await add('S5', 'S5 — wrong market number', pick(rows, used, (p) => marketFacts(p)?.origin.source === 'regional'),
    [(p, m) => `DAT shows ${m.origin.region.toLowerCase()} ${p.equipmentType} at ${(m.origin.linehaul + 1.8).toFixed(2)} linehaul this week so ur way under`])
  await add('S6', 'S6 — reefer', pick(rows, used, (p) => p.equipmentType === 'reefer'), ['what temp? continuous or cycle? ill pre-cool'])
  await add('S7', 'S7 — days and times', pick(rows, used, tomorrow), ["when's pu and delivery?"])
  if (s2) {
    await add('S8', 'S8 — same broker as S2, terms again (must match S2)', pick(rows, used, (p) => p.brokerId === s2.brokerId),
      ['same q — detention, tonu, layover on this one?'])
  }
  // S9: the booking call, three ways, on ONE load: a dry van with its rate on
  // the board, picking up after the truck line's "empty tomorrow 6am", from a
  // city the distance code knows. Our company's own name and MC are typed;
  // the email is on the reserved .example domain, never a real address.
  if (ours) {
    const row = pick(rows, used, (p) => p.equipmentType === 'dry-van' && !p.rateHidden
      && afterTomorrowSixCentral(p.pickupAt) && findCity(p.originCity, p.originState))
    const email = s9Email(ours)
    const intro = (p) => `hey this is Aziz with ${ours.name}, calling about your ${p.originCity}-${p.destinationCity} load, still available?`
    const truckLine = (p) => `truck's in ${p.originCity}, empty tomorrow 6am, 53 dry van`
    const price = (p, m, ctx) => (/looking to pay|what (do|would) you need|your (number|rate)/i.test(ctx.previous ?? '')
      ? `can you do $${s9Ask(p)}?`
      : `what do you need on it? can you do $${s9Ask(p)}?`)
    const middle = 'meet me in the middle?'
    const bookIt = `ok book it. driver Grace Lindqvist, truck RS-9278-CY, send the rc to ${email}`
    await add('S9a', 'S9a — booking call, right MC', row, [intro, `MC ${s9Mc(ours)}`, truckLine, price, middle, bookIt])
    await add('S9b', 'S9b — booking call, wrong MC (no booking)', row, [intro, `MC ${s9WrongMc(ours)}`, truckLine, price, middle, bookIt])
    await add('S9c', 'S9c — booking call, no MC said', row, [intro, truckLine, price, middle, 'just book it'])
  } else {
    say('_S9 skipped: no carrier row._')
    say('')
  }
  return plan
}

async function runBroker(carrier) {
  const config = chatConfigFor('broker')
  say(`## Broker (model: ${config.model} · reasoning_effort ${reasoningEffort(config)})`)
  say('')
  const plan = await planBroker(carrier)
  for (let run = 1; run <= times; run++) {
    for (const s of plan.filter((p) => wanted(p.key))) await brokerConversation(s, carrier, config, run)
  }
}

// -- Grace --------------------------------------------------------------------

async function driverConversation({ key, title, load, lines }, base, config, run) {
  say(`### ${title}${times > 1 ? ` — run ${run}/${times}` : ''}`)
  say(load ? `Load in the prompt: ${load.originCity}, ${load.originState} → ${load.destinationCity}, ${load.destinationState}${load.hypothetical ? ' (HYPOTHETICAL — not in the database)' : ''}` : 'No load in the prompt.')
  say('')
  const expect = DRIVER_EXPECT[key]?.({
    city: base.driver.currentCity, hasEta: Boolean(load?.etaAt), fuelPct: dp.fuelPercent(base.driver),
  }) ?? {}
  const history = []
  let previous = null
  for (const [turn, text] of lines.entries()) {
    // The load the lines mention, worked out by code as the live chat does
    // (driverChat.service.js): this line and the last four of theirs.
    const offer = offerFacts({
      driver: base.driver,
      load,
      texts: [...history.filter((h) => h.role === 'dispatcher').slice(-4).map((h) => h.content), text],
    })
    const systemPrompt = dp.buildDriverSystemPrompt({ driver: base.driver, standing: base.standing, load, carrier: base.carrier, offer,
      text, history, echoes: dp.repetitionHint(history, text) })
    say(`- **D:** \`${text}\``)
    const out = await answer({
      config, side: 'driver', systemPrompt,
      messages: (sys) => dp.buildMessages({ systemPrompt: sys, history, newMessage: text }),
      clean: (t) => stripSpeakerLabel(t, base.driver.name),
      problemOf: (r) => driverReplyProblem(r, { offer, text, load, driver: base.driver, standing: base.standing, history }),
      retryPrompt: driverRetryPrompt,
      fallback: dp.FALLBACK_REPLY,
    })
    const reply = out.reply
    const findings = reply.startsWith('(FAILED')
      ? ['no reply']
      : [...driverReply(reply, previous, { onTheRoad: base.driver.onTheRoad }), ...(expect[turn]?.(asciiPunct(reply)) ?? [])]
    results.push({ scenario: key, run, findings })
    sayReply('G', out, dp, findings, config, driverPromptVersion)
    history.push({ role: 'dispatcher', content: text }, { role: 'driver', content: reply })
    previous = reply
  }
  say('')
}

async function runDriver(carrier) {
  const config = chatConfigFor('driver')
  say(`## Grace (model: ${config.model} · reasoning_effort ${reasoningEffort(config)})`)
  say('')
  const name = process.env.TELEGRAM_DRIVER_NAME || 'Grace Lindqvist'
  const id = (await query('SELECT id FROM drivers WHERE name = $1', [name])).rows[0]?.id
  if (!id) { say(`No driver named ${name}.`); return }
  const ctx = await getDriverContext(id)
  const base = { driver: ctx.driver, standing: await driverStanding(null, id), carrier }
  say(`Database: parked in ${ctx.driver.parkedCity ?? '?'}, ${ctx.driver.parkedState ?? '?'} · now ${ctx.driver.onTheRoad ? 'on the road near' : 'in'} ${ctx.driver.currentCity}, ${ctx.driver.currentState} · ${ctx.driver.dutyStatus} · load: ${ctx.load ? `${ctx.load.originCity} → ${ctx.load.destinationCity}` : 'none'}`)
  say('')

  const now = Date.now()
  const nyc = {
    id: 'TEST-NY', originCity: 'Nashville', originState: 'TN', destinationCity: 'New York', destinationState: 'NY',
    distanceMi: 895, dispatchedAt: new Date(now - 3600e3), etaAt: new Date(now + 8 * 3600e3), deliveryAt: new Date(now + 9 * 3600e3),
    hypothetical: true,
  }
  const plan = [
    { key: 'G1', title: 'G1 — casual hello', load: ctx.load, lines: ['Grace hey bro how r u doin?', 'got a load for u in a min'] },
    { key: 'G2', title: 'G2 — trade words', load: ctx.load, lines: ['Grace whats ur eta, any detention at the shipper?', 'Grace where u at'] },
    { key: 'G3', title: 'G3 — the New York load (once, not again)', load: nyc, lines: ['Grace ur on the NYC load', 'Grace whats ur fuel at', 'Grace got a dallas load next'] },
  ]
  for (let run = 1; run <= times; run++) {
    for (const s of plan.filter((p) => wanted(p.key))) await driverConversation(s, base, config, run)
  }
}

// -- Run ----------------------------------------------------------------------

const planned = times * chosen.reduce((sum, key) => sum + TURNS[key], 0)
const budgets = [...new Set([only !== 'driver' && 'broker', only !== 'broker' && 'driver'].filter(Boolean))]
  .map((w) => dailyBudgetFor(chatConfigFor(w).baseUrl, appConfig.chatRequestsPerDay))
const budget = Math.min(...budgets)
const used = Math.max(...await Promise.all([...new Set([only !== 'driver' && 'broker', only !== 'broker' && 'driver'].filter(Boolean))].map(usedToday)))
const refusal = budgetRefusal({ planned, budget, used, hint: 'Run fewer times, or broker and driver on separate days.' })
if (refusal) {
  console.error(refusal)
  await pool.end()
  process.exit(1)
}

const carrier = await getCarrier()
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
say(`# Chat scenarios — ${new Date().toISOString()}`)
say(`Planned requests: ~${planned}${times > 1 ? ` (${times} runs)` : ''} of a daily budget of ${budget}. A second try adds one.${service ? ` --service: a regeneration adds one more per turn (up to ${planned * 2}).` : ''}${gapSec > 0 ? ` ${gapSec} s between requests.` : ''}`)
say('')
let aborted = null
try {
  if (only !== 'driver') await runBroker(carrier)
  if (only !== 'broker') await runDriver(carrier)
} catch (err) {
  aborted = err
  say(`Run stopped: ${err.safeForConsole ? err.message : 'run error; completed turns preserved.'}`)
} finally {
  const { lines, clean } = summarize(results, times)
  if (aborted) say('_Aborted run: completed turns only._')
  say('## Checks')
  say('')
  say(lines.length ? '| Scenario | Finding | Runs |\n|---|---|---|' : 'No check flagged anything.')
  for (const l of lines) say(l)
  if (lines.length) say('')
  if (!aborted && clean.length) say(`Nothing flagged in: ${clean.join(', ')}.`)
  say('A check is a pattern: read the flagged line before calling it a failure.')
  say('')
  say(`---\nRequests sent: ${requests}${retries ? ` (${retries} second ${retries === 1 ? 'try' : 'tries'})` : ''}`)
  const dir = join(here, '..', '..', 'reports')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `chat-scenarios-${stamp}.md`)
  writeFileSync(file, out.join('\n') + '\n')
  console.log(`\nWritten: ${file}`)
  await pool.end()
}
if (aborted) process.exitCode = 1
