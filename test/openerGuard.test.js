import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixOpener, BANNED_OPENERS, OPENER_LEADS } from '../src/modules/brokerChat/openerGuard.js'
import { openerRegister } from '../src/modules/brokerChat/brokerStyle.js'
import { introductionReply, greetingLead } from '../src/modules/brokerChat/turnTalk.js'
import { figuresOf, REPEAT_LEADS } from '../src/modules/brokerChat/repeatGuard.js'
import { buildBrokerContext } from '../src/modules/brokerChat/brokerContext.js'
import { brokerReplyProblem } from '../src/modules/brokerChat/replyProblem.js'
import { negotiate } from '../src/modules/brokerChat/negotiation.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { fakePosting } from './helpers/fakeBrokerRepo.js'

const KEY = 'broker-1:conv-1:0'
const firstWord = (text) => text.match(/[a-z0-9']+/i)[0].toLowerCase()
const TIERS = Object.freeze(['A', 'B', 'C', 'D'])
const STYLES = Object.freeze(['casual', 'neutral', 'formal', null])
const KEY_SAMPLES = 12
const WIDE_SAMPLES = 40

test('openerRegister: A and B are formal, C, D and unknown are short', () => {
  for (const tier of ['A', 'B', 'a']) assert.equal(openerRegister(tier), 'formal', tier)
  // Kills: swapping the tiers (C/D formal, A/B short)
  for (const tier of ['C', 'D', null, undefined, '']) assert.equal(openerRegister(tier), 'short', String(tier))
})

test('a reply never starts with a banned casual word, whatever tier', () => {
  for (const word of BANNED_OPENERS) {
    for (const tier of TIERS) {
      const out = fixOpener(`${word[0].toUpperCase()}${word.slice(1)}, we can do $3,750 all-in.`, { creditRating: tier, key: KEY })
      assert.ok(!BANNED_OPENERS.includes(firstWord(out)), `${word}/${tier}: ${out}`)
    }
  }
  // Kills: dropping one banned word from BANNED_OPENERS ("yeah" or "yup" left through)
  assert.equal(fixOpener('Yeah, that works.', { key: KEY }), 'That works.')
  assert.equal(fixOpener('yup. same here', { key: KEY }), 'same here')
})

test('stripping "hey" keeps the figure, the question and the capitalisation of the rest', () => {
  assert.equal(fixOpener('Hey, can you do $3,750 all-in?', { key: KEY }), 'Can you do $3,750 all-in?')
  assert.equal(fixOpener('hey there! i can do $3,750 all-in, we good to book?', { key: KEY }), 'i can do $3,750 all-in, we good to book?')
  // Kills: stripping to the end of the sentence instead of only the opening word
  assert.deepEqual(figuresOf(fixOpener('Hey, our quote is $3,750 all-in. Yep, that is it.', { key: KEY })), [3750])
  // Kills: removing a banned word that is not the first word, or only a prefix of a longer word
  assert.equal(fixOpener('Heyward is the receiver. Hey is not stripped here.', { key: KEY }), 'Heyward is the receiver. Hey is not stripped here.')
  assert.equal(fixOpener('Sure, hey works too.', { key: KEY }), 'Sure, hey works too.')
})

test('a reply that was only a banned word becomes a plain acknowledgment in the tier register', () => {
  for (const [tier, register] of [['A', 'formal'], ['B', 'formal'], ['C', 'short'], ['D', 'short']]) {
    const out = fixOpener('Yep.', { creditRating: tier, key: KEY })
    // Kills: formal and short lead lists swapped, or an empty reply left behind
    assert.ok(OPENER_LEADS[register].includes(out), `${tier}: ${out}`)
  }
})

test('two broker messages in a row never start with the same word', () => {
  const said = ['I can do $3,750 all-in.']
  for (const tier of TIERS) {
    const out = fixOpener('I can do $3,825 all-in.', { brokerSaid: said, creditRating: tier, key: KEY })
    assert.notEqual(firstWord(out), 'i', `${tier}: ${out}`)
    assert.deepEqual(figuresOf(out), [3825], `${tier}: figure survives`)
    assert.ok(out.endsWith('I can do $3,825 all-in.'), 'the body is untouched')
    assert.ok(OPENER_LEADS[openerRegister(tier)].some((lead) => out.startsWith(`${lead} `)), `${tier}: lead is from the tier register`)
  }
  // Kills: comparing against the first broker message instead of the last one
  assert.equal(fixOpener('I can do $3,825 all-in.', { brokerSaid: ['I can do $3,750 all-in.', 'Ok, noted.'], key: KEY }), 'I can do $3,825 all-in.')
  // Kills: no dedupe when the first words differ in case only
  assert.notEqual(firstWord(fixOpener('OUR quote is $3,825.', { brokerSaid: ['our quote is $3,750.'], key: KEY })), 'our')
})

test('the lead-in never starts with the word it is there to avoid', () => {
  // Every lead of the short register collides with the previous first word in turn.
  for (const lead of OPENER_LEADS.short) {
    const word = firstWord(lead)
    const out = fixOpener(`${word} we can do it.`, { brokerSaid: [`${word} noted.`], creditRating: 'C', key: KEY })
    // Kills: choosing the lead without excluding the first word it would repeat
    assert.notEqual(firstWord(out), word, out)
  }
})

test('a "Like I said" lead and a greeting are allowed to repeat', () => {
  for (const lead of REPEAT_LEADS) {
    const line = `${lead}i can do $3,750 all-in.`
    // Kills: no exemption for the repeat leads (it would stack "Ok. Like I said, ...")
    assert.equal(fixOpener(line, { brokerSaid: [line], creditRating: 'A', key: KEY }), line)
  }
  // Kills: no exemption for a greeting answered with a greeting
  assert.equal(fixOpener('Hi, good to hear from you.', { brokerSaid: ['Hi there!'], key: KEY }), 'Hi, good to hear from you.')
})

test("the server's own line keeps its wording: only a banned opener goes, no lead-in is added", () => {
  const line = 'I can offer $8,678 all-in.'
  // Kills: ignoring fixedWording (a lead-in in front of a server quote)
  assert.equal(fixOpener(line, { brokerSaid: [line], creditRating: 'A', key: KEY, fixedWording: true }), line)
  // Kills: fixedWording also skipping the banned-opener strip
  assert.equal(fixOpener('Hey, I can offer $8,678 all-in.', { key: KEY, fixedWording: true }), 'I can offer $8,678 all-in.')
})

test('no greeting wording the broker can pick starts with a banned word', () => {
  for (const style of STYLES) for (const creditRating of [...TIERS, null]) for (const howAreYou of [true, false]) {
    for (let index = 0; index < KEY_SAMPLES; index += 1) {
      const key = `k${index}`
      for (const text of [introductionReply({ style, key, howAreYou, creditRating }), greetingLead({ style, key, creditRating })]) {
        // Kills: a "hey" variant left in GREETING_VARIANTS, GREETING_LEADS or DEFAULT_GREETING
        assert.ok(!BANNED_OPENERS.includes(firstWord(text)), `${style}/${creditRating}/${key}: ${text}`)
      }
    }
  }
})

test('an A or B broker greets in the formal register, C and D keep their own style', () => {
  const sample = (creditRating) => new Set(Array.from({ length: WIDE_SAMPLES }, (_, n) => introductionReply({ style: 'casual', key: `k${n}`, creditRating })))
  // Kills: creditRating ignored in introductionReply (a casual broker rated A still says "u")
  assert.ok([...sample('A')].every((reply) => !/\bu\b/.test(reply)), [...sample('A')].join(' | '))
  assert.ok([...sample('D')].some((reply) => /\bu\b/.test(reply)), 'a D broker keeps the casual wording')
})

test('a reply that skipped the greeting is repaired without "Hey"', () => {
  const posting = fakePosting({ creditRating: 'A' })
  const text = 'hey, is the Columbus load still open?'
  const negotiation = { style: 'neutral', voiceKey: KEY, state: {} }
  const problem = brokerReplyProblem('Yes, it is open.', { posting, text, negotiation })
  // Kills: greetingLead in replyProblem still hardcoding "Hey!"
  assert.ok(problem?.safeReply, 'a repair is offered')
  assert.ok(!BANNED_OPENERS.includes(firstWord(problem.safeReply)), problem.safeReply)
})

test('the prompt tells the model the opener rule: tier A/B courteous, C/D short', () => {
  const now = new Date('2026-10-20T14:00:00Z')
  const carrier = { name: 'Keystone Line Haul', mcNumber: 'MC-741309' }
  const text = 'can you do 3700?'
  const prompts = Object.fromEntries(TIERS.map((tier) => {
    const posting = fakePosting({ creditRating: tier, rateUsd: 3600, distanceMi: 1000, pickupAt: '2026-10-22T11:31:00Z', deliveryAt: '2026-10-26T12:35:00Z' })
    const booking = bookingFacts({ texts: [text], carrier, posting, now })
    const negotiation = negotiate({ conversation: { ratePushCount: 0 }, posting, text, booking, now, offerVisible: true })
    const thread = [{ role: 'dispatcher', content: text }]
    return [tier, buildBrokerContext({ broker: { name: 'Harbor Line', contactName: 'Dana', persona: '' }, posting, carrier, now, thread, booking, negotiation }).systemPrompt]
  }))
  for (const tier of TIERS) assert.match(prompts[tier], /Never open with "hey" or "yep"\. Do not start with the same word as your last reply\./, tier)
  // Kills: both tiers getting the same register line
  for (const tier of ['A', 'B']) assert.match(prompts[tier], /courteous, complete sentences/, tier)
  for (const tier of ['C', 'D']) assert.match(prompts[tier], /Keep it short and to the point/, tier)
})

test('the formal and short lead-ins are different wording', () => {
  // Kills: both registers sharing one lead list (A/B no more formal than C/D)
  assert.deepEqual(OPENER_LEADS.formal.filter((lead) => OPENER_LEADS.short.includes(lead)), [])
})
