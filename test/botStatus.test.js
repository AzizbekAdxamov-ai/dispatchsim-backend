// /status and the one-driver /help.
//
// No database, no network, no model: the context is built by hand, in
// the shape driverChat.repository.js's getDriverContext returns.
//
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { statusText } from '../src/bot/status.js'
import { routeUpdate } from '../src/bot/router.js'
import { handleUpdate, helpText } from '../src/bot/incoming.js'
import { EMPTY } from '../src/bot/state.js'
import { situationLines } from '../src/modules/driverChat/driverChat.prompt.js'

const NOW = new Date('2026-09-30T18:00:00Z') // 1:00 PM Central

const GRACE = {
  id: 'd11', name: 'Grace Lindqvist', truckId: 'TX-4821-HX',
  dutyStatus: 'driving', currentCity: 'Amarillo', currentState: 'TX',
  // 100 of 240 is 41.67%: a value where rounding and truncating give
  // different answers (42 and 41). With 96 of 240 -- exactly 40% -- the
  // consistency test below could not tell two different calculations
  // apart, and a mutation that swapped one for the other survived it.
  hosRemainingMin: 395, fuelGallons: 100, fuelCapacityGal: 240,
}
const LATE_LOAD = {
  id: 'L-1042', originCity: 'Dallas', originState: 'TX',
  destinationCity: 'Denver', destinationState: 'CO',
  etaAt: '2026-09-30T23:30:00Z', deliveryAt: '2026-09-30T21:00:00Z',
}

// Kills: a status that drops a fact the database has, or rewords the
// place the driver is. Every line here is a column, read.
test('status shows what the dispatch system knows, line by line', () => {
  const text = statusText({ driver: GRACE, load: LATE_LOAD, now: NOW })

  assert.match(text, /Grace Lindqvist · TX-4821-HX/)
  assert.match(text, /driving — Amarillo, TX/)
  assert.match(text, /Driving time left today: 6h 35m/)
  assert.match(text, /Fuel: about 42%/)
  assert.match(text, /Load L-1042: Dallas, TX → Denver, CO/)
  assert.match(text, /2h 30m past the appointment/)
  assert.match(text, /As of 1:00 PM Central/)
})

// Kills: showing an unknown as a number. A tank with no reading is not
// an empty tank, and "Fuel: about 0%" is a fact someone would act on.
test('an unknown is left out, not shown as zero', () => {
  const text = statusText({
    driver: { ...GRACE, fuelGallons: null, hosRemainingMin: null, currentCity: null },
    load: null,
    now: NOW,
  })

  assert.doesNotMatch(text, /Fuel/)
  assert.doesNotMatch(text, /Driving time left/)
  assert.doesNotMatch(text, /Amarillo/)
  assert.match(text, /No load assigned/)
})

// Kills: a "late" line on a load that is on time. The line is two
// timestamps subtracted; when the answer is not positive there is no
// line, and certainly no negative lateness.
test('a load on time says nothing about being late', () => {
  const onTime = { ...LATE_LOAD, etaAt: '2026-09-30T20:00:00Z' }
  const text = statusText({ driver: GRACE, load: onTime, now: NOW })
  assert.doesNotMatch(text, /past the appointment/)
  assert.match(text, /ETA 3:00 PM/)
})

