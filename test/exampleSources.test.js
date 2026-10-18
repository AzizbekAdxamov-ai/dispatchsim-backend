// Kills: an eval id with a long uuid run id split at the wrong colon (the
// case id comes after the LAST colon); an older grade beating a newer one
// (live:8 was no, then partly: partly stands); a regrade no -> yes losing
// the flag that ranks it lower; a scenario file in the older format
// (`- **B:**`) or the newer one (`raw`/`final`) not reading; a CHECK flag
// left glued to the reply text; a holding line becoming an "example"; turn
// numbers starting at 0; a multi-line reply cut at its first line; a
// whole-chat grade applied to turns that have their own; a grade whose row
// is missing vanishing instead of being listed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STRICT_NO, parseGradeId, gradeHistory, latestGrade, parseScenarioMarkdown, joinGraded,
  factsFromLive, factsFromEval, factsFromScenario, termsFromText, marketFromText,
} from '../scripts/exampleSources.js'

const UUID_RUN = '2026-10-14-08-46-21-555-fd929e6d-93fb-43e5-981e-b2f13432731e'

test('parseGradeId reads every id shape', () => {
  assert.deepEqual(parseGradeId('live:15'), { source: 'live', liveId: '15', caseId: null, turn: null })
  assert.deepEqual(parseGradeId('eval:2026-10-12-09-43:EB02'), { source: 'eval', runId: '2026-10-12-09-43', caseId: 'EB02', turn: null })
  assert.deepEqual(parseGradeId(`eval:${UUID_RUN}:ED07`), { source: 'eval', runId: UUID_RUN, caseId: 'ED07', turn: null })
  assert.deepEqual(parseGradeId('scenarios:2026-10-18-09-27:S9a:turn4'), { source: 'scenarios', stamp: '2026-10-18-09-27', key: 'S9a', turn: 4 })
  assert.deepEqual(parseGradeId('scenarios:2026-10-16-09-48:G2'), { source: 'scenarios', stamp: '2026-10-16-09-48', key: 'G2', turn: null })
  assert.equal(parseGradeId('nonsense'), null)
  assert.equal(parseGradeId('eval:onlyonepart'), null)
  assert.equal(parseGradeId(undefined), null)
})

test('the latest grade wins, by time and then by file order', () => {
  const h = gradeHistory([
    { id: 'live:8', grade: 'no', by: 'tashqi-ai', at: '2026-10-11T09:00:00Z' },
    { id: 'live:8', grade: 'partly', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'x', grade: 'maybe', at: '2026-10-11T10:00:00Z' },
    { id: 'live:9', grade: 'yes', by: 'a', at: '2026-10-11T09:00:00Z' },
    { id: 'live:9', grade: 'no', by: 'b', at: '2026-10-11T09:00:00Z' },
  ])
  assert.equal(latestGrade(h.get('live:8')).grade, 'partly')
  assert.equal(h.get('live:8').length, 2, 'the whole history is kept')
  assert.equal(latestGrade(h.get('live:9')).grade, 'no', 'same time: the later line wins')
  assert.equal(h.has('x'), false, 'an unknown grade is skipped')
})

const brokerPrompt = [
  'You are Dana Whitfield, a freight broker at Harbor Line Freight Exchange.',
  'You are talking to Keystone Line Haul (MC-741309), a carrier.',
  '',
  'THE LOAD YOU POSTED:',
  '  Idaho Falls, ID to Bismarck, ND',
  '  700 miles · Mattresses in cartons · 17000 lbs',
  '  Equipment: dry-van, 53 ft',
  '  Posted rate: $2093 (about $2.99 per mile)',
  '  Pickup: Mon, Oct 12, 12:34 AM (tomorrow)',
  '',
  'THE MARKET THIS WEEK (DAT, dry-van linehaul):',
  '  Freight out of Pacific Northwest: no regional figure this week (national $2.17/mi). National: $2.17/mi.',
  '  Freight out of Upper Midwest: no regional figure this week (national $2.17/mi) -- that is where this truck will be',
  '',
  'YOUR TERMS (the same on every load you post):',
  '  Detention: $60/hr after 2 hours free, at pickup or delivery.',
  '  TONU: $150 if the load is cancelled after the truck is dispatched.',
  '  Layover: $150 per day if the truck has to wait overnight.',
  '',
  'ON RATE:',
  '- You posted $2093 ($2.99/mi). Your absolute ceiling on',
  '  this load is $2450 ($3.50/mi). Never state that you have',
].join('\n')

