// What the dispatcher said about the market and the rate, read by code
// (src/modules/brokerChat/rateTalk.js) and put in the broker's prompt as a
// fact. Cases are the live failures of chat:eval on 2026-10-14 (EB04, EB06).
// No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  marketClaims, ratePushes, dollars, rateReasons, unsupportedRateReasons, raiseWithoutReason, holdRateLine, HEAVY_LBS, DEADHEAD_REASON_MILES,
} from '../src/modules/brokerChat/rateTalk.js'
import { HEAVY_LBS as BOOKING_HEAVY_LBS } from '../src/modules/brokerChat/bookingTalk.js'
import { buildBrokerSystemPrompt, rateTalkBlock, rateReasonLines } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { REGIONAL_LINEHAUL, fuelPerMile } from '../src/constants/marketRates.js'

const flatbed = { equipmentType: 'flatbed', rateUsd: 3820, distanceMi: 1000, originState: 'NC', destinationState: 'TX', id: 'p1' }
const dryVan = { ...flatbed, equipmentType: 'dry-van' }

// Kills: the EB06 claim not checked against the table
test('EB06: carolinas flatbed at 4.75 is wrong; the real figure is the table value 2.95', () => {
  const [c] = marketClaims(['DAT shows carolinas flatbed at 4.75 linehaul this week so ur way under'], flatbed)
  assert.equal(c.region, 'Carolinas')
  assert.equal(c.equipmentType, 'flatbed')
  assert.equal(c.claimed, 4.75)
  assert.equal(c.real, REGIONAL_LINEHAUL.flatbed.Carolinas)
  assert.equal(c.real, 2.95)
  assert.equal(c.verdict, 'wrong')
})

// Kills: a correct quote read as wrong (EB04)
test('EB04: south central dry-van at 1.98 is the real figure', () => {
  const claims = marketClaims(['DAT has south central at 1.98, reload out of there is dead, ill be deadheading out. need $4278'], dryVan)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].real, 1.98)
  assert.equal(claims[0].verdict, 'right')
})

// Kills: an all-in quote compared to linehaul
test('an all-in quote is compared with linehaul plus fuel', () => {
  const real = Math.round((2.95 + fuelPerMile('flatbed')) * 100) / 100
  const [c] = marketClaims([`DAT has carolinas flatbed at ${real.toFixed(2)} all in`], flatbed)
  assert.equal(c.basis, 'all-in')
  assert.equal(c.real, real)
  assert.equal(c.verdict, 'right')
  // the same number as a linehaul figure is wrong
  assert.equal(marketClaims([`DAT has carolinas flatbed at ${real.toFixed(2)} linehaul`], flatbed)[0].verdict, 'wrong')
})

// Kills: $4278 read as a per-mile figure
test('a total in dollars is not a per-mile figure', () => {
  assert.deepEqual(marketClaims(['carolinas flatbed, need $4278'], flatbed), [])
  assert.deepEqual(marketClaims(['carolinas is 0.25 and 12.50'], flatbed), [])
})

// Kills: region aliases or the default equipment lost
test('aliases and defaults: national, pnw, no equipment named, no figure for the region', () => {
  assert.equal(marketClaims(['DAT has nationwide van at 2.17'], flatbed)[0].verdict, 'right')
  assert.equal(marketClaims(['DAT has nationwide van at 2.17'], flatbed)[0].equipmentType, 'dry-van')
  assert.equal(marketClaims(['DAT has south east at 3.21'], flatbed)[0].verdict, 'right') // default = posting's flatbed
  // Pacific Northwest has no dry-van figure this week: never confirmed, never contradicted
  assert.equal(marketClaims(['DAT has pnw dry van 2.50'], flatbed)[0].verdict, 'no-figure')
  assert.equal(marketClaims(['DAT has pnw dry van 2.50'], flatbed)[0].real, null)
})

// Kills: duplicates or more than three claims in the prompt
test('claims are deduplicated and capped at three', () => {
  assert.equal(marketClaims(['DAT carolinas flatbed 4.75', 'DAT carolinas flatbed 4.75'], flatbed).length, 1)
  const many = ['$4.1 carolinas. $4.2 southeast. $4.3 california. $4.4 ohio river']
  assert.equal(marketClaims(many, flatbed).length, 3)
})

