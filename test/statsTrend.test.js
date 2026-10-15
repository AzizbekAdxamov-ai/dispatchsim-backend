import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillDailyTrend } from '../src/modules/stats/stats.service.js'

test('on-time trend keeps days without deliveries distinct from 0% days', () => {
  // Kills: filling missing delivery days with 0 would draw a false flat failure line.
  const today = new Date().toISOString().slice(0, 10)
  const trend = fillDailyTrend([{ day: today, onTimePct: 0 }], 3, 'onTimePct', null)

  assert.equal(trend.length, 3)
  assert.deepEqual(trend.map(({ onTimePct }) => onTimePct), [null, null, 0])
})
