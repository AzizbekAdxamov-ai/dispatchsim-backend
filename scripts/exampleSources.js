// Where the example bank gets its material: graded chat turns, read from the
// three places they live and joined to their grade.
//
//   live       reports/training/turns-*.jsonl      (chat-export.js)
//   eval       reports/eval/dataset.jsonl          (chat-eval.js)
//   scenarios  reports/chat-scenarios-<stamp>.md   (chat-scenarios.js)
//
// Grades come from reports/training/grades.jsonl. Pure: text and rows in,
// rows out. No file, database or model is touched here; the CLI
// (buildExamples.js) reads the files and hands the text over.
//
// Every turn comes out with the same "facts" shape (factsFromEval,
// factsFromLive, factsFromScenario): the numbers and names the chat was
// given, so exampleBank.js can turn a reply into a template ("$632 is
// all-in" -> "{rate} is all-in") without guessing which number is which.

import { readJsonl } from './trainingRows.js'
import { brokerTerms } from '../src/constants/accessorials.js'
import { marketFacts } from '../src/constants/marketRates.js'
import { pickupCity } from '../src/modules/driverChat/offerTalk.js'

export { readJsonl }

// Policy for a grade history that contains a `no`. false: the LATEST grade
// decides (a `no` that was later corrected to `yes` stays eligible, flagged
// and ranked lower). true: any `no` anywhere disqualifies the turn.
export const STRICT_NO = false

export const HUMAN_GRADERS = Object.freeze(['nova', 'azizbek', 'database'])
export const isHumanGrader = (by) => HUMAN_GRADERS.includes(by)

const GRADES = ['yes', 'partly', 'no']

// -- Grade ids ----------------------------------------------------------------

// live:15
// eval:<runId>:<caseId>          runId is 2026-10-12-09-43 or a long
//                                2026-10-14-08-46-21-555-<uuid>; the case id
//                                is whatever follows the LAST colon.
// scenarios:<stamp>:<key>[:turnN]
export function parseGradeId(id) {
  const s = String(id ?? '')
  let m = /^live:(\d+)$/.exec(s)
  if (m) return { source: 'live', liveId: m[1], caseId: null, turn: null }
  if (s.startsWith('eval:')) {
    const rest = s.slice('eval:'.length)
    const at = rest.lastIndexOf(':')
    if (at <= 0 || at === rest.length - 1) return null
    return { source: 'eval', runId: rest.slice(0, at), caseId: rest.slice(at + 1), turn: null }
  }
  m = /^scenarios:(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}):([^:]+?)(?::turn(\d+))?$/.exec(s)
  if (m) return { source: 'scenarios', stamp: m[1], key: m[2], turn: m[3] ? Number(m[3]) : null }
  return null
}

const atValue = (g) => {
  const t = Date.parse(g.at ?? '')
  return Number.isNaN(t) ? null : t
}

// Every grade per id, oldest first (by `at`, then file order). Lines without
// an id or with an unknown grade are skipped, as withGrades does.
export function gradeHistory(grades) {
  const byId = new Map()
  ;(grades ?? []).forEach((g, order) => {
    if (!g?.id || !GRADES.includes(g.grade)) return
    if (!byId.has(g.id)) byId.set(g.id, [])
    byId.get(g.id).push({ grade: g.grade, note: g.note ?? '', by: g.by ?? null, at: g.at ?? null, order })
  })
  for (const list of byId.values()) {
    list.sort((a, b) => {
      const ta = atValue(a)
      const tb = atValue(b)
      if (ta !== null && tb !== null && ta !== tb) return ta - tb
      if ((ta === null) !== (tb === null)) return ta === null ? -1 : 1
      return a.order - b.order
    })
  }
  return byId
}

export const latestGrade = (history) => (history?.length ? history[history.length - 1] : null)

// -- Small parsers ---------------------------------------------------------------

const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')))

export function cityState(text) {
  const m = /^\s*(.+?),\s*([A-Z]{2})\s*$/.exec(String(text ?? ''))
  return m ? { city: m[1].trim(), state: m[2] } : null
}

