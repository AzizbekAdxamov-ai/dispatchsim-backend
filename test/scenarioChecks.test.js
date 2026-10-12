// The checks chat:scenarios runs on every reply. Each is tested on the
// real reply that made it necessary (reports/chat-scenarios-2026-10-06-*),
// and on a real reply from the same runs that must NOT be flagged -- a
// check that flags good replies is noise nobody reads twice.
//
// Pure. Each test names the mutation it kills.

import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { FALLBACK_REPLY as DRIVER_FALLBACK } from '../src/modules/driverChat/driverChat.prompt.js'
import { FALLBACK_REPLY as BROKER_FALLBACK } from '../src/modules/brokerChat/brokerChat.prompt.js'
import {
  PROMISE, anyReply, brokerReply, driverReply, repeatsQuestion, dollars, summarize, BROKER_EXPECT, DRIVER_EXPECT,
} from '../scripts/scenarioChecks.js'

// Kills: a promise pattern that misses "let me look at the paperwork"
// (G2, fourth run) or "give me a sec", or one that flags a plain "I do not know" (G3).
test('a promise to come back is flagged; saying you do not know is not', () => {
  assert.deepEqual(anyReply("Don't have the Nashville detention numbers—let me look at the paperwork."), ['promises to get back'])
  assert.deepEqual(anyReply('Give me a sec, checking.'), ['promises to get back'])
  assert.deepEqual(anyReply('One moment, I will be right there.'), ['promises to get back'])
  assert.deepEqual(anyReply("I do not know about a Dallas load yet — what's the pickup, how many miles, when does it need to be there?"), [])
})

// Kills: markdown passing, or a dash inside a sentence read as a bullet.
test('asterisks are markdown; a dash mid-sentence is not', () => {
  assert.deepEqual(anyReply('Heading *into* the yard now.'), ['markdown'])
  assert.deepEqual(anyReply('Need a legal parking spot after this NYC drop - you owe me for the city run.'), [])
})

// Kills: comparing whole questions word for word (S1 reworded it), or
// flagging a reply with no question at all.
test('the same question in two replies running is flagged, reworded or not', () => {
  assert.equal(repeatsQuestion("$7755, all-in. Where's your truck at?", "This load is still on the board. Where's your truck sitting right now?"), true)
  assert.equal(repeatsQuestion('Detention is $80 an hour after two free, pickup or delivery.', "You're close, which is good -- where are you sitting right now?"), false)
  assert.equal(repeatsQuestion("Where's your truck at?", null), false)
})

// Kills: "$3,750" read as 3.
test('dollar amounts are read with or without commas', () => {
  assert.deepEqual(dollars('I can do $3,750, or $3750 all-in, $2.19/mi'), [3750, 3750, 2.19])
})

// Kills: the ceiling check missing the 2026-10-06 line, or catching "my best".
test('a broker naming room or a ceiling is flagged; "my best" is not', () => {
  assert.deepEqual(brokerReply('Still got room before I hit my ceiling.'), ['names a ceiling or room'])
  assert.deepEqual(brokerReply("That's my best on this one."), [])
})

// Kills: S4 passing the fourth run's agreement, or failing the third
// run's correct answer.
test('S4: agreeing with a false bad-reload claim is flagged, citing the figure is not', () => {
  const s4 = BROKER_EXPECT.S4({ market: { destination: { linehaul: 2.19 } } })
  assert.deepEqual(s4[0]("Come on, you're killing me here — I hear you on the Savannah reload, but this number's got fuel in it. What are you needing?"),
    ['agrees with the false claim', 'reload figure not given'])
  assert.deepEqual(BROKER_EXPECT.S4({ market: { destination: { linehaul: 3.21 } } })[0]("Knoxville reload isn't bad this week -- Southeast is $3.21."), [])
})

// Kills: S5 not requiring the real figure.
test('S5: the wrong number is answered with the real one', () => {
  const s5 = BROKER_EXPECT.S5({ market: { origin: { linehaul: 2.32 } } })
  assert.deepEqual(s5[0]("$2.32 is what I'm seeing for Upper Atlantic linehaul this week, not $4.12 — you might be looking at a different report."), [])
  assert.deepEqual(s5[0]('You might be looking at a different report.'), ['real figure not given'])
})

// Kills: terms checked against anything but this broker's own figures.
test('S2/S8: the broker\'s own detention, TONU and layover must all be said', () => {
  const said = 'Detention is $80 an hour after two free, pickup or delivery. TONU is $225 if they cancel after dispatch. Layover is $275 a day if the truck has to sit overnight.'
  assert.deepEqual(BROKER_EXPECT.S2({ terms: { detentionPerHour: 80, tonuUsd: 225, layoverPerDay: 275 } })[1](said), [])
  assert.deepEqual(BROKER_EXPECT.S8({ terms: { detentionPerHour: 85, tonuUsd: 225, layoverPerDay: 275 } })[0](said), ['detention $85 missing'])
})

