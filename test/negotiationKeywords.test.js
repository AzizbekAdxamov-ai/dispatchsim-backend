import test from 'node:test'
import assert from 'node:assert/strict'
import { chatIntent, negotiate } from '../src/modules/brokerChat/negotiation.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const groups = {
  A: [['What is the best you can do on this load?', 'ask_room'], ['how much room u got on the rate', 'ask_room'], ['can u check with customer', 'ask_room']],
  B: [['Can you come up on the rate?', 'push'], ['that rate is too light for this lane', 'push'], ["we're not gonna move it for that", 'push']],
  C: [['If you can do $3600, I will book it now', 'accept_amount'], ['i can cover it right now at 3.6k', 'accept_amount'], ['if u can do 3600 ill take it now', 'accept_amount']],
  D: [['We have a truck empty nearby', 'push'], ['my truck is already in position', 'push'], ['we can be at pickup on time', 'push']],
  E: [['This is a clean truck with a reliable driver', 'push'], ['we provide strong communication and tracking', 'push'], ['clean truck, solid driver', 'push']],
  F: [['I am seeing this lane around $3.60', 'push'], ['market is stronger today on this lane', 'push'], ['limited capacity in that area, need more', 'push']],
  G: [['reloads out of there are weak, need more going in', 'push'], ['that delivery area is tough for reloads', 'push'], ['reload is weak so u gotta bump it', 'push']],
  H: [['there is a lot of deadhead on this one', 'push'], ['with the deadhead i need $3600', 'offer'], ['what is total mileage including deadhead', 'question']],
  I: [['appointment times are tight, need to price that in', 'push'], ['is this FCFS or strict appointment', 'question'], ['what are pickup and delivery appointments', 'question']],
  J: [['Is detention paid?', 'terms'], ['any lumper?', 'terms'], ['any extra stops?', 'terms']],
  K: [['what is the commodity and weight?', 'commodity'], ['can you do $3600 on linehaul plus FSC', 'offer'], ['commodity and lbs?', 'commodity']],
  L: [['can you please add $100?', 'push'], ['we really need more money', 'push'], ['pls add a hundred, we need it', 'push']],
}

for (const [group, cases] of Object.entries(groups)) {
  for (const [text, expected] of cases) {
    test(`${group}: ${text}`, () => {
      // Kills: removing this group's classifier must fail its canonical and street forms.
      assert.equal(chatIntent(text).kind, expected)
    })
  }
}

test('book-it accepts natural variants and rejects conditions', () => {
  // Kills: the old anchored ACCEPT regex loop for apostrophe-free booking.
  for (const text of ['ok lets book it', 'the rate works we can book it', 'its fine', 'send the rc', 'confirmed']) {
    assert.equal(chatIntent(text).kind, 'accept', text)
  }
  assert.notEqual(chatIntent('if the rate works, lets book it').kind, 'accept')
})

test('apostrophes and complete booking phrases preserve acceptance', () => {
  // Kills: removing the optional apostrophe or combined booking phrase.
  for (const text of ["let's book it", 'lets book it', "let's do it", 'lets do it', "that's fine", 'thats fine', 'that works', 'sounds good, book it']) assert.equal(chatIntent(text).kind, 'accept', text)
  for (const text of ['if it works, book it', 'not yet', "don't book"]) assert.notEqual(chatIntent(text).kind, 'accept', text)
})

test('per-mile amounts cannot become load offers', () => {
  // Kills: removing the per-mile guard and treating the comparison as a total.
  for (const text of ["I'm seeing this lane around $2.40", '2.4/mi works', 'can you do $2.40 a mile']) assert.ok(!['offer', 'accept_amount'].includes(chatIntent(text).kind), text)
})

test('market comparison does not hide a separate all-in offer', () => {
  // Kills: returning immediately after recognizing the per-mile comparison.
  const result = chatIntent('market is $2.40 a mile, can you do $4000 all-in?')
  assert.equal(result.kind, 'offer')
  assert.equal(result.rateUsd, 4000)
})

test('per-mile comparison leaves a separate conditional total intact', () => {
  // Kills: applying a per-mile veto to the entire message.
  const result = chatIntent('market is $2.40/mi; if you can do $3600.00, I will book it now')
  assert.equal(result.kind, 'accept_amount')
  assert.equal(result.rateUsd, 3600)
})

test('a decimal all-in total is retained', () => {
  // Kills: masking every decimal as a per-mile amount.
  const result = chatIntent('can you do $3600.00 all-in?')
  assert.equal(result.kind, 'offer')
  assert.equal(result.rateUsd, 3600)
})

test('a room counter marks the changed offer for persistence', () => {
  // Kills: dropping the changed flag after moving the broker offer.
  const posting = fakePosting({ rateUsd: 3000, distanceMi: 1000 })
  const result = negotiate({ posting, conversation: {}, text: 'how much room do you have on the rate?' })
  assert.ok(result.state.offer > posting.rateUsd)
  assert.equal(result.changed, true)
})