// Kills: two pieces of arithmetic for one number. The driver is told
// "about 40% of the tank" and "2h 30m past the appointment" by the
// prompt; /status must show the same two numbers, or the one check a
// dispatcher has on the model -- does what they say match the system?
// -- compares the model against a second, different calculation.
test('the driver is told the same numbers /status shows', () => {
  const told = situationLines({ driver: GRACE, load: LATE_LOAD, now: NOW }).join('\n')
  const shown = statusText({ driver: GRACE, load: LATE_LOAD, now: NOW })

  const fuelTold = /Fuel: about (\d+)%/.exec(told)?.[1]
  const fuelShown = /Fuel: about (\d+)%/.exec(shown)?.[1]
  assert.ok(fuelTold, 'haydovchiga yoqilg\'i aytilmadi')
  assert.equal(fuelShown, fuelTold)

  const lateTold = /That is (.+?) past the appointment/.exec(told)?.[1]
  const lateShown = /— (.+?) past the appointment/.exec(shown)?.[1]
  assert.ok(lateTold, 'haydovchiga kechikish aytilmadi')
  // The prompt says it in words ("2 hours 30 minutes"), /status on a screen
  // ("2h 30m"): same number, two spellings.
  const minutesOf = (h, m) => Number(h ?? 0) * 60 + Number(m ?? 0)
  const told2 = /^(?:(\d+) hours?)?\s?(?:(\d+) minutes?)?$/.exec(lateTold)
  const shown2 = /^(?:(\d+)h)?\s?(?:(\d+)m)?$/.exec(lateShown)
  assert.ok(told2 && shown2, 'both spellings parse')
  assert.equal(minutesOf(shown2[1], shown2[2]), minutesOf(told2[1], told2[2]))
})

// Kills: /start falling through to 'ignore'. It is the first thing
// Telegram sends when a private chat with a bot is opened or unblocked,
// and silence is a strange answer to the first press of the first button.
test('/start and /status are commands the bot answers', () => {
  assert.deepEqual(routeUpdate({ text: '/start' }), { kind: 'help' })
  assert.deepEqual(routeUpdate({ text: '/status' }), { kind: 'status' })
  assert.deepEqual(routeUpdate({ text: '/STATUS' }), { kind: 'status' })
})

function fakeApp() {
  const calls = { sendMessage: 0 }
  return {
    calls,
    app: {
      driversByName: async (name) => (name === 'Grace Lindqvist' ? [{ id: 'd11', name: 'Grace Lindqvist' }] : []),
      driversList: async () => [{ id: 'd11', name: 'Grace Lindqvist', dutyStatus: 'driving' }],
      driverById: async (id) => (id === 'd11' ? { id: 'd11', name: 'Grace Lindqvist' } : null),
      getCarrier: async () => ({ name: 'Keystone Line Haul' }),
      getDriverContext: async () => ({ driver: GRACE, load: LATE_LOAD }),
      openConversation: async () => ({ conversation: { id: 'conv-d11' } }),
      sendMessage: async () => { calls.sendMessage += 1 },
    },
  }
}

// Kills: answering /status through the model. That would cost a request
// out of a daily budget, take as long as a driver takes to stop and
// text, and -- the real harm -- put the model between the dispatcher and
// the one screen that is supposed to show what the system knows.
test('/status reads the database and never asks the driver', async () => {
  const { app, calls } = fakeApp()
  const result = await handleUpdate(
    { chatId: '6686277144', text: '/status' },
    { state: { ...EMPTY }, app, userId: 'u1', fixedDriverName: 'Grace Lindqvist' },
  )

  assert.equal(calls.sendMessage, 0, '/status modelga so\'rov yubordi')
  assert.match(result.replies.join('\n'), /Driving time left today: 6h 35m/)
})

// Kills: the general /help in a one-driver chat. It teaches /d and
// /drivers to someone who has nobody to choose between, and never says
// the one thing they need: who is on the other end.
test('with one driver, /help names the driver and does not teach /d', async () => {
  const { app } = fakeApp()
  const result = await handleUpdate(
    { chatId: '6686277144', text: '/help' },
    { state: { ...EMPTY }, app, userId: 'u1', fixedDriverName: 'Grace Lindqvist' },
  )
  const text = result.replies.join('\n')

  assert.match(text, /Keystone Line Haul/)
  assert.match(text, /talking to Grace Lindqvist · TX-4821-HX/)
  assert.match(text, /\/status/)
  assert.doesNotMatch(text, /\/d /)
  assert.doesNotMatch(text, /\/drivers/)

  // And the general help still exists for the general case.
  assert.match(helpText('Keystone Line Haul'), /\/d <name>/)
})