// Kills: a first push not counted / second counted as first
test('pushes: the first is counted and current, the second is count 2', () => {
  assert.deepEqual(ratePushes(['hi', 'DAT has south central at 1.98, need $4278'], dryVan), { count: 1, current: true })
  assert.deepEqual(ratePushes(['need $4278', 'ok what about the pickup'], dryVan), { count: 1, current: false })
  assert.deepEqual(ratePushes(['need $4278', 'come on you can do better'], dryVan), { count: 2, current: true })
  assert.deepEqual(ratePushes(['hi', 'whats the rpm'], dryVan), { count: 0, current: false })
  // a market figure below the posted rate, or above $5/mi, is not a push
  assert.equal(ratePushes(['carolinas is $4.75'], dryVan).count, 0)
  assert.equal(ratePushes(['I want $9000'], dryVan).count, 0)
})

// Kills: pushes counted on a load with no posted rate
test('a call-for-rate load has no pushes to count', () => {
  assert.equal(ratePushes(['need $4278'], { ...dryVan, rateHidden: true }), null)
})

// Kills: dollars() changed when it moved out of scenarioChecks
test('dollars reads $3,750 and $3750 alike', () => {
  assert.deepEqual(dollars('I can do $3,750, or $3750 all-in, $2.19/mi'), [3750, 3750, 2.19])
})

const promptWith = (said, posting = flatbed) => buildBrokerSystemPrompt({
  broker: { contactName: 'R K', name: 'X', persona: 'Blunt.' },
  posting: { ...posting, originCity: 'A', destinationCity: 'B', destinationState: 'TX', commodity: 'steel', weightLbs: 40000, equipmentLengthFt: 48, postedAt: null },
  now: new Date('2026-10-14T15:00:00Z'),
  said,
})

// Kills: the fact computed but not put in the prompt
test('the prompt tells the broker the real figure and the push count', () => {
  const p = promptWith(['DAT shows carolinas flatbed at 4.75 linehaul this week so ur way under'])
  assert.match(p, /They said Carolinas flatbed linehaul is \$4\.75\/mi\. Your figure is \$2\.95\/mi\. That is not what DAT shows\./)
  assert.match(p, /Never repeat their number back as if it were true/)
  const first = promptWith(['need $4278'])
  assert.match(first, /this is the first time they have asked for more than your \$3820\. Hold at \$3820/)
  const second = promptWith(['need $4278', 'do better'])
  assert.match(second, /they have asked for more 2 times/)
  assert.doesNotMatch(second, /first time they have asked/)
})

// Kills: lines added when nothing was said
test('nothing said, nothing added', () => {
  assert.deepEqual(rateTalkBlock({ posting: flatbed, said: null }), [])
  assert.deepEqual(rateTalkBlock({ posting: flatbed, said: [] }), [])
  assert.deepEqual(rateTalkBlock({ posting: flatbed, said: ['hi there'] }), [])
  assert.doesNotMatch(promptWith(['hi there']), /ON THE RATE SO FAR|WHAT THEY SAID ABOUT THE MARKET/)
})

// Kills: the right and no-figure lines swapped
test('a right quote is acknowledged, an unknown one is not confirmed', () => {
  assert.match(promptWith(['DAT south central at 2.46']), /That matches your figure -- they know the market\./)
  assert.match(promptWith(['DAT pnw dry van 2.50']), /You have no figure for that this week: do not confirm it\./)
})

const carolinasFlat = { ...flatbed, rateUsd: 3880, distanceMi: 1000 } // posted $3.88/mi

// Kills: the posting's own per-mile figure read as a wrong market claim
test('quoting the posted $/mi back is not a market claim', () => {
  assert.deepEqual(marketClaims(['you posted $3.88/mi out of carolinas flatbed'], carolinasFlat), [])
  assert.deepEqual(marketClaims(['DAT has carolinas flatbed at 3.89'], carolinasFlat), [])
  assert.equal(marketClaims(['DAT has carolinas flatbed at 4.75'], carolinasFlat).length, 1)
})

// Kills: a bare number read as a market figure with nothing about the market in the sentence
test('a bare number needs a market word, a region, a $ or /mi', () => {
  assert.deepEqual(marketClaims(['flatbed leaves at 4.75 tomorrow'], flatbed), []) // no region, no market word
  assert.equal(marketClaims(['carolinas flatbed leaves at $4.75'], flatbed).length, 1)
  assert.equal(marketClaims(['carolinas flatbed is 4.75/mi'], flatbed).length, 1)
  assert.equal(marketClaims(['spot rate carolinas flatbed 4.75'], flatbed).length, 1)
})

