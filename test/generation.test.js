// The generator must never fail. That is the whole requirement.
//
// It used to be twenty-four model calls per refresh, four retries each,
// asking a language model to pick items from lists the prompt already
// contained and to guess numbers the code then clamped into bands it had
// computed itself. It emptied a provider's daily quota during an ordinary
// day of development, and when the calls failed the board stayed empty --
// which made the next startup try again, because "board is empty" was the
// trigger. Failure fed the retry that caused it.
//
// Nothing here touches a network. These tests run the generator at volume
// and assert that every row it makes passes the same schema and the same
// validator the AI output had to pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  generateLoad, generateApplicant, generateTruckListing, LANES, weighted, centered,
  brokerWeights, LOYALTY_BONUS_PER_LOAD, LOYALTY_MAX_LOADS,
} from '../scripts/seed/generate.js'
import { HIDDEN_RATE_SHARE } from '../scripts/seed/postings.js'
import { LoadItem, ApplicantItem, TruckListingItem } from '../scripts/seed/schemas.js'
import {
  validateLoadItem, validateApplicantItem, validateTruckListingItem,
  rateBandFor, RATE_ABSOLUTE_MIN, RATE_ABSOLUTE_MAX,
} from '../scripts/seed/validate.js'
import { COMMODITIES, TRUCK_MODELS, TRUCK_MAKES } from '../scripts/seed/vocabulary.js'
import { seeded } from './helpers/rng.js'

const N = 20000

test('20,000 generated loads: zero rejected, by shape or by meaning', () => {
  const rng = seeded(4471)
  const failures = []
  for (let i = 0; i < N; i += 1) {
    const item = generateLoad(rng, {})
    const parsed = LoadItem.safeParse(item)
    if (!parsed.success) {
      failures.push(`shape: ${JSON.stringify(parsed.error.issues[0])} — ${JSON.stringify(item)}`)
      continue
    }
    const result = validateLoadItem(parsed.data)
    if (!result.ok) failures.push(`semantic: ${result.reason}`)
  }
  assert.deepEqual(failures.slice(0, 3), [], `${failures.length} ta yiqildi`)
})

test('the downstream clamp never has to change a generated rate or weight', () => {
  // If it does, the generator and the pricing model disagree -- and the
  // clamp would be silently correcting the generator on every row rather
  // than catching a bad model guess, which is what it is for.
  const rng = seeded(99)
  for (let i = 0; i < 5000; i += 1) {
    const item = generateLoad(rng, {})
    const result = validateLoadItem(LoadItem.parse(item))
    assert.equal(result.item.ratePerMile, item.ratePerMile, JSON.stringify(item))
    assert.equal(result.item.weightLbs, item.weightLbs, JSON.stringify(item))
  }
})

test('the schema bound contains every rate the pricing model can produce', () => {
  // The 18-in-50,000 defect. rateBandFor could return 4.375 for a
  // short-haul tanker while LoadItem capped ratePerMile at 4.0 -- a rate
  // the pricing model considers correct and the schema rejected. The AI
  // path never hit it because it parses BEFORE the clamp: the model was
  // told 1.2-4.0, obeyed, and the clamp raised the value afterwards.
  // Generating from the band walked straight into it.
  //
  // Both numbers now come from the same multipliers, and this asserts
  // they stay that way.
  for (const eq of Object.keys(COMMODITIES)) {
    for (const d of [120, 200, 249, 250, 251, 900, 2600]) {
      const [lo, hi] = rateBandFor(eq, d)
      assert.ok(lo >= RATE_ABSOLUTE_MIN - 1e-9, `${eq}/${d}: ${lo} < ${RATE_ABSOLUTE_MIN}`)
      assert.ok(hi <= RATE_ABSOLUTE_MAX + 1e-9, `${eq}/${d}: ${hi} > ${RATE_ABSOLUTE_MAX}`)
      // And the schema itself accepts both ends of that band.
      for (const rate of [lo, hi]) {
        assert.doesNotThrow(() => LoadItem.shape.ratePerMile.parse(rate), `${eq}/${d}: ${rate}`)
      }
    }
  }
})

