// Brokers that do not all sound like one broker.
//
// Azizbek, 2026-09-30: "every new broker chat gives the same answer,
// like a template". Two causes, both fixed and both pinned here: the
// prompt handed every broker the same list of questions to walk in the
// same order, and each broker's character was one sentence -- two of
// which contradicted the prompt's own rules.
//
// Each test names the mutation it kills. No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildBrokerSystemPrompt, loadSituation, callerBlock } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { bookingFacts } from '../src/modules/brokerChat/bookingTalk.js'
import { CITIES } from '../scripts/seed/cities.js'

const CITY_NAMES = CITIES.map((c) => c.city ?? c.name).filter(Boolean)

const here = dirname(fileURLToPath(import.meta.url))
const migration = (name) => readFileSync(join(here, '..', 'src', 'db', 'migrations', name), 'utf8')

const NOW = new Date('2026-09-30T13:53:00Z')
const HOUR = 3600000
const BROKER = { contactName: 'Renata Kovac', name: 'Ironwood Freight Partners', persona: 'Blunt and fast.' }
const posting = (over = {}) => ({
  id: 'p-1', originCity: 'Dover', originState: 'DE', destinationCity: 'Peoria', destinationState: 'IL',
  distanceMi: 887, commodity: 'paper goods', weightLbs: 38000, equipmentType: 'Dry Van', equipmentLengthFt: 53,
  rateHidden: false, rateUsd: 2244,
  postedAt: new Date(NOW.getTime() - 3 * HOUR),
  expiresAt: new Date(NOW.getTime() + 30 * HOUR),
  pickupAt: new Date(NOW.getTime() + 40 * HOUR),
  deliveryAt: new Date(NOW.getTime() + 60 * HOUR),
  ...over,
})

// -- the situation: different loads, different conversations ---------------

// Kills: a situation block that ignores the timestamps. The same broker
// on a load posted twenty minutes ago and on one that has sat for two
// days must not be told the same thing.
test('a fresh load and a stale one are different situations', () => {
  const fresh = loadSituation({ posting: posting({ postedAt: new Date(NOW.getTime() - 20 * 60000) }), now: NOW }).join('\n')
  const stale = loadSituation({ posting: posting({ postedAt: new Date(NOW.getTime() - 50 * HOUR) }), now: NOW }).join('\n')

  assert.match(fresh, /on the board for 20 minutes/)
  assert.match(fresh, /just went up/)
  assert.match(stale, /on the board for 2 days/)
  assert.match(stale, /been sitting/)
  assert.notEqual(fresh, stale)
})

// Kills: dropping the pickup pressure. A load that picks up in five hours
// is a broker who needs a truck now; that is what changes a negotiation.
test('a close pickup changes what the broker cares about', () => {
  const soon = loadSituation({ posting: posting({ pickupAt: new Date(NOW.getTime() + 5 * HOUR), expiresAt: new Date(NOW.getTime() + 4 * HOUR) }), now: NOW }).join('\n')
  const later = loadSituation({ posting: posting(), now: NOW }).join('\n')
  assert.match(soon, /picks up in 5 hours/)
  assert.match(soon, /pickup is close/)
  assert.doesNotMatch(later, /pickup is close/)
})

// Kills: guessing when a timestamp is missing. No posted_at, no line --
// an invented "on the board for 0 minutes" is a fact nobody recorded.
test('a missing timestamp leaves its line out', () => {
  const lines = loadSituation({ posting: posting({ postedAt: null, pickupAt: null, expiresAt: null }), now: NOW })
  assert.deepEqual(lines, [])
})

// -- the prompt: character first, no checklist -----------------------------

// Kills: putting the checklist back. It was the template: five topics in
// one sentence, asked top to bottom on every call.
test('the prompt no longer hands the broker a list to walk', () => {
  const prompt = buildBrokerSystemPrompt({ broker: BROKER, posting: posting(), now: NOW })
  assert.doesNotMatch(prompt, /then ask your own\s+question\. Ask only about things a dispatcher can answer from their own\s+board: what trailer/)
  assert.match(prompt, /ask ONE thing/)
  assert.match(prompt, /Never ask something they have already told you/)
  assert.match(prompt, /Two brokers should never\s+sound alike/)
})

