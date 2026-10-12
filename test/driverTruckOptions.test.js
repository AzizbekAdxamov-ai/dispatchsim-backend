// Assigning a truck from the driver's page -- the parts that need no
// database: which trucks the page offers, and what the request accepts.
//
// The assignment itself is fleet's truckListings.service.assignDriver,
// called unchanged; its rules (idle only, one truck per driver, the
// UNIQUE race) are fleet's and are not re-tested here.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { truckOptionsFromRows } from '../src/modules/drivers/drivers.service.js'
import { assignTruckSchema } from '../src/modules/drivers/drivers.schemas.js'

const row = (over) => ({
  id: 'RS-9278-CY', make: 'Freightliner', model: 'Cascadia', year: 2021,
  status: 'idle', locationCity: 'Seattle', locationState: 'WA', ...over,
})

// Kills: offering a truck the assignment will refuse. Fleet's rule is
// idle-only; a page that offered an 'active' or 'maintenance' truck as
// takeable would turn every click on it into an error message.
test('only an idle truck is assignable', () => {
  const [idle, working, shop] = truckOptionsFromRows([
    row({ id: 'A' }),
    row({ id: 'B', status: 'active' }),
    row({ id: 'C', status: 'maintenance' }),
  ])
  assert.equal(idle.assignable, true)
  assert.equal(working.assignable, false)
  assert.equal(shop.assignable, false)
})

// Kills: dropping a driverless truck from the list because it cannot be
// taken. It is still a truck, parked and unused; leaving it out would
// have the page say "no trucks" about one that is right there -- and the
// reason it cannot be taken is the useful part.
test('a truck that cannot be taken is still listed, with the reason', () => {
  const [idle, shop] = truckOptionsFromRows([row({ id: 'A' }), row({ id: 'C', status: 'maintenance' })])
  assert.equal(idle.reason, null)
  assert.equal(shop.reason, 'In the shop')
})

// Kills: a missing location shown as the string "undefined".
test('a truck with no recorded location says nothing about one', () => {
  const [t] = truckOptionsFromRows([row({ locationCity: undefined, locationState: undefined })])
  assert.equal(t.locationCity, null)
  assert.equal(t.locationState, null)
})

// Kills: a loose schema. The body carries one field; anything else is a
// client sending something this endpoint does not understand, and
// .strict() says so instead of quietly ignoring it.
test('the request takes exactly one truck id', () => {
  assert.deepEqual(assignTruckSchema.parse({ truckId: ' RS-9278-CY ' }), { truckId: 'RS-9278-CY' })
  assert.throws(() => assignTruckSchema.parse({}))
  assert.throws(() => assignTruckSchema.parse({ truckId: '' }))
  assert.throws(() => assignTruckSchema.parse({ truckId: 'RS-9278-CY', driverId: 'd1' }))
  assert.throws(() => assignTruckSchema.parse({ truckId: 'x'.repeat(33) }))
})