test('factsFromLive reads the broker prompt, with the ceiling across the line break', () => {
  const f = factsFromLive({ chat: 'broker', systemPrompt: brokerPrompt })
  assert.equal(f.side, 'broker')
  assert.equal(f.brokerContact, 'Dana Whitfield')
  assert.equal(f.carrier, 'Keystone Line Haul')
  assert.deepEqual(f.origin, { city: 'Idaho Falls', state: 'ID' })
  assert.equal(f.rate, 2093)
  assert.equal(f.ceiling, 2450)
  assert.equal(f.weightLbs, 17000)
  assert.equal(f.equipment, 'dry-van')
  assert.deepEqual(f.terms, { detention: 60, freeHours: 2, tonu: 150, layover: 150 })
  assert.equal(f.market.origin.value, null, 'no regional figure is not a number')
  assert.equal(f.market.national, 2.17)
  assert.deepEqual(f.flags, [])
})

test('an old prompt without terms falls back to the current table, flagged', () => {
  const f = factsFromLive({ chat: 'broker', systemPrompt: brokerPrompt.replace(/YOUR TERMS[\s\S]*?\n\n/, '') })
  assert.ok(f.flags.some((x) => x.startsWith('facts from fallback')), f.flags.join(','))
  assert.ok(f.terms.tonu > 0)
})

test('factsFromLive reads the driver prompt', () => {
  const prompt = [
    'You are Grace Lindqvist, a company driver at Keystone Line Haul, with a CDL-A.',
    'WHO YOU ARE:',
    '  Home base: Seattle, WA',
    '  You drive truck RS-9278-CY.',
    '  You are running load 600010: Nashville, TN',
    '  to New York, NY, 895 miles.',
    'WHERE YOU ARE, RIGHT NOW:',
    '  You are on the road near Memphis, TN right now.',
    '  Driving time left today: 6h 30m.',
    '  Fuel: about 32% of the tank.',
    '',
    'THE LOAD DISPATCH JUST MENTIONED:',
    '  Pickup in Dallas, TX is about 1,982 road miles from where you are.',
    '  Driving it legally (11 hours a day, a 10-hour rest between days) the earliest you could be there is Mon, Oct 19, 8:26 PM.',
    '  The pickup they said is Sat, Oct 17, 3:00 AM -- you cannot make it.',
    'YOUR PAY, AS IT STANDS:',
    '  Owed $529 across 1 settlement.',
  ].join('\n')
  const f = factsFromLive({ chat: 'driver', systemPrompt: prompt })
  assert.equal(f.driver.name, 'Grace Lindqvist')
  assert.equal(f.driver.carrier, 'Keystone Line Haul')
  assert.equal(f.driver.truckId, 'RS-9278-CY')
  assert.equal(f.driver.city, 'Memphis')
  assert.equal(f.driver.fuelPct, 32)
  assert.equal(f.driver.hoursLeft, '6h 30m')
  assert.equal(f.driver.owedUsd, 529)
  assert.deepEqual(f.driver.load, { id: '600010', origin: { city: 'Nashville', state: 'TN' }, dest: { city: 'New York', state: 'NY' }, miles: 895 })
  assert.equal(f.offer.miles, 1982)
  assert.equal(f.offer.makesIt, false)
  assert.equal(f.offer.earliest, 'Mon, Oct 19, 8:26 PM')
})