// "Allentown, PA -> Atlanta, GA" | "... → ..." | "... to ..."
export function laneParts(text) {
  const m = /^\s*(.+?,\s*[A-Z]{2})\s*(?:->|→|\sto\s)\s*(.+?,\s*[A-Z]{2})\s*$/.exec(String(text ?? ''))
  return m ? { origin: cityState(m[1]), dest: cityState(m[2]) } : null
}

// "Detention (open-deck freight): $75/hr after 3 hours free, ... TONU: $475 ...
// Layover: $200 per day ..." -- the wording of termsLines (accessorials.js).
export function termsFromText(text) {
  const s = String(text ?? '')
  const det = /Detention[^:$]*:\s*\$(\d[\d,]*)\/hr after (\d+) hours? free/i.exec(s)
  const tonu = /TONU:\s*\$(\d[\d,]*)/i.exec(s)
  const lay = /Layover:\s*\$(\d[\d,]*)/i.exec(s)
  return {
    detention: det ? num(det[1]) : null,
    freeHours: det ? Number(det[2]) : null,
    tonu: tonu ? num(tonu[1]) : null,
    layover: lay ? num(lay[1]) : null,
  }
}

// "Upper Atlantic $2.56" | "Southeast (no regional figure)" -> { region, value }
export function regionFigure(text) {
  const s = String(text ?? '').trim()
  let m = /^(.+?)\s+\$(\d+(?:\.\d+)?)$/.exec(s)
  if (m) return { region: m[1], value: Number(m[2]) }
  m = /^(.+?)\s+\(no regional figure\)$/.exec(s)
  return m ? { region: m[1], value: null } : null
}

// The market, from the prompt's wording ("Freight out of X: $a/mi. National:
// $n/mi.") or the scenario header's ("out of X $a · reload out of Y $b ·
// national $n"). null when neither is there.
export function marketFromText(text) {
  const s = String(text ?? '')
  const sides = [...s.matchAll(/Freight out of (.+?): (?:\$(\d+(?:\.\d+)?)\/mi|no regional figure this week \(national \$(\d+(?:\.\d+)?)\/mi\))/g)]
  if (sides.length >= 2) {
    const national = /National: \$(\d+(?:\.\d+)?)\/mi/.exec(s)?.[1] ?? sides[0][3] ?? sides[1][3] ?? null
    const side = (m) => ({ region: m[1], value: m[2] != null ? Number(m[2]) : null })
    return { origin: side(sides[0]), dest: side(sides[1]), national: national != null ? Number(national) : null }
  }
  const md = /out of (.+?) (?:\$(\d+(?:\.\d+)?)|\(no regional figure\))\s*·\s*reload out of (.+?) (?:\$(\d+(?:\.\d+)?)|\(no regional figure\))\s*·\s*national \$(\d+(?:\.\d+)?)/.exec(s)
  if (md) {
    return {
      origin: { region: md[1], value: md[2] != null ? Number(md[2]) : null },
      dest: { region: md[3], value: md[4] != null ? Number(md[4]) : null },
      national: Number(md[5]),
    }
  }
  return null
}

// -- The facts shape -------------------------------------------------------------

export function blankFacts(side) {
  return {
    side,
    rate: null, rpm: null, ceiling: null, rateHidden: false,
    miles: null, equipment: null, lengthFt: null, weightLbs: null, commodity: null,
    origin: null, dest: null, pickup: null, delivery: null,
    market: { origin: null, dest: null, national: null },
    terms: { detention: null, freeHours: null, tonu: null, layover: null },
    brokerContact: null, brokerCompany: null,
    carrier: null, // the carrier the broker was talking to, when the prompt names one (old prompts)
    driver: {
      name: null, carrier: null, city: null, state: null, home: null, truckId: null,
      fuelPct: null, hoursLeft: null, owedUsd: null, load: null,
    },
    offer: null,
    flags: [],
  }
}

const hasTerms = (t) => Object.values(t).some((v) => v != null)

