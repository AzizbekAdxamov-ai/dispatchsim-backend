// Kills: a line sorted into the wrong situation (EB08's appointment question
// filed under terms because lumper is in it; "skip ur 10" missed because the
// HOS check wants "your"; "how much u pay" taken for a pay-terms question;
// "any delivery instructions?" taken for a prompt request); a figure swapped
// for the wrong placeholder (a counter the broker made up shown as the
// posted rate; $150 detention/TONU/layover picked silently); a number left
// in a template that belongs to one load; the 11-hour rule or a 53 ft trailer
// templated away; a regraded or whole-chat example outranking a clean one;
// near-identical examples filling the top of a situation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROKER_CASES, DRIVER_CASES } from '../scripts/evalCases.js'
import {
  SITUATION_TYPES, classify, saidFrom, templateText, candidateFrom, rankAndDedupe, compareCandidates, buildBank, renderMarkdown, renderJson,
} from '../scripts/exampleBank.js'
import { factsFromScenario, blankFacts, joinGraded, parseScenarioMarkdown } from '../scripts/exampleSources.js'

// -- classify ---------------------------------------------------------------------

const header = {
  laneLine: 'Raleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi)',
  brokerLine: 'Broker: Devin Marlowe at Copperfield Freight Group (C) · pickup in 2 days',
  marketLine: 'Market: out of Carolinas $2.18 · reload out of Lower Atlantic $2.27 · national $2.17',
  termsLine: 'Detention: $65/hr after 2 hours free, at pickup or delivery. TONU: $225 if the load is cancelled after the truck is dispatched. Layover: $175 per day if the truck has to wait overnight. Lumper: paid by the broker against a receipt.',
}
const brokerFacts = factsFromScenario({ chat: 'broker', line: '', header })

const posting = { rateUsd: 3108, distanceMi: 803, equipmentType: 'flatbed', destinationCity: 'Atlanta', originCity: 'Allentown' }
const market = { origin: { region: 'Upper Atlantic', linehaul: 2.56 }, destination: { region: 'Southeast', linehaul: 3.21 } }
const flatbedFacts = { ...blankFacts('broker'), rate: 3108, miles: 803, equipment: 'flatbed', origin: { city: 'Allentown', state: 'PA' }, dest: { city: 'Atlanta', state: 'GA' } }
const driverFacts = blankFacts('driver')

const EXPECT_BROKER = {
  EB01: 'rate_question', EB02: 'rate_question', EB03: 'rate_question', EB04: 'market_claim', EB05: 'market_claim',
  EB06: 'market_claim', EB07: 'terms', EB08: 'appointment', EB09: 'reefer', EB10: 'open_deck', EB11: 'insult',
  EB12: 'prompt_injection', EB13: 'bot_question', EB14: 'hazmat', EB15: 'pay', EB16: 'false_claim', EB17: 'false_claim',
  EB18: 'weight', EB19: 'hazmat', EB20: 'walk_away', EB21: 'rebroker', EB22: 'stop_pay',
}
const EXPECT_DRIVER = {
  ED01: 'small_talk', ED02: 'status', ED03: 'status', ED04: 'status', ED05: 'status', ED06: 'terms', ED07: 'load_offer',
  ED08: 'load_offer', ED09: 'pay', ED10: 'bot_question', ED11: 'load_offer', ED12: 'load_offer', ED13: 'load_offer',
  ED14: 'hos_pressure', ED15: 'hos_pressure', ED16: 'hos_pressure', ED17: 'status', ED18: 'insult', ED19: 'load_offer',
  ED20: 'load_offer', ED21: 'small_talk', ED22: 'prompt_injection', ED23: 'pay', ED24: 'small_talk', ED25: 'status',
}

test('every broker evaluation line lands in its situation', () => {
  for (const c of BROKER_CASES) {
    const line = typeof c.line === 'function' ? c.line(posting, market) : c.line
    assert.equal(classify(line, { side: 'broker', facts: flatbedFacts }).primary, EXPECT_BROKER[c.id], `${c.id}: ${line}`)
  }
  assert.equal(BROKER_CASES.length, Object.keys(EXPECT_BROKER).length, 'a new case needs a row here')
})