// Kills: "flat rate" read as a flatbed
test('"flat rate" is not a flatbed', () => {
  const [c] = marketClaims(['DAT has south central at 1.98 flat rate'], dryVan)
  assert.equal(c.equipmentType, 'dry-van')
  assert.equal(marketClaims(['DAT has south central flat at 2.46'], dryVan)[0].equipmentType, 'flatbed')
})

// Kills: an acceptance counted as a push
test('taking the broker number is not a push', () => {
  for (const t of ['ok $3900 works', 'deal, book it at $3900', 'sounds good $3900', 'that works $3900']) {
    assert.equal(ratePushes([t], dryVan).count, 0, t)
  }
  assert.equal(ratePushes(['can you do $3900'], dryVan).count, 1)
})

// Kills: a bare per-mile ask not counted as a push
test('a per-mile ask above the posted rate is a push, a market quote is not', () => {
  const p = { ...dryVan, rateUsd: 3000, distanceMi: 1000 } // $3.00/mi
  assert.equal(ratePushes(['can u do 4.20/mi'], p).count, 1)
  assert.equal(ratePushes(['can u do 2.90/mi'], p).count, 0)
  assert.equal(ratePushes(['can u do 3.00/mi'], p).count, 0)
  assert.equal(ratePushes(['DAT has carolinas at 4.20/mi'], p).count, 0)
})

// Kills: the first-push line contradicting the walk-away rule
test('the first-push line leaves room for the walk-away rule', () => {
  assert.match(promptWith(['need $4278']), /unless they are walking away; then the walk-away rule applies/)
})

// Kills: an accepting word hiding a counter ("ok but need $4278")
test('a message that accepts and still asks for more is a push', () => {
  for (const t of ['ok but need $4278', 'okay can you do $4100?', 'sounds good but can you do better', 'that works but need 4200', 'works but $4100']) {
    assert.deepEqual(ratePushes([t], dryVan), { count: 1, current: true }, t)
  }
})

// Kills: a region name not counted as market context for a bare figure
test('a region name is market context: "carolinas flatbed is 4.75 this week" is a wrong claim', () => {
  const [wrong] = marketClaims(['carolinas flatbed is 4.75 this week'], flatbed)
  assert.equal(wrong.verdict, 'wrong')
  const [right] = marketClaims(['south central at 1.98 reload is dead'], dryVan)
  assert.equal(right.verdict, 'right')
})

// -- Reasons to pay more: only from the data ----------------------------------

const NOW = new Date('2026-10-18T12:00:00Z')
const inHours = (h) => new Date(NOW.getTime() + h * 3600e3).toISOString()
// dry-van OR -> OR: the destination's market equals the national figure's side
// is not asserted here; the weak-reload case below picks its own states.
const lane = { ...dryVan, originState: 'TX', destinationState: 'TX', weightLbs: 30000, distanceMi: 1000, rateUsd: 2000, pickupAt: inHours(30) }

// Kills: HEAVY_LBS defined twice, or a heavy load not counted as a reason
test('rateReasons: weight over HEAVY_LBS', () => {
  assert.equal(HEAVY_LBS, 40000)
  assert.equal(BOOKING_HEAVY_LBS, HEAVY_LBS)
  assert.ok(rateReasons({ posting: { ...lane, weightLbs: 45000 }, now: NOW }).includes('weight'))
  assert.ok(!rateReasons({ posting: lane, now: NOW }).includes('weight'))
})

// Kills: "tight window" allowed on a pickup more than a day out, or after it has passed
test('rateReasons: tight window only within 24 hours before pickup', () => {
  const has = (h) => rateReasons({ posting: { ...lane, pickupAt: inHours(h) }, now: NOW }).includes('tight-window')
  assert.equal(has(30), false)
  assert.equal(has(24), true)
  assert.equal(has(20), true)
  assert.equal(has(-2), false)
})