// Fill what a prompt or a header did not carry from the current tables.
// They are today's tables: an older chat may have been given other figures,
// so the use is flagged and the example ranks lower.
function withFallbacks(f) {
  if (f.side !== 'broker') return f
  if (!hasTerms(f.terms) && f.brokerCompany && f.equipment) {
    const t = brokerTerms(f.brokerCompany, f.equipment)
    f.terms = { detention: t.detentionPerHour, freeHours: t.freeHours, tonu: t.tonuUsd, layover: t.layoverPerDay }
    f.flags.push('facts from fallback: terms')
  }
  if (!f.market.origin && !f.market.dest && f.origin && f.dest && f.equipment) {
    const m = marketFacts({ originState: f.origin.state, destinationState: f.dest.state, equipmentType: f.equipment })
    if (m) {
      const side = (s) => ({ region: s.region ?? null, value: s.source === 'regional' ? s.linehaul : null })
      f.market = { origin: side(m.origin), dest: side(m.destination), national: m.national }
      f.flags.push('facts from fallback: market')
    }
  }
  return f
}

// -- Broker prompt -----------------------------------------------------------------

export function brokerFactsFromPrompt(prompt) {
  const f = blankFacts('broker')
  const p = String(prompt ?? '')
  if (!p) { f.flags.push('no system prompt'); return f }

  let m = /^You are (.+?), a freight broker at (.+?)\.\s*$/m.exec(p)
  if (m) { f.brokerContact = m[1]; f.brokerCompany = m[2] }
  m = /You are talking to (.+?) \(MC-?\d+\), a carrier/.exec(p)
  if (m) f.carrier = m[1]

  const load = p.split('THE LOAD YOU POSTED:')[1]?.split(/\n\s*\n/)[0] ?? ''
  const lane = /^\s+(.+?, [A-Z]{2}) to (.+?, [A-Z]{2})\s*$/m.exec(load)
  if (lane) { f.origin = cityState(lane[1]); f.dest = cityState(lane[2]) }
  m = /(\d[\d,]*) miles · (.+?) · (\d[\d,]*) lbs/.exec(load)
  if (m) { f.miles = num(m[1]); f.commodity = m[2]; f.weightLbs = num(m[3]) }
  m = /Equipment: ([a-z-]+), (\d+) ft/.exec(load)
  if (m) { f.equipment = m[1]; f.lengthFt = Number(m[2]) }
  m = /What it is worth to you is\s+\$(\d[\d,]*) \(about \$(\d+(?:\.\d+)?) per mile\)/.exec(load)
  if (m) f.rateHidden = true
  else m = /Posted rate: \$(\d[\d,]*) \(about \$(\d+(?:\.\d+)?) per mile\)/.exec(load)
  if (m) { f.rate = num(m[1]); f.rpm = Number(m[2]) }
  f.pickup = /^\s*Pickup: (.+)$/m.exec(load)?.[1] ?? null
  f.delivery = /^\s*Delivery: (.+)$/m.exec(load)?.[1] ?? null

  const market = p.split('THE MARKET THIS WEEK')[1]?.split(/\n\s*\n/)[0]
  if (market) f.market = marketFromText(market) ?? f.market
  const terms = p.split('YOUR TERMS (')[1]?.split(/\n\s*\n/)[0]
  if (terms) f.terms = termsFromText(terms)
  m = /Your absolute ceiling on\s+this load is \$(\d[\d,]*) \(\$(\d+(?:\.\d+)?)\/mi\)/.exec(p)
  if (m) f.ceiling = num(m[1])
  return f
}

// -- Driver prompt -------------------------------------------------------------------