test('factsFromEval lets the case data win over the prompt', () => {
  const f = factsFromEval({
    chat: 'broker', systemPrompt: brokerPrompt,
    data: {
      contact: 'Priyanka Raman', broker: 'Blue Meridian Logistics Group', lane: 'Allentown, PA -> Atlanta, GA', equipment: 'flatbed',
      miles: 803, rateUsd: 3108, rpm: 3.87, rateHidden: false, pickup: 'in 2 days Wed, Oct 14, 2:47 AM',
      market: { origin: 'Upper Atlantic $2.56', reload: 'Southeast $3.21', national: 2.59 },
      terms: ['Detention (open-deck freight): $75/hr after 3 hours free, at pickup or delivery.', 'TONU: $475 if the load is cancelled after the truck is dispatched.', 'Layover: $200 per day if the truck has to wait overnight.'],
    },
  })
  assert.equal(f.rate, 3108)
  assert.deepEqual(f.dest, { city: 'Atlanta', state: 'GA' })
  assert.deepEqual(f.terms, { detention: 75, freeHours: 3, tonu: 475, layover: 200 })
  assert.deepEqual(f.market.dest, { region: 'Southeast', value: 3.21 })
  assert.equal(f.ceiling, 2450, 'what only the prompt knows is kept')
})

test('terms and market read the wording they are printed in', () => {
  assert.deepEqual(termsFromText('Detention (open-deck freight): $75/hr after 3 hours free, at pickup or delivery. TONU: $475 if x. Layover: $200 per day'), { detention: 75, freeHours: 3, tonu: 475, layover: 200 })
  const m = marketFromText('Market: out of Carolinas $2.18 · reload out of Lower Mountain (no regional figure) · national $2.17')
  assert.deepEqual(m.origin, { region: 'Carolinas', value: 2.18 })
  assert.deepEqual(m.dest, { region: 'Lower Mountain', value: null })
  assert.equal(marketFromText('nothing here'), null)
})

const NEW_FORMAT = `# Chat scenarios — 2026-10-18T09:27:17.088Z
Planned requests: ~17

## Broker (model: openai/gpt-oss-120b · reasoning_effort low)

### S9a — booking call, right MC
Raleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi)
Broker: Devin Marlowe at Copperfield Freight Group (C) · pickup in 2 days
Market: out of Carolinas $2.18 · reload out of Lower Atlantic $2.27 · national $2.17
Broker's terms: Detention: $65/hr after 2 hours free, at pickup or delivery. TONU: $225 if the load is cancelled after the truck is dispatched. Layover: $175 per day if the truck has to wait overnight. Lumper: paid by the broker against a receipt.

- **D:** \`hey this is Aziz with Keystone Line Haul, still available?\`
- **B (raw):** Hey Aziz, yes it is.
- **B (final):** Hey Aziz, yes it is.
- **Answering model:** \`openai/gpt-oss-120b\` · **reasoning_effort:** low · **prompt:** 23a7c7a099
- **Requests:** 1 — #1 ok
- **D:** \`meet me in the middle?\`
- **B (raw):** How about $660?
- _regenerated because it moved without a reason_
- **B (final):** How about $660 all-in?
Send the driver name.

And the truck number. **[CHECK: moved without a reason]**
- **Answering model:** \`openai/gpt-oss-120b\` · **reasoning_effort:** low · **prompt:** 23a7c7a099
- **D:** \`ok\`
- **B (raw):** Hold on a moment.
- **B (final):** Hold on a moment. _(holding line)_
- _Counted trade words:_ none

### S9b — wrong MC
Raleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi) · CALL FOR RATE

- **D:** \`MC 999999\`
- **B (final):** (FAILED: AI provider rate limited the request with HTTP 429) **[FAILED · CHECK: no reply]**

### S9c — one turn
Raleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi)

- **D:** \`hi\`
- **B (final):** Hi there.

## Checks
- nothing
`

const OLD_FORMAT = `# Chat scenarios — 2026-10-16T09:48:25.737Z

## Grace (model: openai/gpt-oss-120b)

Database: parked in Seattle, WA · now on the road near Boise, ID · resting · load: none

### G1 — casual hello
No load in the prompt.

- **D:** \`Grace hey bro how r u doin?\`
- **G:** Copy that.
- **D:** \`got a load for u in a min\`
- **G:** What's the pickup, miles, and ETA?
- _Counted trade words:_ none

### G2 — the New York load
Load in the prompt: Nashville, TN → New York, NY (HYPOTHETICAL — not in the database)

- **D:** \`Grace ur on the NYC load\`
- **G:** Copy.
`

