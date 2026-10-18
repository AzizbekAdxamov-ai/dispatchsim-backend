// The booking call, end to end through the real service with an in-memory
// repo: agree -> rate confirmation -> accept. No database, no tokens.
//
// The S9 lines are the ones scripts/chat-scenarios.js types in. What the
// broker SAYS is a model's job and is checked elsewhere; what these tests
// pin is what the program DOES with the dispatcher's words: no agreement
// and no paper until the MC checks out, and a paper that names both sides.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agreeRate, acceptRateCon, getRateConfirmation } from '../src/modules/brokerChat/brokerChat.service.js'
import { rateConInput } from '../src/modules/brokerChat/rateConInput.js'
import { generateRateConfirmation } from '../src/modules/brokerChat/rateConfirmation.js'
import { stopsForRow } from '../src/modules/brokerChat/stops.js'
import { s9Mc, s9WrongMc, s9Email, s9Ask } from '../scripts/scenarioChecks.js'
import { pdfText } from './helpers/pdfText.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const CARRIER = {
  name: 'Cedar Ridge Transport Services', mcNumber: 'MC-741309', dotNumber: '3456789',
  phone: '(555) 010-0199', addressLine: '100 Main St', city: 'Dallas', state: 'TX', postalCode: '75201',
}

const posting = fakePosting()
const intro = `hey this is Aziz with ${CARRIER.name}, calling about your Dallas-Chicago load, still available?`
const truckLine = "truck's in Dallas, empty tomorrow 6am, 53 dry van"
const ask = s9Ask(posting)
const price = `what do you need on it? can you do $${ask}?`
const middle = 'meet me in the middle?'
const bookIt = `ok book it. driver Grace Lindqvist, truck RS-9278-CY, send the rc to ${s9Email(CARRIER)}`

function setup(lines) {
  const fake = makeFakeBrokerRepo({ posting, lines })
  const booked = []
  const deps = {
    repo: fake.repo,
    getCarrier: async () => CARRIER,
    bookPosting: async (args) => {
      booked.push(args)
      return { load: { id: 'load-1' }, warnings: [] }
    },
  }
  const ids = { conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user }
  return { fake, deps, booked, ids }
}

const agreeAt = (t, rateUsd = ask) => agreeRate({ ...t.ids, rateUsd }, { deps: t.deps })

async function rejection(promise) {
  try { await promise } catch (e) { return e }
  assert.fail('expected a rejection')
}

// Kills: a booking let through with no MC said at all
test('S9c: no MC said, no agreement and no paper', async () => {
  const t = setup([intro, truckLine, price, middle, 'just book it'])
  const err = await rejection(agreeAt(t))
  assert.equal(err.code, 'CARRIER_NOT_VERIFIED')
  assert.equal(err.details.reason, 'mc-missing')
  assert.ok(err.details.message.startsWith('Devin:'))
  assert.equal(t.fake.state.conversation.status, 'open')
  assert.ok(!t.fake.state.messages.some((m) => m.kind === 'rate_con'))
  assert.equal(t.booked.length, 0)
})

// Kills: a wrong MC accepted, at agree time or at accept time
test('S9b: wrong MC is turned away at agree, and again at accept', async () => {
  const t = setup([intro, `MC ${s9WrongMc(CARRIER)}`, truckLine, price, middle, bookIt])
  const err = await rejection(agreeAt(t))
  assert.equal(err.code, 'CARRIER_NOT_VERIFIED')
  assert.equal(err.details.reason, 'mc-mismatch')
  assert.equal(t.fake.state.conversation.status, 'open')

  // Paper that somehow exists anyway still cannot be signed.
  t.fake.forceAgreed(ask)
  const err2 = await rejection(acceptRateCon(t.ids, { deps: t.deps }))
  assert.equal(err2.code, 'CARRIER_NOT_VERIFIED')
  assert.equal(err2.details.reason, 'mc-mismatch')
  assert.equal(t.booked.length, 0)
  assert.equal(t.fake.state.conversation.status, 'agreed')
})

// Kills: the right-MC path broken anywhere between handshake and signature,
// or a paper that leaves out a side of the deal
test('S9a: right MC agrees, the paper names everyone, accept books', async () => {
  const t = setup([intro, `MC ${s9Mc(CARRIER)}`, truckLine, price, middle, bookIt])
  const agreed = await agreeAt(t)
  assert.equal(agreed.status, 'agreed')
  assert.equal(agreed.awaitingReply, true)
  assert.ok(t.fake.state.messages.some((m) => m.kind === 'rate_con'))

  const data = await getRateConfirmation(t.ids, { deps: t.deps })
  const text = pdfText(await generateRateConfirmation(rateConInput(data, CARRIER)))
  const { shipper, receiver } = stopsForRow(data)
  for (const want of [
    CARRIER.name, CARRIER.mcNumber, 'Grace Lindqvist', 'RS-9278-CY', s9Email(CARRIER),
    shipper.name, shipper.street, `${shipper.city}, ${shipper.state}`,
    receiver.name, receiver.street, `${receiver.city}, ${receiver.state}`,
  ]) {
    assert.ok(text.includes(want), `paper is missing "${want}"`)
  }

  const out = await acceptRateCon(t.ids, { deps: t.deps })
  assert.deepEqual(t.booked, [{ postingId: posting.id, userId: FAKE_IDS.user, driverId: null }])
  assert.equal(out.conversation.status, 'booked')
  assert.equal(out.alreadyAccepted, false)
})

// Kills: the MC gate answering before the rate band, hiding a bad number
test('an out-of-band rate is refused before the MC gate', async () => {
  const t = setup([intro, 'just book it'])
  const err = await rejection(agreeAt(t, posting.distanceMi * 5 + 1))
  assert.equal(err.code, 'RATE_OUT_OF_BAND')
})