test('20,000 generated applicants: zero rejected, and every email unique', () => {
  const rng = seeded(1990)
  const failures = []
  const emails = new Set()
  for (let i = 0; i < N; i += 1) {
    const item = generateApplicant(rng, { index: i })
    const parsed = ApplicantItem.safeParse(item)
    if (!parsed.success) {
      failures.push(JSON.stringify(parsed.error.issues[0]))
      continue
    }
    const result = validateApplicantItem(parsed.data)
    if (!result.ok) { failures.push(result.reason); continue }
    emails.add(result.item.email.toLowerCase())
  }
  assert.deepEqual(failures.slice(0, 3), [], `${failures.length} ta yiqildi`)
  // driver_applicants_email_key is a unique index. A collision inside one
  // batch is an INSERT that fails halfway through a refresh.
  assert.equal(emails.size, N, 'email takrorlandi')
})

test('20,000 generated truck listings: zero rejected', () => {
  const rng = seeded(5700)
  const failures = []
  for (let i = 0; i < N; i += 1) {
    const item = generateTruckListing(rng, {})
    const parsed = TruckListingItem.safeParse(item)
    if (!parsed.success) { failures.push(JSON.stringify(parsed.error.issues[0])); continue }
    const result = validateTruckListingItem(parsed.data)
    if (!result.ok) failures.push(result.reason)
  }
  assert.deepEqual(failures.slice(0, 3), [], `${failures.length} ta yiqildi`)
})

test('pay expectations land inside what the drivers table allows', () => {
  // drivers_pay_percent BETWEEN 1000 AND 5000; drivers_pay_cents BETWEEN
  // 30 AND 120. A value outside those is a hire that fails at the INSERT,
  // in front of a student who just clicked the button.
  const rng = seeded(27)
  for (let i = 0; i < 20000; i += 1) {
    const a = generateApplicant(rng, { index: i })
    if (a.desiredPayModel === 'percent') {
      assert.ok(a.desiredPayValue >= 1000 && a.desiredPayValue <= 5000, `bp ${a.desiredPayValue}`)
    } else {
      assert.ok(a.desiredPayValue >= 30 && a.desiredPayValue <= 120, `cents ${a.desiredPayValue}`)
    }
  }
})

test('a listing and its spec sheet describe the same truck', () => {
  // truckSpecs.js keys its engine table by make. A listing whose make is
  // not in that table gets a spec sheet built from a fallback, and the
  // page then shows a Peterbilt with somebody else's engine.
  const rng = seeded(389)
  for (let i = 0; i < 3000; i += 1) {
    const t = generateTruckListing(rng, {})
    assert.ok(TRUCK_MAKES.includes(t.make), t.make)
    assert.ok(TRUCK_MODELS[t.make].includes(t.model), `${t.make} ${t.model}`)
  }
})

test('an odometer follows the year instead of contradicting it', () => {
  // The independent-guess version produced 2024 trucks with 900,000 miles.
  const rng = seeded(2024)
  const now = new Date('2026-09-10T00:00:00Z')
  for (let i = 0; i < 20000; i += 1) {
    const t = generateTruckListing(rng, { now })
    const age = Math.max(0.5, 2026 - t.year)
    const perYear = t.odometerMi / age
    assert.ok(perYear >= 60000 && perYear <= 200000, `${t.year}: ${t.odometerMi} mi (${Math.round(perYear)}/yr)`)
  }
})

test('every equipment type has commodities, and they never cross over', () => {
  // A reefer of structural steel is a fact about the world stated wrongly.
  const rng = seeded(12)
  for (let i = 0; i < 20000; i += 1) {
    const load = generateLoad(rng, {})
    assert.ok(
      COMMODITIES[load.equipmentType].includes(load.commodity),
      `${load.equipmentType}: ${load.commodity}`,
    )
  }
})