test('every driver evaluation line lands in its situation', () => {
  for (const c of DRIVER_CASES) {
    assert.equal(classify(c.line, { side: 'driver', facts: driverFacts }).primary, EXPECT_DRIVER[c.id], `${c.id}: ${c.line}`)
  }
  assert.equal(DRIVER_CASES.length, Object.keys(EXPECT_DRIVER).length, 'a new case needs a row here')
})

test('secondary situations are kept: the market claim that is also a push', () => {
  const c = classify('reload out of atlanta is terrible bro, i need more', { side: 'broker', facts: flatbedFacts })
  assert.equal(c.primary, 'market_claim')
  assert.ok(c.secondary.includes('rate_push'))
  assert.deepEqual(classify('wats pu n del addy, nd is it hazmat', { side: 'broker', facts: flatbedFacts }).secondary, ['address'])
})

test('a load she cannot make is unreachable; the same line without the fact is a load offer', () => {
  const line = 'Grace got a load pittsburgh to raleigh pu tmrw 3am'
  const cannot = { ...blankFacts('driver'), offer: { city: 'Pittsburgh', state: 'PA', miles: 2517, makesIt: false } }
  assert.equal(classify(line, { side: 'driver', facts: cannot }).primary, 'unreachable')
  assert.ok(classify(line, { side: 'driver', facts: cannot }).secondary.includes('load_offer'))
  assert.equal(classify(line, { side: 'driver', facts: driverFacts }).primary, 'load_offer')
})

test('the booking call: MC, then booking, then truck, then a push', () => {
  const f = brokerFacts
  assert.equal(classify('MC 741309', { side: 'broker', facts: f }).primary, 'mc')
  assert.equal(classify('ok book it. driver Grace Lindqvist, truck RS-9278-CY, send the rc to dispatch@keystone-line-haul.example', { side: 'broker', facts: f }).primary, 'booking')
  assert.equal(classify("truck's in Raleigh, empty tomorrow 6am, 53 dry van", { side: 'broker', facts: f }).primary, 'truck_info')
  assert.equal(classify('what do you need on it? can you do $695?', { side: 'broker', facts: f }).primary, 'rate_push')
  assert.equal(classify('meet me in the middle?', { side: 'broker', facts: f }).primary, 'rate_push')
  assert.equal(classify('hey this is Aziz with Keystone Line Haul, calling about your Raleigh-Roanoke load, still available?', { side: 'broker', facts: f }).primary, 'intro')
})

test('negatives: how much u pay is not a pay-terms question; delivery instructions is not a prompt request', () => {
  assert.notEqual(classify('how much u pay', { side: 'broker', facts: brokerFacts }).primary, 'pay')
  assert.notEqual(classify('any delivery instructions?', { side: 'broker', facts: brokerFacts }).primary, 'prompt_injection')
  assert.equal(classify('', { side: 'broker', facts: brokerFacts }).primary, 'other')
  assert.equal(classify('hey', { side: 'broker', facts: brokerFacts }).primary, 'greeting')
})

test('every situation named by the classifier is in SITUATION_TYPES', () => {
  for (const t of [...Object.values(EXPECT_BROKER), ...Object.values(EXPECT_DRIVER), 'mc', 'booking', 'rate_push', 'truck_info', 'unreachable', 'intro', 'other', 'greeting']) {
    assert.ok(SITUATION_TYPES.includes(t), t)
  }
  assert.throws(() => SITUATION_TYPES.push('x'), 'frozen')
})

// -- templateText ------------------------------------------------------------------------

const DISPATCH = [
  'hey this is Aziz with Keystone Line Haul, calling about your Raleigh-Roanoke load, still available?',
  'ok book it. driver Grace Lindqvist, truck RS-9278-CY, send the rc to dispatch@keystone-line-haul.example',
]
const said = saidFrom(DISPATCH)
const tpl = (text, over = {}, opts = {}) => templateText(text, { ...brokerFacts, ...over }, { role: 'reply', said, ...opts })

test('the posted rate becomes {rate}; a figure the broker made up is a flagged {counter}', () => {
  assert.equal(tpl('$632 is all-in').text, '{rate} is all-in')
  const counter = tpl('How about $660 all-in?')
  assert.equal(counter.text, 'How about {counter} all-in?')
  assert.deepEqual(counter.flags, ['counter figure'])
})