// Kills: deadhead allowed on a short empty run
test('rateReasons: deadhead from DEADHEAD_REASON_MILES, truck known', () => {
  assert.equal(DEADHEAD_REASON_MILES, 150)
  const has = (truck) => rateReasons({ posting: lane, truck, now: NOW }).includes('deadhead')
  assert.equal(has({ miles: 300 }), true)
  assert.equal(has({ miles: 50 }), false)
  assert.equal(has(null), false)
})

// Kills: weak-reload decided by anything but the destination market against national
test('rateReasons: weak reload when the destination pays below national', () => {
  const weakIn = (st) => rateReasons({ posting: { ...lane, destinationState: st }, now: NOW }).includes('weak-reload')
  assert.equal(weakIn('FL'), true) // Florida-So Georgia 1.43 < national 2.17
  assert.equal(weakIn('IL'), false) // 2.66
  assert.equal(weakIn('WA'), false) // equal to national is not weak
})

// Kills: S9c "$7,600, pickup window's tight" passing when the pickup is 30h out
test('unsupportedRateReasons: tight window on a far pickup is flagged', () => {
  const far = { ...lane, rateUsd: 7000, distanceMi: 2000, pickupAt: inHours(30) }
  const near = { ...far, pickupAt: inHours(20) }
  const reply = "I can do $7,600, pickup window's tight."
  assert.deepEqual(unsupportedRateReasons(reply, { posting: far, now: NOW, text: 'need $8000' }), ['tight-window'])
  assert.deepEqual(unsupportedRateReasons(reply, { posting: near, now: NOW, text: 'need $8000' }), [])
  assert.deepEqual(unsupportedRateReasons("It's $7,000, pickup window's tight.", { posting: far, now: NOW }), [])
  assert.deepEqual(unsupportedRateReasons("OK $7,600 it is, pickup window's tight.", { posting: far, now: NOW, text: 'can you do $7,600' }), [])
})

// Kills: the prompt listing "a pickup within a day" on a load that is two days out
test('rateReasonLines: only reasons true of the load, or hold', () => {
  const text = (p, o = {}) => rateReasonLines(p, { now: NOW, ...o }).join(' ')
  assert.doesNotMatch(text({ ...lane, pickupAt: inHours(48) }), /a pickup within a day/)
  assert.match(text({ ...lane, pickupAt: inHours(10) }), /a pickup within a day/)
  assert.match(text({ ...lane, weightLbs: 45000 }), /heavy freight \(45,000 lbs\)/)
  assert.match(text(lane, { truck: { miles: 300 } }), /their 300-mile empty run/)
  // A destination that pays at least national, a light load, a far pickup: nothing to pay more for.
  const holdState = ['FL', 'TX', 'IL', 'CA', 'NY', 'GA', 'OH', 'WA'].find((st) => rateReasons({ posting: { ...lane, destinationState: st }, now: NOW }).length === 0)
  assert.ok(holdState, 'some destination has no reason')
  assert.match(text({ ...lane, destinationState: holdState }), /no reason to pay more; hold/)
  const prompt = buildBrokerSystemPrompt({ broker: { name: 'B', contactName: 'Dee', persona: 'p' }, posting: { ...lane, pickupAt: inHours(48), id: 'p9' }, now: NOW })
  assert.doesNotMatch(prompt, /a pickup within a day/)
})

// Kills: S9c's made-up "tight window" reaching the carrier unchallenged (one regeneration, not a fallback)
test('brokerReplyProblem: a reason the load does not have is a content problem', async () => {
  const { brokerReplyProblem } = await import('../src/modules/brokerChat/replyProblem.js')
  const far = { ...lane, rateUsd: 7000, distanceMi: 2000, pickupAt: inHours(30) }
  const p = brokerReplyProblem("I can do $7,600, pickup window's tight.", { posting: far, now: NOW, text: 'need $8000' })
  assert.equal(p.why, 'gave a reason this load does not have')
  assert.equal(p.unusable, false)
  assert.match(p.hint, /true of this load: none|true of this load: /)
  assert.equal(brokerReplyProblem("I can do $7,600, pickup window's tight.", { posting: { ...far, pickupAt: inHours(20) }, now: NOW, text: 'need $8000' }), null)
})

