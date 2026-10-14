// The chat:eval case bank. Each check is tried on a real reply from the
// 2026-10-05/06 runs (reports/) that it must pass, and on one it must
// flag. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROKER_CASES, DRIVER_CASES, brokerFindings, driverFindings, CLASSIFIER_ONLY_FINDING } from '../scripts/evalCases.js'

const b = (id) => BROKER_CASES.find((c) => c.id === id)
const d = (id) => DRIVER_CASES.find((c) => c.id === id)

// Kills: a bank that drifts from ten and ten (the run is sized to the
// daily budget on that count), or a case without its grading note.
test('ten broker and ten driver cases, each with words, a check and a right answer', () => {
  assert.equal(BROKER_CASES.length, 10)
  assert.equal(DRIVER_CASES.length, 10)
  for (const c of [...BROKER_CASES, ...DRIVER_CASES]) {
    assert.ok(c.line && c.good && typeof c.expect === 'function', c.id)
  }
  assert.equal(new Set([...BROKER_CASES, ...DRIVER_CASES].map((c) => c.id)).size, 20)
})

// Kills: "fuel's separate" passing as all-in (heard 2026-10-05).
test('EB01 all-in', () => {
  const check = b('EB01').expect()
  assert.deepEqual(check("Yeah, that's all-in -- linehaul and fuel together, nothing on top."), [])
  assert.deepEqual(check("Rate's $3,100, fuel's separate."), ['all-in not said', 'says fuel is extra'])
  assert.deepEqual(check("It's all-in at $3,100 plus fuel."), ['says fuel is extra'])
})

// Kills: the rpm not checked against rate / miles.
test('EB02 rpm is rate over miles', () => {
  const check = b('EB02').expect({ posting: { rateUsd: 7755, distanceMi: 2454 } })
  assert.deepEqual(check("It's $3.16 a mile, all-in."), [])
  assert.deepEqual(check("It's around $2.90 a mile."), ['rpm 3.16 not given'])
})

// Kills: a first-push move passing.
test('EB04 holds on the first push', () => {
  const check = b('EB04').expect({ posting: { rateUsd: 3541 } })
  assert.deepEqual(check("That deadhead is real. But $3541 is what this lane pays right now."), [])
  assert.deepEqual(check('I can do $3,750.'), ['moved on the first push'])
})

// Kills: terms checked against anything but this broker's own.
test('EB07 the broker\'s own accessorials', () => {
  const check = b('EB07').expect({ terms: { detentionPerHour: 80, tonuUsd: 225, layoverPerDay: 275 } })
  assert.deepEqual(check('Detention is $80 an hour after two free. TONU is $225. Layover is $275 a day.'), [])
  assert.deepEqual(check('Detention is $80 an hour after two free.'), ['TONU $225 missing', 'layover $275 missing'])
})

// Kills: paperwork requests and the shared checks not applied to every case.
test('every broker reply is checked for paperwork, promises and markdown', () => {
  assert.deepEqual(brokerFindings("What's your MC number?", () => []), ['asks for paperwork'])
  assert.deepEqual(brokerFindings('Let me check and get back to you.', () => []), ['promises to get back'])
  assert.deepEqual(brokerFindings('(FAILED: AI quota exhausted)', () => ['x']), ['no reply'])
})

// Kills: a safety classifier label being graded as a normal character
// answer, or a broad "safety" match that rejects an ordinary reply.
test('classifier-only labels are findings in either chat, normal replies are not', () => {
  const normal = "Doing all right, dispatch. Just finished the walkaround. What's next?"
  assert.deepEqual(driverFindings('User Safety: safe', () => [], { onTheRoad: false }), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(driverFindings(' user safety: unsafe ', () => [], { onTheRoad: false }), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(brokerFindings('User Safety: safe', () => []), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(driverFindings(normal, () => [], { onTheRoad: false }), [])
  assert.deepEqual(driverFindings('Safety at the dock comes first.', () => [], { onTheRoad: false }), [])
})

// Kills: Grace's ETA, fuel, hours and pay checks not reading her data.
test('ED02/ED04/ED05/ED09 read her own numbers', () => {
  assert.deepEqual(d('ED02').expect({ load: { etaAt: 'x' } })("I'm on a walkaround outside NY, should be at the drop in a bit."), ['ETA without an hour'])
  assert.deepEqual(d('ED04').expect({ driver: { hosRemainingMin: 395 } })('Got 6h 35m left today.'), [])
  assert.deepEqual(d('ED04').expect({ driver: { hosRemainingMin: 395 } })('Plenty left, boss.'), ['not 6h 35m'])
  assert.deepEqual(d('ED05').expect({ fuelPct: 96 })('Fuel is sitting at about 96%.'), [])
  assert.deepEqual(d('ED05').expect({ fuelPct: 96 })("Fuel's fine."), ['fuel not 96%'])
  assert.deepEqual(d('ED09').expect({ standing: { unpaidCount: 2, owedUsd: 1840.4 } })("Still waiting on $1,840 from two loads."), [])
  assert.deepEqual(d('ED09').expect({ standing: { unpaidCount: 2, owedUsd: 1840.4 } })('Not yet.'), ['owed $1840 not said'])
})

// Kills: a bot admission or an invented amount passing; NYC unraised passing.
test('ED06/ED08/ED10 her character and her request', () => {
  assert.deepEqual(d('ED10').expect()("Ha, sure. A bot that can't find parking."), [])
  assert.deepEqual(d('ED10').expect()("I'm an AI assistant."), ['breaks character'])
  assert.deepEqual(d('ED06').expect()('Sat four hours, they owe $200.'), ['quotes money she was never given'])
  assert.deepEqual(d('ED08').expect()('Copy that, I am on the NYC load. I asked you not to give me this one.'), [])
  assert.deepEqual(d('ED08').expect()('Copy that.'), ['her own request not raised'])
  assert.deepEqual(driverFindings('Waiting on the dock, box is loaded.', () => [], { onTheRoad: true }), ['at a dock while on the road'])
})

// Kills: matching before normalizing (gpt-oss writes U+2011)
test('EB01 sees an all-in written with a non-breaking hyphen and an em dash', () => {
  const reply = 'Sorry for the hold‑up—yes, that $3,820 rate is all‑in, no fuel surcharge on top.'
  assert.deepEqual(brokerFindings(reply, b('EB01').expect()), [])
})

// Kills: PROMISE missing a curly apostrophe
test("a curly-apostrophe \"I'll confirm\" is still a promise to get back", () => {
  assert.ok(brokerFindings('I’ll confirm the exact count when the truck arrives.', () => []).includes('promises to get back'))
  assert.ok(driverFindings('I’ll check on that.', () => [], { onTheRoad: false }).includes('promises to get back'))
})

// Kills: ED07 counting only "?" as asking
test('ED07 counts a request for the details as asking, a bare acknowledgement is not', () => {
  const check = d('ED07').expect()
  assert.deepEqual(check('Copy that. Need pickup address, miles, and delivery info.'), [])
  assert.deepEqual(check('Copy that. Send me the details.'), [])
  assert.deepEqual(check('Copy that.'), ['asks nothing about the load'])
  assert.deepEqual(check('Copy that. I need to get fuel before I roll.'), ['asks nothing about the load'])
})

// Kills: the dash-led line being left out of the markdown count after normalizing (accepted trade-off: "- " leads a bullet)
test('a reply that opens with an em dash is read as a bulleted line once folded', () => {
  assert.deepEqual(brokerFindings('— yes, all-in.', () => []), ['markdown'])
})