test('parseScenarioMarkdown reads the newer format: final reply, CHECK stripped, 1-based turns, multi-line', () => {
  const turns = parseScenarioMarkdown(NEW_FORMAT, '2026-10-18-09-27')
  const s9a = turns.filter((t) => t.key === 'S9a')
  assert.deepEqual(s9a.map((t) => t.turn), [1, 2, 3])
  assert.equal(s9a[0].id, 'scenarios:2026-10-18-09-27:S9a:turn1')
  assert.equal(s9a[0].reply, 'Hey Aziz, yes it is.')
  assert.equal(s9a[0].promptVersion, '23a7c7a099')
  assert.equal(s9a[1].reply, 'How about $660 all-in?\nSend the driver name.\n\nAnd the truck number.', 'the final reply, all its lines, flag removed')
  assert.deepEqual(s9a[1].findings, ['moved without a reason'])
  assert.equal(s9a[1].holdingLine, false)
  assert.equal(s9a[2].holdingLine, true)
  assert.equal(s9a[2].reply, 'Hold on a moment.')
  assert.equal(s9a[2].history.length, 4, 'turn 3 carries turns 1 and 2')
  assert.equal(s9a[2].history[0].role, 'dispatcher')
  assert.equal(s9a[2].history[1].role, 'broker')
  assert.equal(s9a[0].scenarioTurns, 3)
  assert.equal(turns.filter((t) => t.key === 'S9b')[0].reply.startsWith('(FAILED'), true)
  assert.deepEqual(turns.find((t) => t.key === 'S9b').findings, ['FAILED', 'no reply'])
})

test('parseScenarioMarkdown reads the older format and the Grace header', () => {
  const turns = parseScenarioMarkdown(OLD_FORMAT, '2026-10-16-09-48')
  assert.equal(turns.length, 3)
  assert.equal(turns[0].chat, 'driver')
  assert.equal(turns[0].reply, 'Copy that.')
  assert.equal(turns[1].turn, 2)
  assert.equal(turns[2].key, 'G2')
  assert.equal(turns[2].turn, 1)
  const f = factsFromScenario(turns[0])
  assert.equal(f.side, 'driver')
  assert.equal(f.driver.city, 'Boise')
  assert.equal(f.driver.name, 'Grace')
  const g2 = factsFromScenario(turns[2])
  assert.deepEqual(g2.driver.load.dest, { city: 'New York', state: 'NY' })
})

test('factsFromScenario reads the broker header', () => {
  const [t] = parseScenarioMarkdown(NEW_FORMAT, '2026-10-18-09-27')
  const f = factsFromScenario(t)
  assert.equal(f.rate, 632)
  assert.equal(f.miles, 149)
  assert.equal(f.equipment, 'dry-van')
  assert.equal(f.brokerContact, 'Devin Marlowe')
  assert.deepEqual(f.market.dest, { region: 'Lower Atlantic', value: 2.27 })
  assert.deepEqual(f.terms, { detention: 65, freeHours: 2, tonu: 225, layover: 175 })
  const hidden = factsFromScenario(parseScenarioMarkdown(NEW_FORMAT, 'x').find((x) => x.key === 'S9b'))
  assert.equal(hidden.rateHidden, true)
})

test('parseScenarioMarkdown never throws on a file it cannot read', () => {
  assert.deepEqual(parseScenarioMarkdown(null, 's'), [])
  assert.deepEqual(parseScenarioMarkdown('no headings at all', 's'), [])
})

const liveRow = (id, over = {}) => ({ id, source: 'live', chat: 'broker', line: 'hi', reply: 'Hello there.', findings: [], fellBack: false, systemPrompt: brokerPrompt, ...over })