// Kills: S3 not catching a move on the first push or the whole ask.
test('S3: hold on the first push, never the whole ask', () => {
  const s3 = BROKER_EXPECT.S3({ posting: { rateUsd: 3541 }, ask: 3966 })
  assert.deepEqual(s3[0]('But $3541 is what this lane pays right now.'), [])
  assert.deepEqual(s3[1]('I can do $3750. That\'s a fair middle.'), [])
  assert.deepEqual(s3[1]('Fine, $3,966 it is.'), ['gave the whole ask'])
  assert.deepEqual(s3[0]('I can do $3700.'), ['moved on the first push'])
})

// Kills: a reefer answer passing with only one of the two, or the wrong day passing.
test('S6 wants both temperature and mode; S7 wants the pickup day', () => {
  const s6 = BROKER_EXPECT.S6()
  assert.deepEqual(s6[0]('0°F, continuous. Pre-cool the trailer before pickup.'), [])
  assert.deepEqual(s6[0]('34°F, pre-cool it.'), ['no continuous / start-stop'])
  const said = 'Pu tomorrow Wed at 5:29 PM, delivery Fri at 1:19 PM.'
  assert.deepEqual(BROKER_EXPECT.S7({ pickupDay: 'tomorrow|Wednesday|Wed' })[0](said), [])
  assert.deepEqual(BROKER_EXPECT.S7({ pickupDay: 'Thursday|Thu' })[0](said), ['pickup day (Thursday|Thu) not said'])
  assert.deepEqual(BROKER_EXPECT.S1({ posting: { rateUsd: 7755 } })[1]("$7755, all-in. Where's your truck at?"), [])
})

// Kills: the dock check firing for a driver who is parked, or missing
// the fourth run's two lines.
test('a driver on the road at a dock is flagged, only when she is on the road', () => {
  assert.deepEqual(driverReply('Waiting on the dock, box is loaded.', null, { onTheRoad: true }), ['at a dock while on the road'])
  assert.deepEqual(driverReply('At the NY drop, just finished the walkaround.', null, { onTheRoad: true }), ['at a dock while on the road'])
  assert.deepEqual(driverReply('At the NY drop, just finished the walkaround.', null, { onTheRoad: false }), [])
})

// Kills: an ETA with no hour passing, the fuel figure not checked, or
// New York counted on the turn where the dispatcher raised it.
test('G2 wants an hour and the city; G3 the fuel figure and no New York after the first', () => {
  const g2 = DRIVER_EXPECT.G2({ city: 'New York', hasEta: true })
  assert.deepEqual(g2[0]("I'm on a walkaround outside NY, should be at the drop in a bit."), ['ETA without an hour'])
  assert.deepEqual(g2[0]('Due in around 4:30 PM.'), [])
  assert.deepEqual(g2[1]('On the road near New York, about an hour out.'), [])
  const g3 = DRIVER_EXPECT.G3({ fuelPct: 96 })
  assert.equal(g3[0], undefined)
  assert.deepEqual(g3[1]('Fuel is sitting at about 96%.'), [])
  assert.deepEqual(g3[1]('Fuel is fine, but I still hate the city.'), ['fuel not 96%', 'New York again'])
})

// Kills: counting a finding once per reply instead of once per run, or a
// scenario with findings reported as clean.
test('the summary counts runs, not replies, and lists the clean scenarios', () => {
  const rows = [
    { scenario: 'S1', run: 1, findings: ['same question as last reply'] },
    { scenario: 'S1', run: 1, findings: ['same question as last reply'] },
    { scenario: 'S1', run: 2, findings: [] },
    { scenario: 'S6', run: 1, findings: [] },
  ]
  const { lines, clean } = summarize(rows, 2)
  assert.deepEqual(lines, ['| S1 | same question as last reply | 1/2 |'])
  assert.deepEqual(clean, ['S6'])
})

// Kills: the system's own holding line ("Give me a minute ...") being
// counted as the model promising to come back -- it is a separate result.
test('the fallback replies are "fell back", not a promise', () => {
  assert.deepEqual(anyReply(DRIVER_FALLBACK), ['fell back'])
  assert.deepEqual(anyReply(BROKER_FALLBACK), ['fell back'])
  assert.deepEqual(anyReply('Give me a minute, back soon.'), ['promises to get back'])
})

// Kills: Grace's persona (drivers.bio) telling the model to say "let me
// look" while the prompt forbids it (ED02/ED10, 2026-10-12). 051 wrote the
// phrase; 057 must replace exactly it (a one-character mismatch makes the
// UPDATE a silent no-op) with words that are not a promise.
test('the migration that fixes the Grace bio matches the old text and promises nothing', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations')
  const read = (name) => readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n')
  const old = read('051_driver_bio.sql')
  const fix = read('057_grace_bio_no_promise.sql')
  const [, from, to] = /replace\(bio, '([^']*)', '([^']*)'\)/.exec(fix)
  assert.ok(old.includes(from), 'the phrase 057 replaces is in 051')
  assert.match(old, PROMISE, '051 does contain a promise (the thing being fixed)')
  assert.doesNotMatch(old.replace(from, to), PROMISE)
  assert.doesNotMatch(to, PROMISE)
})
