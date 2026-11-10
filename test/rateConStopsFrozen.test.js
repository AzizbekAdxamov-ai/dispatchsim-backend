// The shipper and receiver names were recomputed from the name lists on every
// read, so editing a list changed a rate confirmation already sent. They are
// now stored when the paper is issued (migration 074).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getRateConfirmation } from '../src/modules/brokerChat/brokerChat.service.js'
import { stopsFor } from '../src/modules/brokerChat/stops.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const read = (file) => readFileSync(join(process.cwd(), file), 'utf8')
const posting = fakePosting()
const FROZEN = { shipper: { name: 'Frozen Co', street: '1 Old St', city: 'Dallas', state: 'TX' }, receiver: { name: 'Held Inc', street: '2 Old St', city: 'Chicago', state: 'IL' } }

function deps(rateConStops) {
  const calls = { freeze: 0 }
  const row = { id: 'c1', status: 'agreed', postingId: posting.id, originCity: 'Dallas', originState: 'TX',
    destinationCity: 'Chicago', destinationState: 'IL', equipmentType: 'dry-van', recipientEmail: null, rateConStops }
  return { calls, deps: {
    repo: {
      getConversationForPDF: async () => row,
      rateConDelivered: async () => true,
      listMessages: async () => [],
      freezeRateConStops: async (id, stops) => { calls.freeze += 1; row.rateConStops ??= stops; return row.rateConStops },
    },
    getCarrier: async () => ({ name: 'Example Freight', mcNumber: 'MC-1' }),
  } }
}

// Kills: names recomputed from the lists on every read
test('a paper with stored stops shows exactly those names', async () => {
  const { deps: d, calls } = deps(FROZEN)
  const result = await getRateConfirmation({ conversationId: 'c1', userId: 'u1' }, { deps: d })
  assert.deepEqual(result.stops, FROZEN)
  assert.equal(calls.freeze, 0)
})

// Kills: a paper issued before the column existing stays unfrozen and drifts
test('an old paper without stored stops is frozen once, with today\'s names', async () => {
  const { deps: d, calls } = deps(null)
  const first = await getRateConfirmation({ conversationId: 'c1', userId: 'u1' }, { deps: d })
  const second = await getRateConfirmation({ conversationId: 'c1', userId: 'u1' }, { deps: d })
  assert.equal(calls.freeze, 1)
  assert.deepEqual(first.stops, stopsFor(posting))
  assert.deepEqual(second.stops, first.stops)
})

// Kills: the freeze overwriting names (a re-issued paper changing them) or the clear step wiping them
test('the SQL keeps the first names and never clears them', () => {
  const repo = read('src/modules/brokerChat/brokerChat.repository.js')
  assert.match(repo, /rate_con_stops = CASE WHEN \$9 THEN COALESCE\(rate_con_stops, \$15::jsonb\) ELSE rate_con_stops END/)
  assert.match(repo, /rate_con_stops IS NULL\s+RETURNING/)
  assert.match(repo, /c\.rate_con_stops AS "rateConStops"/)
  const clear = repo.match(/export async function clearRateCon[\s\S]*?\n}\n/)[0]
  assert.ok(!clear.includes('rate_con_stops'))
})

// Kills: issuing the paper without handing its names to the store
test('issuing the paper passes the names to completeChatTurn', () => {
  assert.match(read('src/modules/brokerChat/brokerChat.service.js'), /paperStops: decision\.issuePaper \? stopsFor\(posting\) : null/)
})

// Kills: a column that allows a non-object or is missing
test('074 adds a nullable object-only rate_con_stops', () => {
  const sql = read('src/db/migrations/074_rate_con_stops.sql')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS rate_con_stops jsonb NULL/i)
  assert.match(sql, /CHECK \(rate_con_stops IS NULL OR jsonb_typeof\(rate_con_stops\) = 'object'\)/i)
})
