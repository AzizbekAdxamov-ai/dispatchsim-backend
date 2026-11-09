// Release 2026-11-10, band 8: the rate con is not prepared until the trailer,
// the driver and the truck number are known (live: paper went out with only MC).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { bookingFacts, paperPrerequisite, PAPER_ASK_LINE } from '../src/modules/brokerChat/bookingTalk.js'
import { getThread } from '../src/modules/brokerChat/brokerChat.service.js'
import { makeFakeBrokerRepo, fakePosting, FAKE_IDS } from './helpers/fakeBrokerRepo.js'

const posting = fakePosting({
  originCity: 'Columbus', originState: 'OH', destinationCity: 'Dallas', destinationState: 'TX',
  commodity: 'Copper tubing', equipmentType: 'flatbed', equipmentLengthFt: 48, rateUsd: 3500, distanceMi: 1000,
})
const carrier = { name: 'Cedar Ridge Transport', mcNumber: 'MC-741309' }
const BASE_TEXTS = ['this is Aziz with Cedar Ridge Transport, MC 741309', 'truck in Columbus, empty now']
const EMAIL = 'dispatch@cedar.example'
const agreed = { status: 'open', negotiationStage: 'awaiting_email', agreedRateUsd: 3500, brokerOfferUsd: 3500 }
const turn = (texts, text) => negotiate({
  conversation: agreed, posting, text, knownEmail: EMAIL, offerVisible: true,
  booking: bookingFacts({ texts: [...BASE_TEXTS, ...texts, text], carrier, posting }),
})

// Kills: dropping the paperPrerequisite branch -- the rate con was issued with no trailer, driver or truck number
test('paper waits for the trailer, then the driver, then the truck number, one at a time', () => {
  const first = turn([], EMAIL)
  assert.equal(first.issuePaper, false)
  assert.equal(first.line, PAPER_ASK_LINE.trailer)
  assert.equal(first.state.stage, 'awaiting_email')

  const second = turn(['48ft flatbed'], EMAIL)
  assert.equal(second.issuePaper, false)
  assert.equal(second.line, PAPER_ASK_LINE.driverName)

  const third = turn(['48ft flatbed', 'driver is Ethan'], EMAIL)
  assert.equal(third.issuePaper, false)
  assert.equal(third.line, PAPER_ASK_LINE.truckNumber)
})

// Kills: dropping the awaiting_email + talk clause -- "truck #12" with the email known never issued the paper
test('the last missing detail, said as plain talk, issues the paper', () => {
  const decision = turn(['48ft flatbed', 'driver is Ethan'], 'truck #12')
  assert.equal(decision.issuePaper, true)
  assert.equal(decision.state.stage, 'paper_pending')
})

// Kills: asking for a detail twice -- paperPrerequisite must read what was already said
test('paperPrerequisite returns null once everything is said', () => {
  const facts = bookingFacts({ texts: [...BASE_TEXTS, '48ft flatbed', 'driver is Ethan', 'truck #12'], carrier, posting })
  assert.equal(paperPrerequisite(facts), null)
})

// Kills: removing the fits check -- a dry van for a flatbed load still got paper
test('a trailer that does not fit the load still gets no paper', () => {
  const decision = turn(['53ft dry van', 'driver is Ethan', 'truck #12'], EMAIL)
  assert.equal(decision.issuePaper, false)
})

const threadWith = (keys) => {
  const fake = makeFakeBrokerRepo({ posting })
  return getThread({ conversationId: FAKE_IDS.conversation, userId: FAKE_IDS.user },
    { deps: { repo: fake.repo, fleetEquipmentKeys: async () => new Set(keys) } })
}

// Kills: dropping preSignWarnings from getThread -- the panel warned only after the booking
test('a thread warns before signing when the fleet has no truck for the load trailer', async () => {
  assert.deepEqual((await threadWith(['dry-van'])).preSignWarnings, ['no-matching-equipment'])
  assert.deepEqual((await threadWith(['dry-van', 'flatbed'])).preSignWarnings, [])
})

// Kills: replacing every plain-talk reply with the paper question ("what's the detention?" got "What's the truck number?")
test('plain talk with no new detail keeps the model reply; a new detail asks the next one', () => {
  const idle = turn(['48ft flatbed'], "what's the detention?")
  assert.equal(idle.issuePaper, false)
  assert.equal(idle.line, null)
  assert.equal(turn(['48ft flatbed'], 'ok').line, null)
  assert.equal(turn(['48ft flatbed'], 'driver is Ethan').line, PAPER_ASK_LINE.truckNumber)
})