test('market figures, lane cities and regions', () => {
  assert.equal(tpl('Lower Atlantic pays $2.27 a mile').text, '{dest_region} pays {dest_market} a mile')
  assert.equal(tpl('$4.24/mi on Raleigh → Roanoke').text, '{rate_per_mile}/mi on {origin_city} → {dest_city}')
  assert.equal(tpl('Raleigh, NC to Roanoke VA').text, '{origin_city} to {dest_city}')
})

test('names, the truck number (any dash), the email, and who is calling', () => {
  const r = tpl('Perfect – we’re set with Grace Lindqvist in RS‑9278‑CY. Rate con to dispatch@keystone-line-haul.example. Thanks, Aziz! Keystone Line Haul, right?')
  assert.equal(r.text, 'Perfect – we’re set with {driver_name} in {truck_number}. Rate con to {email}. Thanks, {dispatcher_name}! {carrier_name}, right?')
  assert.deepEqual(r.flags, [])
  assert.equal(tpl('Devin here at Copperfield Freight Group').text, '{broker_name} here at {broker_company}')
})

test('the MC the dispatcher gave becomes {mc}', () => {
  assert.equal(templateText('MC 741309', brokerFacts, { role: 'line', said: saidFrom(['MC 741309']) }).text, 'MC {mc}')
  assert.equal(templateText('741309', brokerFacts, { role: 'line', said: saidFrom(['741309']) }).text, '{mc}')
})

test('detention, TONU and layover that share a figure are told apart by the word beside them', () => {
  const same = { terms: { detention: 60, freeHours: 2, tonu: 150, layover: 150 } }
  const ok = tpl('Detention is $60 an hour after the first two hours free. TONU is $150 if they cancel. Layover is $150 a day.', same)
  assert.equal(ok.text, 'Detention is {detention_rate} an hour after the first {free_hours} hours free. TONU is {tonu} if they cancel. Layover is {layover} a day.')
  assert.deepEqual(ok.flags, [])
  const unclear = tpl('It is $150, standard.', same)
  assert.equal(unclear.text.includes('{'), true)
  assert.ok(unclear.flags.some((f) => f.startsWith('ambiguous $150')), unclear.flags.join(','))
})

test('the dispatcher\'s own figures are {their_ask} / {their_figure}, not the load\'s', () => {
  const s = saidFrom(['can you do $695? DAT has carolinas at 4.75'])
  const r = templateText('I cannot do $695, and 4.75 is not what DAT shows.', brokerFacts, { role: 'reply', said: s })
  assert.equal(r.text, 'I cannot do {their_ask}, and {their_figure} is not what DAT shows.')
  assert.deepEqual(r.flags, [])
})

test('rule numbers stay; a stray number becomes {number}, flagged', () => {
  const rules = tpl('I can only drive 11 hours, then a 10-hour rest. It is a 53 ft dry van, 48 ft flatbed.')
  assert.equal(rules.text, 'I can only drive 11 hours, then a 10-hour rest. It is a 53 ft dry van, 48 ft flatbed.')
  assert.deepEqual(rules.flags, [])
  const stray = tpl('Call me about 42.')
  assert.equal(stray.text, 'Call me about {number}.')
  assert.deepEqual(stray.flags, ['unmatched number: 42'])
  assert.equal(tpl('That is 1,982 road miles').text, 'That is {number} road miles')
})

test('miles, weight, times and a city nobody gave are matched or flagged, never kept', () => {
  const f = { ...flatbedFacts, weightLbs: 40000, pickup: 'Wed, Oct 14, 2:47 AM (in 2 days)' }
  const r = templateText('803 miles, 40,000 lbs, pickup 2:47 AM, drop 9 pm, from Denver', f, { role: 'reply', said: saidFrom([]) })
  assert.equal(r.text, '{miles} miles, {weight_lbs} lbs, pickup {pickup_time}, drop {time}, from {city}')
  assert.deepEqual(r.flags.sort(), ['commodity unknown: check for a literal load type', 'unmatched city: Denver', 'unmatched time: 9 pm'])
})

