import test from 'node:test'
import assert from 'node:assert/strict'
import { blockUntil, cancellationIntent, cancellationResponse, shouldBlock } from '../src/modules/brokerChat/blockPolicy.js'

test('explicit cancellation blocks only an agreed or booked load', () => {
  assert.equal(cancellationIntent("truck broke down, can't cover").kind, 'cancel')
  assert.equal(shouldBlock({ status: 'booked', cancellationText: 'release it' }), true)
  assert.equal(shouldBlock({ status: 'open', cancellationText: 'release it' }), false)
})

test('wait with no ETA returns the load without a block', () => {
  assert.equal(cancellationIntent('truck is not working, can you wait?').kind, 'wait')
  assert.match(cancellationResponse({ noEta: true }), /another truck/i)
  assert.equal(shouldBlock({ status: 'booked', cancellationText: 'no ETA' }), false)
})

test('block duration uses the named default', () => {
  const start = new Date('2026-11-04T00:00:00Z')
  assert.equal(blockUntil(start).toISOString(), '2026-11-11T00:00:00.000Z')
})