// Kills: building the situation and never putting it in the prompt.
test('the situation reaches the prompt', () => {
  const prompt = buildBrokerSystemPrompt({ broker: BROKER, posting: posting(), now: NOW })
  assert.match(prompt, /WHERE THIS LOAD STANDS:/)
  assert.match(prompt, /on the board for 3 hours/)
})

// -- the voices ------------------------------------------------------------

const NAMES_013 = [...migration('013_brokers.sql').matchAll(/\('([^']+)', 'MC-\d+'/g)].map((m) => m[1])
const PERSONAS_052 = [...migration('052_broker_voices.sql').matchAll(/UPDATE brokers SET persona = '((?:[^']|'')+)'\s+WHERE name = '([^']+)'/g)]
  .map((m) => ({ persona: m[1].replaceAll("''", "'"), name: m[2] }))

// Kills: a broker left with the one-line 013 voice. Twelve brokers, twelve
// voices -- one missed is one broker still sounding like the template.
test('every broker from 013 gets a voice in 052', () => {
  assert.equal(NAMES_013.length, 12, `013 dan ${NAMES_013.length} ta broker o'qildi`)
  const voiced = new Set(PERSONAS_052.map((p) => p.name))
  const missing = NAMES_013.filter((n) => !voiced.has(n))
  assert.deepEqual(missing, [], `ovozi yo'q brokerlar: ${missing.join(', ')}`)
})

// Kills: a voice that orders what the prompt forbids. Marcus "asks for
// paperwork up front" and Thomas asked about insurance; given two orders
// that cannot both be obeyed, the model obeyed neither.
test('no voice asks for what the prompt forbids', () => {
  // The words themselves, not a phrasing of them: 013's Thomas never
  // said "asks for insurance", he "slips in questions about ... insurance".
  const forbidden = /paperwork|insurance|W-9|MC number|authority/i
  const offending = PERSONAS_052.filter((p) => forbidden.test(p.persona)).map((p) => p.name)
  assert.deepEqual(offending, [], `promptga zid personalar: ${offending.join(', ')}`)
})

// Kills: a voice that states a fact. A rate, a lane or a date in a
// persona is a second copy of something the posting owns.
test('a voice is character, not facts', () => {
  // Money, distances and durations -- and places and equipment: a voice
  // that says "Dover" or "53-foot" hands the model a lane it will repeat
  // on a load out of Houston.
  const place = new RegExp(`\\b(${[...new Set(CITY_NAMES)].join('|')})\\b`)
  const facty = PERSONAS_052
    .filter((p) => /\$\d|\d+ ?(mi|miles|days|%)\b|\d+-?foot|dry van|reefer|flatbed/i.test(p.persona) || place.test(p.persona))
    .map((p) => p.name)
  assert.deepEqual(facty, [], `personada fakt bor: ${facty.join(', ')}`)
})

// Kills: two brokers with the same voice.
test('no two brokers share a voice', () => {
  const seen = new Set(PERSONAS_052.map((p) => p.persona))
  assert.equal(seen.size, PERSONAS_052.length)
})