test('Grace: her own city, fuel, hours and pay', () => {
  const f = blankFacts('driver')
  Object.assign(f.driver, { name: 'Grace Lindqvist', city: 'Seattle', state: 'WA', home: { city: 'Seattle', state: 'WA' }, fuelPct: 32, hoursLeft: '11h 00m', owedUsd: 529 })
  const r = templateText('Seattle, bunk on my ten. 11h left, fuel about 32%. Owed $529, Grace here.', f, { role: 'reply', said: saidFrom(['Grace u there?']) })
  assert.equal(r.text, '{driver_city}, bunk on my ten. {hours_left} left, fuel about {fuel_pct}%. Owed {owed}, {driver_name} here.')
  assert.deepEqual(r.flags, [])
})

test('after templating no digit is left outside a placeholder except the trade rules', () => {
  const texts = [
    'Detention is $60/hr after 2 hours free; $632 total, 149 miles, $4.24/mi, 12:30 pm, ID 4411, MC 741309',
    'Pickup in 2 days, 53 ft, 10 hours, 6 of 7', '$7.6k on 3 trucks',
  ]
  for (const t of texts) {
    const out = tpl(t).text.replace(/\{[a-z_]+\}/g, '').replace(/\b(?:10|11|14|34|70)[\s-]*(?:hours?|hrs?|h)\b/gi, '').replace(/\b(?:48|53)\s*ft\b/gi, '')
    assert.equal(/\d/.test(out), false, `${t} -> ${out}`)
  }
})

// -- ranking ------------------------------------------------------------------------------

let n = 0
const cand = (over = {}) => {
  n += 1
  return {
    id: `c${n}`, side: 'broker', type: 'terms', line: `line number ${n} zz${n}a zz${n}b`, reply: `reply words ${n} yy${n}a yy${n}b yy${n}c`,
    human: false, findings: [], templateFlags: [], flags: [], promptVersion: 'old', at: '2026-10-01T00:00:00Z', alsoIn: [], ...over,
  }
}
const order = (list, currentVersions = ['cur']) => rankAndDedupe(list, { top: 20, currentVersions })[0].shown.map((c) => c.id)

test('ranking: human over model, no findings over findings, fewer flags, current prompt version, newer', () => {
  const model = cand()
  const human = cand({ human: true })
  assert.deepEqual(order([model, human]), [human.id, model.id])
  const clean = cand()
  const found = cand({ findings: ['x'] })
  assert.deepEqual(order([found, clean]), [clean.id, found.id])
  const few = cand({ templateFlags: [] })
  const many = cand({ templateFlags: ['unmatched number: 1', 'unmatched time: 2'] })
  assert.deepEqual(order([many, few]), [few.id, many.id])
  const old = cand({ promptVersion: 'old' })
  const current = cand({ promptVersion: 'cur' })
  assert.deepEqual(order([old, current]), [current.id, old.id])
  const older = cand({ at: '2026-10-01T00:00:00Z' })
  const newer = cand({ at: '2026-10-09T00:00:00Z' })
  assert.deepEqual(order([older, newer]), [newer.id, older.id])
})

test('ranking: a regraded example and a whole-chat example go last, even behind a model-graded one with findings', () => {
  const plain = cand({ findings: ['x'] })
  const regraded = cand({ human: true, flags: ['regraded (no→yes by nova)'] })
  const whole = cand({ human: true, flags: ['whole-chat grade'] })
  assert.deepEqual(order([whole, regraded, plain]), [plain.id, regraded.id, whole.id])
  assert.ok(compareCandidates(plain, whole) < 0)
})

test('near-identical examples collapse into the best one, which records where the others were', () => {
  const best = cand({ human: true, line: 'detention after 2 hrs', reply: 'Detention is {detention_rate} an hour after {free_hours} hours free, TONU is {tonu}' })
  const twin = cand({ line: 'detention after 2 hrs', reply: 'Detention is {detention_rate} an hour after {free_hours} hours free, TONU is {tonu}.' })
  const near = cand({ line: 'Detention after 2 hrs?', reply: 'detention is {detention_rate} an hour after {free_hours} hours free; tonu is {tonu}' })
  const other = cand()
  const [g] = rankAndDedupe([twin, near, other, best], { top: 10 })
  assert.equal(g.yes, 4, 'the yes count is before folding')
  assert.deepEqual(g.shown.map((c) => c.id), [best.id, other.id])
  assert.deepEqual(g.shown[0].alsoIn.sort(), [near.id, twin.id].sort())
})