export function driverFactsFromPrompt(prompt) {
  const f = blankFacts('driver')
  const p = String(prompt ?? '')
  if (!p) { f.flags.push('no system prompt'); return f }
  const d = f.driver

  let m = /^You are (.+?), a company driver(?: at (.+?))?, with a CDL/m.exec(p)
  if (m) { d.name = m[1]; d.carrier = m[2] ?? null }
  m = /Home base: (.+?, [A-Z]{2})/.exec(p)
  if (m) d.home = cityState(m[1])
  m = /You drive truck (\S+?)\.\s*$/m.exec(p)
  if (m) d.truckId = m[1]
  m = /You are running load (\S+): (.+?, [A-Z]{2})\s+to (.+?, [A-Z]{2}), (\d[\d,]*) miles/.exec(p)
  if (m) d.load = { id: m[1], origin: cityState(m[2]), dest: cityState(m[3]), miles: num(m[4]) }
  m = /You are (?:in|on the road near) (.+?, [A-Z]{2}) right now/.exec(p)
  if (m) { const c = cityState(m[1]); d.city = c.city; d.state = c.state }
  m = /Fuel: about (\d+)% of the tank/.exec(p)
  if (m) d.fuelPct = Number(m[1])
  m = /Driving time left today: (.+?)\.\s*$/m.exec(p)
  if (m) d.hoursLeft = m[1]
  m = /Owed \$(\d[\d,]*) across/.exec(p)
  if (m) d.owedUsd = num(m[1])

  // THE LOAD DISPATCH JUST MENTIONED (driverChat.prompt.js, offerLines)
  m = /Pickup in (.+?, [A-Z]{2}|[^,\n]+?) is about ([\d,]+) road miles from (?:where you are|(.+?), where the load you are on delivers)/.exec(p)
  const unknown = /You do not know how far (.+?) is; ask for the miles/.exec(p)
  if (m) {
    const place = cityState(m[1]) ?? { city: m[1], state: null }
    f.offer = { ...place, miles: num(m[2]), earliest: null, pickupSaid: null, makesIt: null }
    if (m[3]) f.offer.fromCity = m[3]
  } else if (unknown) {
    const place = cityState(unknown[1]) ?? { city: unknown[1], state: null }
    f.offer = { ...place, miles: null, earliest: null, pickupSaid: null, makesIt: null }
  }
  if (f.offer) {
    f.offer.earliest = /the earliest you could be there is (.+?)\.\s*$/m.exec(p)?.[1] ?? null
    const said = /The pickup they said is (.+?) -- you (can|cannot) make it/.exec(p)
    if (said) { f.offer.pickupSaid = said[1]; f.offer.makesIt = said[2] === 'can' }
  }
  return f
}

// -- Rows -> facts --------------------------------------------------------------------

// A chat-eval row: the case's own data (what the harness wrote down) over
// what the prompt says; the prompt fills what the data does not carry.
export function factsFromEval(row) {
  const data = row?.data ?? {}
  if (row?.chat === 'driver') {
    // Without the prompt, the situation lines carry most of it.
    const prompt = row.systemPrompt
      ?? [...(data.situation ?? []), data.pay ? `Owed $${data.pay.owedUsd} across ${data.pay.unpaidCount} settlement` : ''].join('\n')
    const f = driverFactsFromPrompt(prompt)
    if (!row.systemPrompt) f.flags.push('no system prompt: partial facts')
    if (data.driver && !f.driver.name) f.driver.name = data.driver
    if (data.pay?.owedUsd != null && f.driver.owedUsd == null) f.driver.owedUsd = data.pay.owedUsd
    return f
  }
  const f = brokerFactsFromPrompt(row?.systemPrompt)
  if (data.contact) f.brokerContact = data.contact
  if (data.broker) f.brokerCompany = data.broker
  const lane = laneParts(data.lane)
  if (lane) { f.origin = lane.origin; f.dest = lane.dest }
  if (data.equipment) f.equipment = data.equipment
  if (data.miles != null) f.miles = data.miles
  if (data.rateUsd != null) f.rate = data.rateUsd
  if (data.rpm != null) f.rpm = data.rpm
  if (data.rateHidden != null) f.rateHidden = Boolean(data.rateHidden)
  if (data.pickup) f.pickup = data.pickup
  if (data.market) {
    const origin = regionFigure(data.market.origin)
    const dest = regionFigure(data.market.reload)
    if (origin || dest) f.market = { origin, dest, national: data.market.national ?? null }
  }
  if (Array.isArray(data.terms) && data.terms.length) {
    const t = termsFromText(data.terms.join(' '))
    if (hasTerms(t)) f.terms = t
  }
  return withFallbacks(f)
}

// A live chat_turn_log row: nothing but the prompt it was given.
export function factsFromLive(row) {
  if (row?.chat === 'driver') return driverFactsFromPrompt(row.systemPrompt)
  return withFallbacks(brokerFactsFromPrompt(row?.systemPrompt))
}