// Kills: a broker that is told who is calling before they say (so it never
// asks), or that is not told to stop sending the dispatcher back to their own
// side (live 2026-10-13), with or without a known carrier.
test('the prompt says the counterpart is the dispatcher, forbids sending them back, and never prints the carrier before it is told', () => {
  const carrier = { name: 'Keystone Line Haul', mcNumber: 'MC-741309' }
  const withCarrier = buildBrokerSystemPrompt({ broker: BROKER, posting: posting(), now: NOW, carrier })
  const without = buildBrokerSystemPrompt({ broker: BROKER, posting: posting(), now: NOW })
  for (const p of [withCarrier, without]) {
    assert.match(p, /talking to a carrier's dispatcher\. You do not know who they are/)
    assert.match(p, /IS the carrier's dispatcher/)
    assert.match(p, /Never send\s+them back to their own side/)
    assert.match(p, /never tell them to go ask the shipper/)
  }
  assert.doesNotMatch(withCarrier, /Keystone Line Haul|741309/)
})

// Kills: the old "NEVER ask for their MC number" rule surviving, or the
// booking-call rules (W-9 never asked, payment days are accounting's, bot
// answered with a plain no) being dropped from the prompt.
test('the prompt asks for company and MC once, never for paperwork, and carries the new rules', () => {
  const p = buildBrokerSystemPrompt({ broker: BROKER, posting: posting(), now: NOW })
  assert.doesNotMatch(p, /NEVER ask for their MC/)
  assert.match(p, /you need their company and MC/)
  assert.match(p, /Never ask for a W-9/)
  assert.match(p, /that's our accounting/)
  assert.match(p, /say no plainly/)
})

const CALLER_CARRIER = { name: 'Keystone Line Haul', mcNumber: 'MC-741309' }
const callerLines = (texts, carrier = CALLER_CARRIER) =>
  callerBlock(bookingFacts({ texts, carrier, posting: posting(), now: NOW }), carrier, { towardBooking: true }).join(String.fromCharCode(10))

// Kills: a right MC not said to check out, or a wrong MC allowed to pass
test('callerBlock: matching MC checks out; a wrong one is told plainly and blocks booking', () => {
  assert.match(callerLines(['MC 741309']), /MC checks out: it comes up as Keystone Line Haul/)
  const wrong = callerLines(['MC 999999'])
  assert.match(wrong, /does not come up \/ does not match/)
  assert.match(wrong, /no booking and no rate con until they give the right one/)
  assert.doesNotMatch(wrong, /MC checks out: it comes up/)
  assert.match(callerLines(['hi']), /No MC yet/)
})

// Kills: a company name that is not the MC's owner passing without a question
test('callerBlock: a company name that does not fit the MC is to be asked about', () => {
  const t = callerLines(['this is Mike with Blue Harbor Freight, calling about the load', 'MC 741309'])
  assert.match(t, /That MC comes up as Keystone Line Haul, not what they said -- ask/)
})

// Kills: something they already told listed under "Still missing"
test('callerBlock: told items are never under Still missing', () => {
  const t = callerLines(['MC 741309', "truck's in Dover, empty tomorrow 6am, 53 dry van"])
  const missingLine = t.split(String.fromCharCode(10)).find((l) => /Still missing/.test(l))
  assert.ok(missingLine)
  assert.doesNotMatch(missingLine, /MC number|where the truck|when it is empty|trailer/)
  assert.match(missingLine, /company name/)
  assert.match(t, /They have told you: MC 741309/)
})

// Kills: 061 whose FROM text drifts from 052 by one character (replace()
// silently changes nothing), a wrong broker or a missing guard, the old
// "end with correct?" wording surviving, and a fact or forbidden word
// slipping into the new text.
test('061 limits Marcus\'s "correct?" to one read-back, never after a question', () => {
  const sql = migration('061_marcus_correct_once.sql').replace(/\r\n/g, '\n')
  const m = /replace\(persona, '((?:[^']|'')+)', '((?:[^']|'')+)'\)/.exec(sql)
  assert.ok(m, '061 has no replace(persona, FROM, TO)')
  const from = m[1].replaceAll("''", "'")
  const to = m[2].replaceAll("''", "'")
  const marcus = PERSONAS_052.find((p) => p.name === 'Cedar Ridge Transport Services').persona.replace(/\r\n/g, '\n')
  assert.ok(marcus.includes(from), 'FROM is not in the 052 text of Marcus')
  assert.match(sql, /WHERE name = 'Cedar Ridge Transport Services'/)
  assert.match(sql, /persona LIKE '%end with "correct\?"%'/)
  const next = marcus.replace(from, to)
  assert.match(next, /at most once/i)
  assert.match(next, /read-back|read it back/i)
  assert.match(next, /never after .*question/i)
  assert.doesNotMatch(next, /end with "correct\?"\./)
  assert.doesNotMatch(next, /paperwork|insurance|W-9|MC number|authority/i)
  assert.doesNotMatch(next, /\$\d|\d+ ?(mi|miles|days|%)\b|\d+-?foot|dry van|reefer|flatbed/i)
  const place = new RegExp(`\\b(${[...new Set(CITY_NAMES)].join('|')})\\b`)
  assert.doesNotMatch(next, place)
  const others = PERSONAS_052.filter((p) => p.name !== 'Cedar Ridge Transport Services').map((p) => p.persona)
  assert.ok(!others.includes(next))
})

// Kills: 062 whose FROM text drifts from 061's TO text or 052's original (replace()
// silently changes nothing and "correct?" survives), either path (061 applied,
// or 061 never applied) leaving the word, a wrong broker, a guard that
// re-matches after the fix (not re-runnable), and a fact or forbidden word
// slipping into the new text.
test('062 takes "correct?" out of Marcus on both paths and is re-runnable', () => {
  const sql = migration('062_marcus_no_correct.sql').replace(/\r\n/g, '\n')
  const swaps = [...sql.matchAll(/replace\(persona, '((?:[^']|'')+)', '((?:[^']|'')+)'\)/g)]
    .map((m) => ({ from: m[1].replaceAll("''", "'"), to: m[2].replaceAll("''", "'") }))
  assert.equal(swaps.length, 2)
  assert.equal([...sql.matchAll(/WHERE name = 'Cedar Ridge Transport Services' AND persona LIKE '%correct\?%'/g)].length, 2)
  const run = (persona) => swaps.reduce((p, s) => (p.includes('correct?') ? p.replace(s.from, s.to) : p), persona)

  const s061 = migration('061_marcus_correct_once.sql').replace(/\r\n/g, '\n')
  const m061 = /replace\(persona, '((?:[^']|'')+)', '((?:[^']|'')+)'\)/.exec(s061)
  const marcus052 = PERSONAS_052.find((p) => p.name === 'Cedar Ridge Transport Services').persona.replace(/\r\n/g, '\n')
  const after061 = marcus052.replace(m061[1].replaceAll("''", "'"), m061[2].replaceAll("''", "'"))

  for (const start of [after061, marcus052]) {
    assert.ok(/correct\?/.test(start))
    const next = run(start)
    assert.doesNotMatch(next, /correct/i)
    assert.match(next, /read it back once/)
    assert.equal(run(next), next, 'running 062 twice changes nothing')
    assert.doesNotMatch(next, /paperwork|insurance|W-9|MC number|authority/i)
    assert.doesNotMatch(next, /\$\d|\d+ ?(mi|miles|days|%)\b|\d+-?foot|dry van|reefer|flatbed/i)
  }
  assert.equal(run(after061), run(marcus052))
})

// Kills: 065 whose FROM text drifts from 052 by one character (replace()
// silently changes nothing and the flat "No." survives), a wrong broker,
// a guard that re-matches after the fix (not re-runnable), and the new
// text stating a fact or disobeying the rate rules by ordering a final
// refusal that ends the conversation.
test('065 takes the flat "No." out of Ironwood and is re-runnable', () => {
  const sql = migration('065_ironwood_no_flat_no.sql').replace(/\r\n/g, '\n')
  const m = /replace\(persona, '((?:[^']|'')+)', '((?:[^']|'')+)'\)/.exec(sql)
  assert.ok(m, '065 has no replace(persona, FROM, TO)')
  const from = m[1].replaceAll("''", "'")
  const to = m[2].replaceAll("''", "'")
  const ironwood = PERSONAS_052.find((p) => p.name === 'Ironwood Freight Partners').persona.replace(/\r\n/g, '\n')
  assert.ok(ironwood.includes(from), 'FROM is not in the 052 text of Ironwood')
  assert.match(sql, /WHERE name = 'Ironwood Freight Partners'/)
  assert.match(sql, /persona LIKE '%a flat "No\."%'/)
  const next = ironwood.replace(from, to)
  assert.doesNotMatch(next, /a flat "No"/i)
  assert.match(next, /not an explanation|blunt/i)
  assert.ok(!/final|last offer|never call again|do\s?n['’]t?[a-z ]*call back/i.test(next), 'a refusal that ends the conversation')
  assert.equal(ironwood.replace(from, to).replace(from, to), next, 'running 065 twice changes nothing')
  assert.doesNotMatch(next, /paperwork|insurance|W-9|MC number|authority/i)
  assert.doesNotMatch(next, /\$\d|\d+ ?(mi|miles|days|%)\b|\d+-?foot|dry van|reefer|flatbed/i)
  const place = new RegExp(`\\b(${[...new Set(CITY_NAMES)].join('|')})\\b`)
  assert.doesNotMatch(next, place)
  const others = PERSONAS_052.filter((p) => p.name !== 'Ironwood Freight Partners').map((p) => p.persona)
  assert.ok(!others.includes(next))
})
