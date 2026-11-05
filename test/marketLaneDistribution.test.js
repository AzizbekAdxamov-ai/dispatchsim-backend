import test from 'node:test'
import assert from 'node:assert/strict'
import { LANES, FREIGHT_HUB_ORIGINS, pickMarketLane } from '../scripts/seed/generate.js'

// Kills: reverting national lane selection to a uniform lane draw. Hubs
// should appear more often than their share of the underlying lane pool.
test('national postings favor represented freight hubs without excluding other cities', () => {
  const isHub = (lane) => FREIGHT_HUB_ORIGINS.has(`${lane.origin.city}, ${lane.origin.state}`)
  const baseShare = LANES.filter(isHub).length / LANES.length
  const samples = Array.from({ length: 10000 }, (_, i) => pickMarketLane(() => (i + 0.5) / 10000))
  const hubShare = samples.filter(isHub).length / samples.length
  assert.ok(hubShare > baseShare + 0.05)
  assert.ok(samples.some((lane) => !isHub(lane)))
  assert.ok(new Set(samples.map((lane) => lane.origin.state)).size > 35)
})