test('top cuts each side and situation separately', () => {
  const many = Array.from({ length: 6 }, () => cand())
  const driver = cand({ side: 'driver', type: 'status' })
  const groups = rankAndDedupe([...many, driver], { top: 3 })
  assert.equal(groups.length, 2)
  assert.equal(groups.find((g) => g.type === 'terms').shown.length, 3)
  assert.equal(groups.find((g) => g.type === 'terms').yes, 6)
  assert.equal(groups.find((g) => g.type === 'status').shown.length, 1)
})

// -- the whole path -------------------------------------------------------------------------

test('graded rows in, templated examples out, unjoined listed', () => {
  const md = `## Broker (model: x)

### S9a — booking call
Raleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi)
Broker: Devin Marlowe at Copperfield Freight Group (C) · pickup in 2 days
Market: out of Carolinas $2.18 · reload out of Lower Atlantic $2.27 · national $2.17
Broker's terms: Detention: $65/hr after 2 hours free, at pickup or delivery. TONU: $225 if the load is cancelled after the truck is dispatched. Layover: $175 per day if the truck has to wait overnight. Lumper: paid by the broker against a receipt.

- **D:** \`hey this is Aziz with Keystone Line Haul, still available?\`
- **B (final):** Hey Aziz, yes. $632 is all-in.
- **Answering model:** \`m\` · **prompt:** 23a7c7a099
- **D:** \`can you do $695?\`
- **B (final):** I hear you, but $632 is all-in for Raleigh to Roanoke.
- **Answering model:** \`m\` · **prompt:** 23a7c7a099
`
  const grades = [
    { id: 'scenarios:2026-10-18-09-27:S9a:turn1', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9a:turn2', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
    { id: 'live:404', grade: 'yes', by: 'nova', at: '2026-10-18T10:00:00Z' },
  ]
  const join = joinGraded({ grades, scenarioTurns: parseScenarioMarkdown(md, '2026-10-18-09-27') })
  const bank = buildBank(join, { gradesRead: 3, top: 5, currentVersions: ['23a7c7a099'] })
  assert.equal(bank.meta.joined, 2)
  assert.equal(bank.meta.unjoined, 1)
  const push = bank.groups.find((g) => g.type === 'rate_push')
  assert.equal(push.shown[0].line, 'can you do {their_ask}?')
  assert.equal(push.shown[0].reply, 'I hear you, but {rate} is all-in for {origin_city} to {dest_city}.')
  assert.equal(push.shown[0].previous.line, 'hey this is {dispatcher_name} with {carrier_name}, still available?')
  const text = renderMarkdown(bank)
  assert.match(text, /rate_push/)
  assert.match(text, /live:404: live row not in any turns file/)
  assert.doesNotMatch(text, /Aziz/)
  assert.equal(JSON.parse(renderJson(bank)).meta.joined, 2)
})

// -- Round 2: facts that leaked through unflagged ---------------------------------------------

const lineTpl = (text, facts, texts = [text]) => templateText(text, facts, { role: 'line', said: saidFrom(texts) })
const replyTpl = (text, facts, texts = []) => templateText(text, facts, { role: 'reply', said: saidFrom(texts) })

test('free hours in every wording; a count that is not the fact is flagged', () => {
  const t = { terms: { detention: 60, freeHours: 2, tonu: 150, layover: 150 } }
  assert.equal(tpl('Detention starts after the first two free hours.', t).text, 'Detention starts after the first {free_hours} free hours.')
  assert.equal(tpl('You get 2 free hours, then $60 an hour.', t).text, 'You get {free_hours} free hours, then {detention_rate} an hour.')
  assert.equal(tpl('after two hours free', t).text, 'after {free_hours} hours free')
  const off = tpl('Detention starts after three free hours.', t)
  assert.ok(off.flags.some((f) => f.startsWith('unmatched free hours')), off.flags.join(','))
})

test('a dispatcher line\'s ask is {their_ask} even when it equals the ceiling', () => {
  const f = { ...brokerFacts, ceiling: 695 }
  assert.equal(lineTpl('can you do $695?', f).text, 'can you do {their_ask}?')
  assert.equal(replyTpl('My best is $695.', f).text, 'My best is {ceiling}.')
})

test('a city one letter off a fact is that fact, flagged; an unknown place after "to" is flagged', () => {
  const f = { ...blankFacts('broker'), origin: { city: 'Worcester', state: 'MA' }, dest: { city: 'Cedar Rapids', state: 'IA' } }
  const r = replyTpl('Worcester to Cedar Raps, 1199 mi.', f)
  assert.equal(r.text.startsWith('{origin_city} to {dest_city}'), true, r.text)
  assert.ok(r.flags.includes('fuzzy city: Cedar Raps ~ Cedar Rapids'), r.flags.join(','))
  const u = replyTpl('We can send it to Fargoland tomorrow.', f)
  assert.ok(u.flags.includes('unmatched place: Fargoland'), u.flags.join(','))
})

test('a region as a person types it: singular, plural, and ones the table lacks', () => {
  const f = { ...brokerFacts, market: { origin: { region: 'Carolinas', value: 2.18 }, dest: { region: 'Lower Atlantic', value: 2.27 }, national: 2.17 } }
  assert.equal(replyTpl('Carolina is paying, and Carolinas too; lower atlantic less.', f).text, '{origin_region} is paying, and {origin_region} too; {dest_region} less.')
  const m = replyTpl('The Midwest is soft.', f)
  assert.equal(m.text, 'The {region} is soft.')
  assert.ok(m.flags.some((x) => x.startsWith('unmatched region')))
})

test('the commodity is templated when known, and an unchecked one is flagged', () => {
  const f = { ...brokerFacts, commodity: 'Mattresses in cartons' }
  assert.equal(replyTpl('It is mattresses in cartons, 53 ft.', f).text, 'It is {commodity}, 53 ft.')
  assert.equal(replyTpl('Just mattresses.', f).text, 'Just {commodity}.')
  const none = replyTpl('We are hauling apparel.', brokerFacts)
  assert.ok(none.flags.includes('commodity unknown: check for a literal load type'))
  const described = replyTpl('Raleigh to Roanoke, 149 mi, auto parts, 53-ft dry-van.', brokerFacts)
  assert.equal(described.text.startsWith('{origin_city} to {dest_city}, {miles} mi, auto parts'), true, described.text)
  assert.ok(described.flags.includes('commodity unknown: check for a literal load type'), described.flags.join(','))
  assert.ok(!replyTpl('$632 is all-in.', brokerFacts).flags.includes('commodity unknown: check for a literal load type'))
})

test('the earlier exchange is used only when it is a dispatcher line then a reply', () => {
  const facts = brokerFacts
  const row = (history) => ({ id: 'live:1', source: 'live', line: 'ok', reply: 'Fine.', history })
  const make = (history) => candidateFrom({ id: 'live:1', source: 'live', row: row(history), facts, grade: { grade: 'yes', by: 'nova' }, flags: [], history: [] })
  assert.equal(make([{ role: 'broker', content: 'a' }, { role: 'dispatcher', content: 'b' }]).previous, null)
  assert.equal(make([{ role: 'dispatcher', content: 'a' }, { role: 'broker', content: 'b' }]).previous.line, 'a')
})

test('Grace\'s "11 hours." is her clock; "11-hour limit" is the rule', () => {
  const f = blankFacts('driver')
  Object.assign(f.driver, { hoursLeft: '11h 00m', city: 'Seattle', state: 'WA' })
  assert.equal(replyTpl('11 hours.', f).text, '{hours_left}.')
  const rule = replyTpl('I cannot, the 11-hour limit is the law, and 14 hours is the window.', f)
  assert.equal(rule.text, 'I cannot, the 11-hour limit is the law, and 14 hours is the window.')
  assert.deepEqual(rule.flags, [])
  const other = replyTpl('About 9 hours.', f)
  assert.ok(other.flags.includes('unmatched number: 9'))
})

test('the safety net names a state or a name that survived templating', () => {
  const f = { ...brokerFacts }
  const r = replyTpl('That one goes through Texas, ask Devin.', f)
  assert.ok(r.flags.some((x) => x === 'possible leak: Texas'), r.flags.join(','))
  const clean = replyTpl('{rate} and nothing else', f)
  assert.ok(!clean.flags.some((x) => x.startsWith('possible leak')))
})