// Kills: bare "window" (a delivery or appointment window) read as a tight pickup; "$7.6k" slipping past
test('tight-window words need a tight window; $7.6k is read as 7600; a missing truck has no "undefined"', () => {
  const far = { ...lane, rateUsd: 2000, distanceMi: 1000, weightLbs: 45000, pickupAt: inHours(48) }
  const un = (reply) => unsupportedRateReasons(reply, { posting: far, now: NOW, text: 'need $2,600' })
  assert.deepEqual(un('$2,400 with the weight, delivery window is 8-12'), [])
  assert.deepEqual(un('Appointment window is 8 to 12'), [])
  assert.deepEqual(un("$2,400, window's 8-12 at delivery"), [])
  assert.deepEqual(un("$2,400, pickup window's tight"), ['tight-window'])
  assert.deepEqual(un('$2,400, the window is tight'), ['tight-window'])
  assert.deepEqual(un('$2.4k, short notice'), ['tight-window'])
  assert.deepEqual(unsupportedRateReasons('ok $2.6k, short notice', { posting: far, now: NOW, text: '$2,600?' }), [])
  assert.doesNotMatch(rateReasonLines(far, { now: NOW, truck: {} }).join(' '), /undefined/)
})

// -- A raise with no reason ------------------------------------------------------

// IL is not a weak reload, 30,000 lbs is not heavy and the pickup is two days
// out: nothing about this load earns a raise.
const FLAT = { ...lane, destinationState: 'IL', pickupAt: inHours(48) }
const HEAVY = { ...FLAT, weightLbs: 45000 }
const RAISE = 'I can do $2,300 on this one.'

// Kills: the "no reason" gate returning true for every raise, or the reasons
// being read from nothing -- the probe must be flagged on a flat load.
test('raiseWithoutReason: a figure above the posted rate with no reason on the load is flagged', () => {
  assert.deepEqual(rateReasons({ posting: FLAT, now: NOW }), [])
  assert.equal(raiseWithoutReason(RAISE, { posting: FLAT, now: NOW }), true)
})

// Kills: the rateReasons gate removed (a raise flagged even with a true reason
// named in the reply), or a reason word counted that the load does not have.
test('raiseWithoutReason: a reason true of the load, named in the reply, clears the raise', () => {
  assert.equal(raiseWithoutReason('I can do $2,300 with the weight on it.', { posting: HEAVY, now: NOW }), false)
  // The same words on a load that is not heavy are not a reason it has.
  assert.equal(raiseWithoutReason('I can do $2,300 with the weight on it.', { posting: FLAT, now: NOW }), true)
  // A true reason the reply does not give is no help either.
  assert.equal(raiseWithoutReason(RAISE, { posting: HEAVY, now: NOW }), true)
})

// Kills: the earlier-broker-figure exemption removed, so the broker repeating a
// figure it already gave (and was already checked on) is flagged again.
test('raiseWithoutReason: a figure the broker already said is not a new raise', () => {
  assert.equal(raiseWithoutReason(RAISE, { posting: FLAT, now: NOW, earlier: [2300] }), false)
  assert.equal(raiseWithoutReason(RAISE, { posting: FLAT, now: NOW, earlier: [2100] }), true)
})

// Kills: the refusal exemption removed (the broker turning down the carrier's
// figure is flagged as offering it), or applied to a figure it did offer.
test('raiseWithoutReason: refusing their figure is not a raise; offering it is', () => {
  assert.equal(raiseWithoutReason("I can't do $2,600.", { posting: FLAT, now: NOW, theirs: [2600] }), false)
  assert.equal(raiseWithoutReason("Can't do $2,600, but I can do $2,300.", { posting: FLAT, now: NOW, theirs: [2600] }), true)
  assert.equal(raiseWithoutReason('I can do $2,600.', { posting: FLAT, now: NOW, theirs: [2600] }), true)
  // A refusal of a figure the dispatcher never named is not covered.
  assert.equal(raiseWithoutReason("I can't, but $2,300 is there.", { posting: FLAT, now: NOW, theirs: [2600] }), true)
})

// Kills: ">" turned into ">=" (the posted rate flagged as a raise), a figure
// below the posted rate flagged, or the lane ceiling (DB_RPM_MAX per mile)
// dropped so a total like "$9,000" is read as a raise.
test('raiseWithoutReason: the posted rate, lower figures and figures past the lane ceiling are not a raise', () => {
  assert.equal(raiseWithoutReason('$2,000 all-in is where it sits.', { posting: FLAT, now: NOW }), false)
  assert.equal(raiseWithoutReason('I could come down to $1,900.', { posting: FLAT, now: NOW }), false)
  assert.equal(raiseWithoutReason('That is $9,000 over the whole month.', { posting: FLAT, now: NOW }), false)
  assert.equal(raiseWithoutReason('No figures here.', { posting: FLAT, now: NOW }), false)
})