// A scenario turn: the header chat-scenarios.js printed under the title.
export function factsFromScenario(turn, header = turn?.header ?? {}) {
  if (turn?.chat === 'driver') {
    const f = blankFacts('driver')
    f.driver.name = turn.speaker ?? null
    const now = /now (?:in|on the road near) (.+?, [A-Z]{2})/.exec(header.databaseLine ?? '')
    if (now) { const c = cityState(now[1]); f.driver.city = c.city; f.driver.state = c.state }
    const load = /^Load in the prompt: (.+?, [A-Z]{2}) → (.+?, [A-Z]{2})/.exec(header.loadLine ?? '')
    if (load) f.driver.load = { id: null, origin: cityState(load[1]), dest: cityState(load[2]), miles: null }
    if (pickupCity(turn?.line ?? '')) f.flags.push('offer miles not printed in the scenario file')
    return f
  }
  const f = blankFacts('broker')
  const lane = (header.laneLine ?? '').split(' · ')
  const route = laneParts(lane[0])
  if (route) { f.origin = route.origin; f.dest = route.dest }
  f.equipment = lane[1] ?? null
  f.miles = num(/^(\d[\d,]*) mi$/.exec(lane[2] ?? '')?.[1])
  const price = /^\$(\d[\d,]*) \(\$(\d+(?:\.\d+)?)\/mi\)$/.exec(lane[3] ?? '')
  if (price) { f.rate = num(price[1]); f.rpm = Number(price[2]) }
  f.rateHidden = lane.includes('CALL FOR RATE')
  const who = /^Broker: (.+?) at (.+?) \([A-Z]\) · pickup (.+)$/.exec(header.brokerLine ?? '')
  if (who) { f.brokerContact = who[1]; f.brokerCompany = who[2]; f.pickup = who[3] }
  f.market = marketFromText(header.marketLine) ?? f.market
  f.terms = termsFromText(header.termsLine)
  return withFallbacks(f)
}

// -- Scenario markdown -------------------------------------------------------------------

const FLAGS_AT_END = /\s*\*\*\[([^\]]*)\]\*\*\s*$/
const HOLDING_AT_END = /\s*_\(holding line\)_\s*$/

function finishTurn(t) {
  if (!t) return null
  let reply = t.final ?? t.plain ?? null
  let findings = []
  let holdingLine = false
  if (reply != null) {
    reply = reply.replace(/\s+$/, '')
    const flags = FLAGS_AT_END.exec(reply)
    if (flags) {
      findings = flags[1].split(' · ').map((x) => x.trim().replace(/^CHECK: /, '')).filter(Boolean)
      reply = reply.slice(0, flags.index)
    }
    if (HOLDING_AT_END.test(reply)) { holdingLine = true; reply = reply.replace(HOLDING_AT_END, '') }
    reply = reply.trim()
  }
  return { ...t, reply, findings, holdingLine }
}

