// What the dispatcher said about the market and the rate, read by code
// (src/modules/brokerChat/rateTalk.js) and put in the broker's prompt as a
// fact. Cases are the live failures of chat:eval on 2026-10-14 (EB04, EB06).
// No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { marketClaims, ratePushes, dollars } from '../src/modules/brokerChat/rateTalk.js'
import { buildBrokerSystemPrompt, rateTalkBlock } from '../src/modules/brokerChat/brokerChat.prompt.js'
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

// Kills: a bare number with no market context read as a market figure
test('a bare number needs a market word or a $ or /mi', () => {
  assert.deepEqual(marketClaims(['carolinas flatbed leaves at 4.75 tomorrow'], flatbed), [])
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
  for (const t of ['ok $3900 works', 'deal, book it at $3900', 'okay $3900', 'sounds good $3900']) {
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