// Kills: the live check not asking raiseWithoutReason (or dropping the
// fallback line): an unexplained raise must end on the posted rate, not be shown.
test('brokerReplyProblem: a raise with no reason is unusable and falls back to holding the posted rate', async () => {
  const { brokerReplyProblem } = await import('../src/modules/brokerChat/replyProblem.js')
  const p = brokerReplyProblem(RAISE, { posting: FLAT, now: NOW, text: 'need $2,600' })
  assert.equal(p.why, 'raised the rate with no reason this load has')
  assert.equal(p.unusable, true)
  assert.match(p.hint, /hold at \$2000/)
  assert.equal(p.safeReply, holdRateLine(FLAT))
  assert.equal(brokerReplyProblem('I can do $2,300 with the weight on it.', { posting: HEAVY, now: NOW, text: 'need $2,600' }), null)
})

// Kills: the live check ignoring what the broker already said (brokerSaid), or
// the dispatcher's whole thread (said): a figure the broker gave an earlier
// turn, or refused in this one, must not be flagged again.
test('brokerReplyProblem: earlier broker figures and refused dispatcher figures are exempt', async () => {
  const { brokerReplyProblem } = await import('../src/modules/brokerChat/replyProblem.js')
  const base = { posting: FLAT, now: NOW, text: 'ok' }
  assert.equal(brokerReplyProblem(RAISE, { ...base, brokerSaid: ['Best I have is $2,300.'] }), null)
  assert.equal(brokerReplyProblem("I can't do $2,600.", { ...base, said: ['can you do $2,600?', 'ok'] }), null)
  assert.equal(brokerReplyProblem("I can't do $2,600.", { ...base, said: ['ok'] })?.why, 'raised the rate with no reason this load has')
})

// Kills: the hold line being a reply the shared check itself rejects, so the
// fallback would be thrown away on the next turn.
test('holdRateLine passes the full broker reply check', async () => {
  const { brokerReplyProblem } = await import('../src/modules/brokerChat/replyProblem.js')
  assert.equal(holdRateLine(FLAT), '$2,000 all-in is where this one stays.')
  assert.equal(brokerReplyProblem(holdRateLine(FLAT), { posting: FLAT, now: NOW, text: 'need $2,600', booking: null }), null)
})

// Kills: the refusal test looking at the figure's own clause only: "You said
// $2,300, I can't do that" and "$2,500 is high" are turn-downs, not offers.
test('raiseWithoutReason: a refusal in the clause after their figure, or "is high", is not a raise', () => {
  const o = (theirs) => ({ posting: FLAT, now: NOW, theirs })
  assert.equal(raiseWithoutReason("You said $2,300, I can't do that, $2,000 is it.", o([2300])), false)
  assert.equal(raiseWithoutReason("Ok $2,500 is high, I'm at $2,000.", o([2500])), false)
  // The thousands comma still keeps "$2,600" one figure.
  assert.equal(raiseWithoutReason("$2,600? Can't do that.", o([2600])), false)
})

// Kills: the next-clause refusal applied when their figure is accepted
// ("$2,300 works, no problem" is a yes), or "no problem" counted as a "no".
test('raiseWithoutReason: accepting their figure is a raise even with "no problem" after it', () => {
  const o = { posting: FLAT, now: NOW, theirs: [2300] }
  assert.equal(raiseWithoutReason('Ok $2,300 works, no problem.', o), true)
  assert.equal(raiseWithoutReason('I can do $2,300, no worries.', o), true)
  assert.equal(raiseWithoutReason('So $2,300, no problem.', o), true)
  assert.equal(raiseWithoutReason('$2,300 works, I cannot wait to move it.', o), true)
})

// Kills: holdRateLine printing thousands bare ("$12500").
test('holdRateLine groups thousands like the weight line', () => {
  assert.equal(holdRateLine({ ...FLAT, rateUsd: 12500 }), '$12,500 all-in is where this one stays.')
})