// Markdown of one chat-scenarios run -> its turns. 1-based turn numbers
// over the dispatcher lines; both reply formats (`- **B:**` and the newer
// raw/final pair); multi-line replies. Never throws: a file this cannot read
// gives [].
export function parseScenarioMarkdown(text, stamp) {
  try {
    const out = []
    let section = null // { chat, speaker, databaseLine }
    let scenario = null
    let turn = null
    let reading = null
    let blanks = ''
    let index = 0

    const closeTurn = () => {
      const done = finishTurn(turn)
      if (done) out.push(done)
      turn = null
      reading = null
      blanks = ''
    }

    for (const line of String(text ?? '').split(/\r?\n/)) {
      let m
      if ((m = /^## (Broker|Grace)\b/.exec(line))) {
        closeTurn(); scenario = null
        section = { chat: m[1] === 'Broker' ? 'broker' : 'driver', speaker: m[1] === 'Grace' ? 'Grace' : null, databaseLine: null }
        continue
      }
      if (line.startsWith('## ')) { closeTurn(); scenario = null; section = null; continue }
      if ((m = /^### (\S+)(?:\s|$)/.exec(line))) {
        closeTurn()
        scenario = section ? { key: m[1], header: { databaseLine: section.databaseLine }, turns: 0, index: index++ } : null
        continue
      }
      if (!section) continue
      if (!scenario) {
        if (line.startsWith('Database: ')) section.databaseLine = line
        continue
      }
      if ((m = /^- \*\*D:\*\* `(.*)`\s*$/.exec(line))) {
        closeTurn()
        scenario.turns += 1
        turn = {
          id: `scenarios:${stamp}:${scenario.key}:turn${scenario.turns}`,
          source: 'scenarios', stamp, key: scenario.key, turn: scenario.turns,
          scenarioIndex: scenario.index, chat: section.chat, speaker: section.speaker,
          line: m[1], at: null, promptVersion: null, header: scenario.header, history: [],
        }
        continue
      }
      if ((m = /^- \*\*(?:B|G)(?: \((raw|final)\))?:\*\* ?(.*)$/.exec(line)) && turn) {
        const slot = m[1] === 'raw' ? 'raw' : m[1] === 'final' ? 'final' : 'plain'
        turn[slot] = m[2]
        reading = slot
        blanks = ''
        continue
      }
      if (line.startsWith('- ') || line.startsWith('#')) {
        if (turn && (m = /\*\*prompt:\*\* (\w+)/.exec(line))) turn.promptVersion = m[1]
        reading = null
        blanks = ''
        continue
      }
      if (turn && reading) {
        if (line.trim() === '') blanks += '\n'
        else { turn[reading] += `${blanks}\n${line}`; blanks = '' }
        continue
      }
      if (turn === null && scenario.turns === 0 && line.trim() !== '') {
        if (/^Broker: /.test(line)) scenario.header.brokerLine = line
        else if (/^Market: /.test(line)) scenario.header.marketLine = line
        else if (/^Broker's terms: /.test(line)) scenario.header.termsLine = line.slice("Broker's terms: ".length)
        else if (/^Load in the prompt: /.test(line)) scenario.header.loadLine = line
        else if (/^No load in the prompt/.test(line)) scenario.header.loadLine = 'none'
        else if (/^.+, [A-Z]{2} → .+, [A-Z]{2} · /.test(line)) scenario.header.laneLine = line
      }
    }
    closeTurn()

    // History for turn N is turns 1..N-1 of the same scenario.
    const prior = new Map()
    for (const t of out) {
      const k = `${t.scenarioIndex}`
      const list = prior.get(k) ?? []
      t.history = list.flatMap((p) => [
        { role: 'dispatcher', content: p.line },
        { role: p.chat, content: p.reply ?? '' },
      ])
      t.scenarioTurns = out.filter((x) => x.scenarioIndex === t.scenarioIndex).length
      list.push(t)
      prior.set(k, list)
    }
    return out.map(({ raw, final, plain, ...t }) => t)
  } catch {
    return []
  }
}

// -- Join -------------------------------------------------------------------------------------

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== ''

function whyExcluded(row) {
  if (row.error) return 'error'
  if (row.reply == null || !nonEmpty(String(row.reply))) return 'no reply'
  if (row.fellBack || row.holdingLine) return 'fell back (holding line)'
  if (String(row.reply).startsWith('(FAILED')) return 'failed reply'
  return null
}

// Grades x rows -> what can be used. The latest grade per id decides
// (STRICT_NO aside); only a `yes` is a candidate.
//
// evalRows / liveRows: arrays of rows (id = grade id); scenarioTurns: the
// output of parseScenarioMarkdown over every file, concatenated.
// Returns { joined: [{ id, source, row, facts, grade, history, flags }],
//           unjoined: [{ id, reason }], excluded: [{ id, source, reason }] }
export function joinGraded({ grades, evalRows = [], liveRows = [], scenarioTurns = [] }) {
  const history = gradeHistory(grades)
  const evalById = new Map(evalRows.map((r) => [r.id, r]))
  const liveById = new Map(liveRows.map((r) => [r.id, r]))
  // A grade kept on the row itself (the database's) counts when the file has none.
  for (const r of [...evalRows, ...liveRows]) {
    if (!history.has(r.id) && r.human && GRADES.includes(r.human.grade)) {
      history.set(r.id, [{ grade: r.human.grade, note: r.human.note ?? '', by: r.human.by ?? null, at: r.human.at ?? null, order: -1 }])
    }
  }

  const stamps = new Set(scenarioTurns.map((t) => t.stamp))
  const turnById = new Map(scenarioTurns.map((t) => [t.id, t]))
  const byScenario = new Map()
  for (const t of scenarioTurns) {
    const k = `${t.stamp}:${t.key}`
    if (!byScenario.has(k)) byScenario.set(k, new Map())
    const idx = byScenario.get(k)
    if (!idx.has(t.scenarioIndex)) idx.set(t.scenarioIndex, [])
    idx.get(t.scenarioIndex).push(t)
  }

  const joined = []
  const unjoined = []
  const excluded = []
  const seen = new Set()

  // Decide one resolved row: exclusion, then eligibility by the grade history.
  const take = ({ id, source, row, facts, hist, extraFlags = [] }) => {
    if (seen.has(id)) return
    seen.add(id)
    const gone = whyExcluded(row)
    if (gone) { excluded.push({ id, source, reason: gone }); return }
    const latest = latestGrade(hist)
    const whole = extraFlags.includes('whole-chat grade')
    if (latest.grade !== 'yes') {
      excluded.push({ id, source, reason: whole ? `whole-chat grade ${latest.grade}` : `latest grade ${latest.grade}` })
      return
    }
    const flags = [...extraFlags]
    const earlierNo = hist.slice(0, -1).filter((g) => g.grade === 'no')
    if (earlierNo.length) {
      if (STRICT_NO) { excluded.push({ id, source, reason: 'graded no earlier (strict)' }); return }
      flags.push(`regraded (no→yes by ${latest.by ?? 'unknown'})`)
    }
    joined.push({ id, source, row, facts, grade: latest, history: hist, flags })
  }

  for (const [gradeId, hist] of history) {
    const parsed = parseGradeId(gradeId)
    if (!parsed) { unjoined.push({ id: gradeId, reason: 'unrecognised id' }); continue }

    if (parsed.source === 'live' || parsed.source === 'eval') {
      const row = (parsed.source === 'live' ? liveById : evalById).get(gradeId)
      if (!row) {
        unjoined.push({ id: gradeId, reason: parsed.source === 'live' ? 'live row not in any turns file' : 'eval row not in dataset' })
        continue
      }
      const facts = parsed.source === 'live' ? factsFromLive(row) : factsFromEval(row)
      take({ id: gradeId, source: parsed.source, row, facts, hist })
      continue
    }

    // scenarios
    if (!stamps.has(parsed.stamp)) { unjoined.push({ id: gradeId, reason: `no scenario file for ${parsed.stamp}` }); continue }
    const copies = byScenario.get(`${parsed.stamp}:${parsed.key}`)
    if (!copies) { unjoined.push({ id: gradeId, reason: `scenario ${parsed.key} not in the ${parsed.stamp} file` }); continue }
    if (copies.size > 1) { unjoined.push({ id: gradeId, reason: `scenario ${parsed.key} appears ${copies.size} times in the ${parsed.stamp} file (ambiguous)` }); continue }
    const turns = [...copies.values()][0]
    if (parsed.turn != null) {
      const t = turnById.get(gradeId)
      if (!t) { unjoined.push({ id: gradeId, reason: `turn ${parsed.turn} not in scenario ${parsed.key}` }); continue }
      take({ id: t.id, source: 'scenarios', row: t, facts: factsFromScenario(t), hist })
      continue
    }
    // Scenario-level grade: a one-turn scenario, it is that turn's grade; a
    // longer one, only the turns with no grade of their own, flagged.
    if (turns.length === 1) {
      const t = turns[0]
      if (history.has(t.id)) { excluded.push({ id: gradeId, source: 'scenarios', reason: 'scenario grade superseded by its turn-level grade' }); continue }
      take({ id: t.id, source: 'scenarios', row: t, facts: factsFromScenario(t), hist })
      continue
    }
    if (turns.every((t) => history.has(t.id))) excluded.push({ id: gradeId, source: 'scenarios', reason: 'whole-chat grade superseded by turn-level grades' })
    for (const t of turns) {
      if (history.has(t.id)) continue
      take({ id: t.id, source: 'scenarios', row: t, facts: factsFromScenario(t), hist, extraFlags: ['whole-chat grade'] })
    }
  }
  return { joined, unjoined, excluded }
}