test('there are enough lanes that a day of postings is not repetitive', () => {
  // POSTING_CONFIG generates 200 a day. With this many lanes the odds of
  // the board looking like the same six routes are not something to hope
  // about.
  assert.ok(LANES.length > 2000, `${LANES.length} ta yo'nalish`)
  const rng = seeded(7)
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const l = generateLoad(rng, { avoid: seen })
    seen.add(`${l.originCity}, ${l.originState} -> ${l.destinationCity}, ${l.destinationState}`)
  }
  assert.ok(seen.size >= 195, `200 tadan faqat ${seen.size} ta noyob`)
})

test('the weighted and centered draws behave', () => {
  const rng = seeded(3)
  // weighted respects its weights.
  const counts = { a: 0, b: 0 }
  for (let i = 0; i < 100000; i += 1) counts[weighted(rng, [['a', 80], ['b', 20]])] += 1
  assert.ok(Math.abs(counts.a / 100000 - 0.8) < 0.01, `${counts.a / 100000}`)
  // centered stays inside its range and clusters in the middle.
  let inMiddle = 0
  for (let i = 0; i < 100000; i += 1) {
    const v = centered(rng, 0, 100)
    assert.ok(v >= 0 && v <= 100)
    if (v > 25 && v < 75) inMiddle += 1
  }
  assert.ok(inMiddle / 100000 > 0.7, `markazda ${inMiddle / 100000}`)
})

test('about one posting in ten goes up without a price', () => {
  const rng = seeded(1010)
  let hidden = 0
  const N2 = 40000
  for (let i = 0; i < N2; i += 1) {
    if (generateLoad(rng, { hiddenRateShare: HIDDEN_RATE_SHARE }).rateHidden) hidden += 1
  }
  const share = hidden / N2
  assert.ok(Math.abs(share - HIDDEN_RATE_SHARE) < 0.01, `${(share * 100).toFixed(2)}%`)
})

test('a hidden-rate posting still has a real rate behind it', () => {
  // The broker negotiates from it, and postings_rpm_band still applies.
  // A posting with no number at all would be a load nobody could price.
  const rng = seeded(77)
  for (let i = 0; i < 5000; i += 1) {
    const item = generateLoad(rng, { hiddenRateShare: 1 })
    assert.equal(item.rateHidden, true)
    const result = validateLoadItem(LoadItem.parse(item))
    assert.ok(result.ok)
    assert.ok(result.item.ratePerMile > 0)
  }
})

test('hiding is off unless asked for', () => {
  // The AI path never produced this field, and a default that hid rates
  // would have changed every posting the moment the column existed.
  const rng = seeded(5)
  for (let i = 0; i < 2000; i += 1) {
    assert.equal(generateLoad(rng, {}).rateHidden, false)
  }
})

test('brokers you have hauled for post more often, and new ones never vanish', () => {
  const history = new Map([['Ironwood Freight Partners', 6], ['Redstone Logistics Partners', 2]])
  const weights = Object.fromEntries(brokerWeights(history))

  // Capped, so one broker cannot take over the board.
  assert.equal(weights['Ironwood Freight Partners'], 1 + LOYALTY_MAX_LOADS * LOYALTY_BONUS_PER_LOAD)
  assert.equal(weights['Redstone Logistics Partners'], 1 + 2 * LOYALTY_BONUS_PER_LOAD)

  // Every other broker keeps weight 1. A student must still be able to
  // meet someone new -- a board showing only the people you already know
  // teaches nothing about checking a broker's credit.
  for (const [name, w] of Object.entries(weights)) {
    if (history.has(name)) continue
    assert.equal(w, 1, name)
  }

  // And every broker is actually drawn.
  const rng = seeded(12345)
  const seen = new Set()
  for (let i = 0; i < 30000; i += 1) seen.add(generateLoad(rng, { brokerHistory: history }).broker)
  assert.equal(seen.size, Object.keys(weights).length)
})

test('no history means no favourites', () => {
  for (const [, w] of brokerWeights(undefined)) assert.equal(w, 1)
  for (const [, w] of brokerWeights(new Map())) assert.equal(w, 1)
})