test('a no regraded to yes stays eligible, flagged; a partly or no stays out', () => {
  assert.equal(STRICT_NO, false)
  const grades = [
    { id: 'live:1', grade: 'no', by: 'tashqi-ai', at: '2026-10-11T09:00:00Z' },
    { id: 'live:1', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'live:2', grade: 'yes', by: 'codex', at: '2026-10-11T09:00:00Z' },
    { id: 'live:2', grade: 'partly', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'live:3', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
  ]
  const r = joinGraded({ grades, liveRows: [liveRow('live:1'), liveRow('live:2'), liveRow('live:3')] })
  assert.deepEqual(r.joined.map((j) => j.id).sort(), ['live:1', 'live:3'])
  assert.deepEqual(r.joined.find((j) => j.id === 'live:1').flags, ['regraded (no→yes by nova)'])
  assert.deepEqual(r.joined.find((j) => j.id === 'live:3').flags, [])
  assert.deepEqual(r.excluded.map((e) => [e.id, e.reason]), [['live:2', 'latest grade partly']])
})

test('a turn with no reply, an error, a holding line or a failed reply is not an example', () => {
  const grades = ['a', 'b', 'c', 'd'].map((x, i) => ({ id: `live:${i + 1}`, grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' }))
  const r = joinGraded({
    grades,
    liveRows: [
      liveRow('live:1', { reply: null }), liveRow('live:2', { error: 'boom' }),
      liveRow('live:3', { fellBack: true }), liveRow('live:4', { reply: '(FAILED: 429)' }),
    ],
  })
  assert.equal(r.joined.length, 0)
  assert.deepEqual(r.excluded.map((e) => e.reason), ['no reply', 'error', 'fell back (holding line)', 'failed reply'])
})

test('ids that cannot be joined are listed with a reason, never dropped', () => {
  const dup = `${NEW_FORMAT}\n## Broker (model: x)\n\n### S9a — again\nRaleigh, NC → Roanoke, VA · dry-van · 149 mi · $632 ($4.24/mi)\n\n- **D:** \`hi\`\n- **B:** hello\n`
  const grades = [
    { id: 'live:99', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'eval:2026-10-12-09-43:EB02', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'scenarios:2026-01-01-00-00:S1', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S7', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9a:turn2', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9b:turn9', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
    { id: 'bogus', grade: 'yes', by: 'nova', at: '2026-10-11T10:00:00Z' },
  ]
  const r = joinGraded({ grades, scenarioTurns: parseScenarioMarkdown(dup, '2026-10-18-09-27') })
  const why = Object.fromEntries(r.unjoined.map((u) => [u.id, u.reason]))
  assert.match(why['live:99'], /live row/)
  assert.match(why['eval:2026-10-12-09-43:EB02'], /eval row/)
  assert.match(why['scenarios:2026-01-01-00-00:S1'], /no scenario file/)
  assert.match(why['scenarios:2026-10-18-09-27:S7'], /not in the/)
  assert.match(why['scenarios:2026-10-18-09-27:S9a:turn2'], /ambiguous/)
  assert.match(why['scenarios:2026-10-18-09-27:S9b:turn9'], /turn 9/)
  assert.equal(why.bogus, 'unrecognised id')
})

test('a scenario-level grade: a one-turn scenario takes it; a longer one gives it only to turns with no grade of their own', () => {
  const turns = parseScenarioMarkdown(NEW_FORMAT, '2026-10-18-09-27')
  const grades = [
    { id: 'scenarios:2026-10-18-09-27:S9c', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9b', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9a', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
    { id: 'scenarios:2026-10-18-09-27:S9a:turn2', grade: 'yes', by: 'claude', at: '2026-10-18T10:00:00Z' },
  ]
  const r = joinGraded({ grades, scenarioTurns: turns })
  const flagsOf = (id) => r.joined.find((j) => j.id === id)?.flags
  assert.deepEqual(flagsOf('scenarios:2026-10-18-09-27:S9c:turn1'), [], 'one D line: the grade is that turn\'s own')
  assert.deepEqual(flagsOf('scenarios:2026-10-18-09-27:S9a:turn1'), ['whole-chat grade'])
  assert.deepEqual(flagsOf('scenarios:2026-10-18-09-27:S9a:turn2'), [], 'its own grade, not the whole-chat one')
  assert.equal(flagsOf('scenarios:2026-10-18-09-27:S9a:turn3'), undefined, 'turn 3 is a holding line')
  assert.ok(r.excluded.some((e) => e.id.endsWith(':S9a:turn3') && /holding/.test(e.reason)))
  assert.ok(r.excluded.some((e) => e.id.endsWith(':S9b:turn1') && e.reason === 'failed reply'))
  assert.equal(r.unjoined.length, 0)
})
