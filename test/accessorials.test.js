// A broker's terms beyond the rate (src/constants/accessorials.js): one
// set per broker, inside the sourced ranges, the same in the chat and on
// the rate confirmation.
//
// From the 2026-10-05 external run: TONU was $350 from one broker and $75
// from another, both invented by the model, neither on the paper.
//
// Every test names the mutation it kills. No database.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { brokerTerms, termsLines, DETENTION_PER_HOUR, FREE_HOURS, TONU_USD, LAYOVER_PER_DAY, TARP_PAY_USD } from '../src/constants/accessorials.js'
import { BROKERS } from '../scripts/seed/schemas.js'
import { buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'

// Kills: a typo in a range. Quoted from the two O Trucking guides
// (checked 2026-10-05): detention $50-90/hr van and reefer, $75-125/hr
// specialized; TONU $150-500; layover $75-300/day; free time 2 hours, 3
// for specialized.
test('the ranges are the sourced ones', () => {
  assert.deepEqual([...DETENTION_PER_HOUR.standard], [50, 90])
  assert.deepEqual([...DETENTION_PER_HOUR.specialized], [75, 125])
  assert.deepEqual({ ...FREE_HOURS }, { standard: 2, specialized: 3 })
  assert.deepEqual([...TONU_USD], [150, 500])
  assert.deepEqual([...LAYOVER_PER_DAY], [75, 300])
})

// Kills: a value drawn outside its range, or not rounded the way a person
// quotes money.
test('every broker\'s terms sit inside the ranges, in round numbers', () => {
  for (const name of BROKERS) {
    for (const eq of ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker', 'power-only']) {
      const t = brokerTerms(name, eq)
      const [dLo, dHi] = ['flatbed', 'step-deck'].includes(eq) ? DETENTION_PER_HOUR.specialized : DETENTION_PER_HOUR.standard
      assert.ok(t.detentionPerHour >= dLo && t.detentionPerHour <= dHi && t.detentionPerHour % 5 === 0, `${name}/${eq} detention ${t.detentionPerHour}`)
      assert.ok(t.tonuUsd >= TONU_USD[0] && t.tonuUsd <= TONU_USD[1] && t.tonuUsd % 25 === 0, `${name} TONU ${t.tonuUsd}`)
      assert.ok(t.layoverPerDay >= LAYOVER_PER_DAY[0] && t.layoverPerDay <= LAYOVER_PER_DAY[1] && t.layoverPerDay % 25 === 0)
    }
  }
})

// Kills: terms that change from load to load for one broker (the hash on
// a posting id instead of the broker), or that are the same for everyone.
test('one broker, one set of terms; different brokers, different terms', () => {
  const a = brokerTerms(BROKERS[0], 'dry-van')
  assert.deepEqual(brokerTerms(BROKERS[0], 'dry-van'), a)
  assert.deepEqual(brokerTerms(BROKERS[0], 'reefer'), a, 'van and reefer share the standard range')
  const tonus = new Set(BROKERS.map((n) => brokerTerms(n, 'dry-van').tonuUsd))
  assert.ok(tonus.size >= 4, `only ${tonus.size} distinct TONU figures across ${BROKERS.length} brokers`)
})

// Kills: specialized freight getting the van free time.
test('flatbed and step deck get the specialized free time', () => {
  assert.equal(brokerTerms(BROKERS[0], 'flatbed').freeHours, 3)
  assert.equal(brokerTerms(BROKERS[0], 'step-deck').freeHours, 3)
  assert.equal(brokerTerms(BROKERS[0], 'dry-van').freeHours, 2)
})

// Kills: the broker prompt without the terms, or with someone else's.
test('the broker is told their own terms', () => {
  const now = new Date('2026-10-05T15:00:00Z')
  const H = 3600000
  const posting = {
    id: 'p', originCity: 'Chicago', originState: 'IL', destinationCity: 'Dallas', destinationState: 'TX',
    distanceMi: 925, commodity: 'paper', weightLbs: 30000, equipmentType: 'dry-van', equipmentLengthFt: 53,
    rateHidden: false, rateUsd: 3300, postedAt: new Date(now - H), expiresAt: new Date(+now + 9 * H),
    pickupAt: new Date(+now + 30 * H), deliveryAt: new Date(+now + 50 * H),
  }
  const prompt = buildBrokerSystemPrompt({ broker: { contactName: 'R K', name: BROKERS[1], persona: 'Calm.' }, posting, now })
  assert.match(prompt, /YOUR TERMS \(the same on every load you post/)
  for (const line of termsLines(brokerTerms(BROKERS[1], 'dry-van'))) assert.ok(prompt.includes(line), line)
})

// Kills: the open-deck detention printed like the van one. In the
// 2026-10-06 scenario run a broker called its flatbed detention "same
// terms across the board" as its dry-van figure.
test('open-deck detention says it is the open-deck figure; van and reefer do not', () => {
  assert.match(termsLines(brokerTerms(BROKERS[0], 'flatbed'))[0], /^Detention \(open-deck freight\): \$\d+\/hr after 3 hours free/)
  assert.match(termsLines(brokerTerms(BROKERS[0], 'dry-van'))[0], /^Detention: \$\d+\/hr after 2 hours free/)
})

// Kills: leaving tarp pay out of the terms -- a flatbed broker quoted tarp money the paper never carried
test('a tarped load carries tarp pay inside the sourced range; untarped freight carries none', () => {
  const lines = termsLines(brokerTerms('Ironwood Freight', 'flatbed', 'Copper tubing'))
  const tarp = lines.find((l) => /^Tarp pay: \$\d+ per load \(steel tarps \(4 ft drop\)\)/.test(l))
  assert.ok(tarp, lines.join(', '))
  const usd = brokerTerms('Ironwood Freight', 'flatbed', 'Copper tubing').tarpPayUsd
  assert.ok(usd >= TARP_PAY_USD[0] && usd <= TARP_PAY_USD[1], String(usd))
  for (const [type, commodity] of [['dry-van', 'Copper tubing'], ['flatbed', 'Concrete pipe'], ['flatbed', null]]) {
    assert.ok(!termsLines(brokerTerms('Ironwood Freight', type, commodity)).some((l) => /^Tarp pay/.test(l)), `${type} ${commodity}`)
  }
})
