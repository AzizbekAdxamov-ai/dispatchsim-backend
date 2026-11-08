// Band 5 (X10 blank bubble, X11 one driver location, X12 board count).
// Pure: no provider, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { whereNow, withLivePlace } from '../src/modules/driverChat/livePlace.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { driverReplyProblem } from '../src/modules/driverChat/replyProblem.js'
import { FALLBACK_REPLY } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { sendMessage } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'
import { buildListPostingsSql, buildCountPostingsSql } from '../src/modules/loadBoard/loadBoard.repository.js'

const HOUR_MS = 3_600_000
const NOW = new Date('2026-11-08T12:00:00Z')
const HOME = { homeBaseCity: 'Seattle', homeBaseState: 'WA' }
const PARKED = { ...HOME, currentCity: 'New York', currentState: 'NY' }
const RUN = {
  originCity: 'Dallas', originState: 'TX', destinationCity: 'Atlanta', destinationState: 'GA',
  dispatchedAt: new Date(+NOW - 2 * HOUR_MS), etaAt: new Date(+NOW + 2 * HOUR_MS), distanceMi: 800,
}

// Kills: the Drivers page naming home base while the map names where the truck is.
test('whereNow prefers the parked city over home base', () => {
  const here = whereNow(PARKED, null, NOW)
  assert.deepEqual([here.city, here.state, here.onTheRoad], ['New York', 'NY', false])
})

// Kills: a driver with no parked city shown nowhere.
test('whereNow falls back to home base when nothing else is known', () => {
  const here = whereNow(HOME, null, NOW)
  assert.deepEqual([here.city, here.state], ['Seattle', 'WA'])
  assert.equal(whereNow({}, null, NOW), null)
})

// Kills: a driver on a run still named where they were parked.
test('whereNow puts a driver on a run on the lane, not at the parked city', () => {
  const here = whereNow(PARKED, RUN, NOW)
  assert.equal(here.onTheRoad, true)
  assert.notEqual(here.city, 'New York')
})

// Kills: whereNow ignoring the open road event (a truck on the shoulder named further on).
test('whereNow puts a stopped truck at the event place', () => {
  const here = whereNow(PARKED, { ...RUN, openEvent: { eventType: 'accident', place: 'Tucumcari, NM' } }, NOW)
  assert.deepEqual([here.city, here.state, here.stopped], ['Tucumcari', 'NM', true])
})

// Kills: the chat context and the list disagreeing about the same driver.
test('withLivePlace and whereNow name the same place', () => {
  const ctx = withLivePlace({ driver: PARKED, load: RUN }, NOW).driver
  const here = whereNow(PARKED, RUN, NOW)
  assert.deepEqual([ctx.currentCity, ctx.currentState], [here.city, here.state])
})

// Kills: a blank reply passing the check (saved as an empty bubble).
test('a blank reply is unusable for both chats', () => {
  for (const blank of ['', '   ', null]) {
    assert.equal(brokerReplyProblem(blank)?.unusable, true)
    assert.equal(driverReplyProblem(blank, { text: 'hi' })?.unusable, true)
  }
})

// Kills: saving '' when the model returns whitespace only.
test('a blank model reply is regenerated once, then replaced with the fallback line', async () => {
  const posting = fakePosting({ contactName: 'Devin Hart' })
  const fake = makeFakeBrokerRepo({ posting })
  let calls = 0
  const deps = {
    repo: fake.repo, getCarrier: async () => ({ name: 'Keystone Line Haul', mcNumber: 'MC-741309', email: null }),
    findById: async () => null, assertCanSend: async () => {}, chatConfigFor: () => ({ model: 'fake' }),
    logTurn: async () => {}, chatText: async () => { calls += 1; return '   ' },
  }
  await sendMessage({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user, text: 'hello there' }, { deps })
  fake.deliverAll()
  const last = fake.state.messages.filter((m) => m.role === 'broker').at(-1)
  assert.equal(calls, 2, 'one regeneration, then the fallback')
  assert.equal(last.content, FALLBACK_REPLY)
})

// Kills: the board count drifting from the rows (list and count filtering differently).
test('list and count apply the same filters, differing only by the radius', () => {
  const filters = { sort: 'posted', limit: 50, offset: 0, equipmentType: ['dry-van'], originState: 'TX', maxDeadheadMi: 300 }
  const list = buildListPostingsSql(filters).text
  const count = buildCountPostingsSql(filters).text
  for (const clause of ['p.equipment_type = ANY(', 'p.origin_state = ']) {
    assert.ok(list.includes(clause) && count.includes(clause), `both queries must apply ${clause}`)
  }
  assert.ok(list.includes('n.deadhead_mi <= ') && count.includes('FILTER (WHERE'))
  assert.equal(FALLBACK_REPLY.trim() === '', false)
})
