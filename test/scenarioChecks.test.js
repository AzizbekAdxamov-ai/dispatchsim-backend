// The checks chat:scenarios runs on every reply. Each is tested on the
// real reply that made it necessary (reports/chat-scenarios-2026-10-06-*),
// and on a real reply from the same runs that must NOT be flagged -- a
// check that flags good replies is noise nobody reads twice.
//
// Pure. Each test names the mutation it kills.

import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { FALLBACK_REPLY as DRIVER_FALLBACK } from '../src/modules/driverChat/driverChat.prompt.js'
import { FALLBACK_REPLY as BROKER_FALLBACK } from '../src/modules/brokerChat/brokerChat.prompt.js'
import {
  PROMISE, anyReply, brokerReply, driverReply, repeatsQuestion, dollars, summarize, BROKER_EXPECT, DRIVER_EXPECT,
  agreesWithClaim, correctCount,
} from '../scripts/scenarioChecks.js'

// Kills: a promise pattern that misses "let me look at the paperwork"
// (G2, fourth run) or "give me a sec", or one that flags a plain "I do not know" (G3).
test('a promise to come back is flagged; saying you do not know is not', () => {
  assert.deepEqual(anyReply("Don't have the Nashville detention numbers—let me look at the paperwork."), ['promises to get back'])
  assert.deepEqual(anyReply('Give me a sec, checking.'), ['promises to get back'])
  assert.deepEqual(anyReply('One moment, I will be right there.'), ['promises to get back'])
  assert.deepEqual(anyReply("I do not know about a Dallas load yet — what's the pickup, how many miles, when does it need to be there?"), [])
})

// Kills: markdown passing, or a dash inside a sentence read as a bullet.
test('asterisks are markdown; a dash mid-sentence is not', () => {
  assert.deepEqual(anyReply('Heading *into* the yard now.'), ['markdown'])
  assert.deepEqual(anyReply('Need a legal parking spot after this NYC drop - you owe me for the city run.'), [])
})

// Kills: comparing whole questions word for word (S1 reworded it), or
// flagging a reply with no question at all.
test('the same question in two replies running is flagged, reworded or not', () => {
  assert.equal(repeatsQuestion("$7755, all-in. Where's your truck at?", "This load is still on the board. Where's your truck sitting right now?"), true)
  assert.equal(repeatsQuestion('Detention is $80 an hour after two free, pickup or delivery.', "You're close, which is good -- where are you sitting right now?"), false)
  assert.equal(repeatsQuestion("Where's your truck at?", null), false)
})

// Kills: "$3,750" read as 3.
test('dollar amounts are read with or without commas', () => {
  assert.deepEqual(dollars('I can do $3,750, or $3750 all-in, $2.19/mi'), [3750, 3750, 2.19])
})

// Kills: the ceiling check missing the 2026-10-06 line, or catching "my best".
test('a broker naming room or a ceiling is flagged; "my best" is not', () => {
  assert.deepEqual(brokerReply('Still got room before I hit my ceiling.'), ['names a ceiling or room'])
  assert.deepEqual(brokerReply("That's my best on this one."), [])
})

// Kills: S4 passing the fourth run's agreement, or failing the third
// run's correct answer.
test('S4: agreeing with a false bad-reload claim is flagged, citing the figure is not', () => {
  const s4 = BROKER_EXPECT.S4({ market: { destination: { linehaul: 2.19 } } })
  assert.deepEqual(s4[0]("Come on, you're killing me here — I hear you on the Savannah reload, but this number's got fuel in it. What are you needing?"),
    ['agrees with the false claim', 'reload figure not given'])
  assert.deepEqual(BROKER_EXPECT.S4({ market: { destination: { linehaul: 3.21 } } })[0]("Knoxville reload isn't bad this week -- Southeast is $3.21."), [])
})

// Kills: S5 not requiring the real figure.
test('S5: the wrong number is answered with the real one', () => {
  const s5 = BROKER_EXPECT.S5({ market: { origin: { linehaul: 2.32 } } })
  assert.deepEqual(s5[0]("$2.32 is what I'm seeing for Upper Atlantic linehaul this week, not $4.12 — you might be looking at a different report."), [])
  assert.deepEqual(s5[0]('You might be looking at a different report.'), ['real figure not given'])
})

// Kills: terms checked against anything but this broker's own figures.
test('S2/S8: the broker\'s own detention, TONU and layover must all be said', () => {
  const said = 'Detention is $80 an hour after two free, pickup or delivery. TONU is $225 if they cancel after dispatch. Layover is $275 a day if the truck has to sit overnight.'
  assert.deepEqual(BROKER_EXPECT.S2({ terms: { detentionPerHour: 80, tonuUsd: 225, layoverPerDay: 275 } })[1](said), [])
  assert.deepEqual(BROKER_EXPECT.S8({ terms: { detentionPerHour: 85, tonuUsd: 225, layoverPerDay: 275 } })[0](said), ['detention $85 missing'])
})

// Kills: S3 not catching a move on the first push or the whole ask.
test('S3: hold on the first push, never the whole ask', () => {
  const s3 = BROKER_EXPECT.S3({ posting: { rateUsd: 3541 }, ask: 3966 })
  assert.deepEqual(s3[0]('But $3541 is what this lane pays right now.'), [])
  assert.deepEqual(s3[1]('I can do $3750. That\'s a fair middle.'), [])
  assert.deepEqual(s3[1]('Fine, $3,966 it is.'), ['gave the whole ask'])
  assert.deepEqual(s3[0]('I can do $3700.'), ['moved on the first push'])
})

// Kills: a reefer answer passing with only one of the two, or the wrong day passing.
test('S6 wants both temperature and mode; S7 wants the pickup day', () => {
  const s6 = BROKER_EXPECT.S6()
  assert.deepEqual(s6[0]('0°F, continuous. Pre-cool the trailer before pickup.'), [])
  assert.deepEqual(s6[0]('34°F, pre-cool it.'), ['no continuous / start-stop'])
  const said = 'Pu tomorrow Wed at 5:29 PM, delivery Fri at 1:19 PM.'
  assert.deepEqual(BROKER_EXPECT.S7({ pickupDay: 'tomorrow|Wednesday|Wed' })[0](said), [])
  assert.deepEqual(BROKER_EXPECT.S7({ pickupDay: 'Thursday|Thu' })[0](said), ['pickup day (Thursday|Thu) not said'])
  assert.deepEqual(BROKER_EXPECT.S1({ posting: { rateUsd: 7755 } })[1]("$7755, all-in. Where's your truck at?"), [])
})

// Kills: the dock check firing for a driver who is parked, or missing
// the fourth run's two lines.
test('a driver on the road at a dock is flagged, only when she is on the road', () => {
  assert.deepEqual(driverReply('Waiting on the dock, box is loaded.', null, { onTheRoad: true }), ['at a dock while on the road'])
  assert.deepEqual(driverReply('At the NY drop, just finished the walkaround.', null, { onTheRoad: true }), ['at a dock while on the road'])
  assert.deepEqual(driverReply('At the NY drop, just finished the walkaround.', null, { onTheRoad: false }), [])
})

// Kills: an ETA with no hour passing, the fuel figure not checked, or
// New York counted on the turn where the dispatcher raised it.
test('G2 wants an hour and the city; G3 the fuel figure and no New York after the first', () => {
  const g2 = DRIVER_EXPECT.G2({ city: 'New York', hasEta: true })
  assert.deepEqual(g2[0]("I'm on a walkaround outside NY, should be at the drop in a bit."), ['ETA without an hour'])
  assert.deepEqual(g2[0]('Due in around 4:30 PM.'), [])
  assert.deepEqual(g2[1]('On the road near New York, about an hour out.'), [])
  const g3 = DRIVER_EXPECT.G3({ fuelPct: 96 })
  assert.equal(g3[0], undefined)
  assert.deepEqual(g3[1]('Fuel is sitting at about 96%.'), [])
  assert.deepEqual(g3[1]('Fuel is fine, but I still hate the city.'), ['fuel not 96%', 'New York again'])
})

// Kills: counting a finding once per reply instead of once per run, or a
// scenario with findings reported as clean.
test('the summary counts runs, not replies, and lists the clean scenarios', () => {
  const rows = [
    { scenario: 'S1', run: 1, findings: ['same question as last reply'] },
    { scenario: 'S1', run: 1, findings: ['same question as last reply'] },
    { scenario: 'S1', run: 2, findings: [] },
    { scenario: 'S6', run: 1, findings: [] },
  ]
  const { lines, clean } = summarize(rows, 2)
  assert.deepEqual(lines, ['| S1 | same question as last reply | 1/2 |'])
  assert.deepEqual(clean, ['S6'])
})

// Kills: the system's own holding line ("Give me a minute ...") being
// counted as the model promising to come back -- it is a separate result.
test('the fallback replies are "fell back", not a promise', () => {
  assert.deepEqual(anyReply(DRIVER_FALLBACK), ['fell back'])
  assert.deepEqual(anyReply(BROKER_FALLBACK), ['fell back'])
  assert.deepEqual(anyReply('Give me a minute, back soon.'), ['promises to get back'])
})

// Kills: Grace's persona (drivers.bio) telling the model to say "let me
// look" while the prompt forbids it (ED02/ED10, 2026-10-12). 051 wrote the
// phrase; 057 must replace exactly it (a one-character mismatch makes the
// UPDATE a silent no-op) with words that are not a promise.
test('the migration that fixes the Grace bio matches the old text and promises nothing', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations')
  const read = (name) => readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n')
  const old = read('051_driver_bio.sql')
  const fix = read('057_grace_bio_no_promise.sql')
  const [, from, to] = /replace\(bio, '([^']*)', '([^']*)'\)/.exec(fix)
  assert.ok(old.includes(from), 'the phrase 057 replaces is in 051')
  assert.match(old, PROMISE, '051 does contain a promise (the thing being fixed)')
  assert.doesNotMatch(old.replace(from, to), PROMISE)
  assert.doesNotMatch(to, PROMISE)
})

// Kills: a broker sending the dispatcher back to their own side going
// unflagged (live 2026-10-13: live:52, live:56, live:58), a pattern that
// misses the curly apostrophe or "you would/should", or one that flags the
// broker naming their own accounting or "recheck with your".
test('a broker telling the dispatcher to check with their own side is flagged', () => {
  const FLAG = ['sends the dispatcher back to check']
  assert.deepEqual(brokerReply("I don't have the drop details in front of me; you'd check with the shipper on whether it's a live load or a drop."), FLAG)
  assert.deepEqual(brokerReply("I don't know where your truck is. You'd check with your dispatcher on that."), FLAG)
  assert.deepEqual(brokerReply("I don't set payment terms. You'd check with your office on quick pay options."), FLAG)
  assert.deepEqual(brokerReply('You\u2019d check with your office on that.'), FLAG)
  assert.deepEqual(brokerReply('You should check with your office.'), FLAG)
  assert.deepEqual(brokerReply('Check with ur dispatcher.'), FLAG)
  assert.deepEqual(brokerReply("Quick pay is our accounting's call."), [])
  assert.deepEqual(brokerReply('We check with our accounting on that, and I recheck with your numbers.'), [])
})

// Kills: anyReply / brokerReply / driverReply reading the raw text (a curly apostrophe or a non-breaking hyphen slipping past), or the previous reply left unfolded
test('the scenario checks read typographic punctuation as plain ASCII', () => {
  assert.deepEqual(anyReply('I’ll look into it.'), ['promises to get back'])
  assert.deepEqual(brokerReply('You’d check with your dispatcher.', null), ['sends the dispatcher back to check'])
  assert.deepEqual(driverReply('I’ll check.', null, { onTheRoad: false }), ['promises to get back'])
  assert.deepEqual(anyReply('Where’s your truck at right now?', 'Where’s your truck sitting?'), ['same question as last reply'])
  assert.deepEqual(anyReply(BROKER_FALLBACK.replace('—', '–')), ['fell back'])
})

// Kills: S3 counting the echo of the ask as a move (dollars(r) back in
// S3), and "I hear you on X" no longer flagged (BARE_ACK test deleted).
test('S3 does not count an echo of the ask; S4 still flags "I hear you on X"', () => {
  const s3 = BROKER_EXPECT.S3({ posting: { rateUsd: 3541 }, ask: 3966 })
  const echo = 'So you’re looking for $3,966. $3541 is what this lane pays.'
  assert.deepEqual(s3[0](echo), [])
  assert.deepEqual(s3[1](echo), [])
  assert.equal(agreesWithClaim('I hear you on the reload. This lane is already above it.'), true)
})

// Kills: the same hole in S3 -- agreement worded around the carrier's ask
// ("If you're looking for $3,966, I can do that") passing both turns.
test('S3: an echo that turns into a yes is flagged on both turns', () => {
  const s3 = BROKER_EXPECT.S3({ posting: { rateUsd: 3541 }, ask: 3966 })
  for (const r of ["If you're looking for $3,966, I can do that.", "If you need $3,966 I'll make it work.", 'So you want $3,966 - done.', "If you're looking for $3,966, tell me about the truck."]) {
    assert.deepEqual(s3[0](r), ['moved on the first push'], r)
    assert.deepEqual(s3[1](r), ['gave the whole ask'], r)
  }
})

// Kills: a "correct?" after a rate (S4, 2026-10-16) passing as a read-back,
// or one that really reads the carrier's plan back being flagged.
test('"correct?" is flagged after a rate, not after a read-back of their truck', () => {
  assert.deepEqual(brokerReply('The posted rate is $5,002, all-in -- linehaul and fuel included. Correct?', null), ['correct? without a read-back'])
  assert.deepEqual(brokerReply('So your truck is in Dallas, empty at 6. Correct?', null), [])
  assert.deepEqual(brokerReply('The rate is firm. Correct?', null), ['correct? without a read-back'])
})

// Kills: the whole-chat count missing a second "correct?" (more than once).
test('correctCount counts every "correct?" in the chat', () => {
  assert.equal(correctCount(['So your truck is in Dallas. Correct?', 'Fine.', 'Your driver is Sam, correct?']), 2)
  assert.equal(correctCount(['Fine.']), 0)
})

// -- S9: the booking call ---------------------------------------------------

import { s9Ask, s9Email, s9Mc, s9WrongMc, afterTomorrowSixCentral, bookedBeforeAskingMc, STREET, PHONE } from '../scripts/scenarioChecks.js'

// Heavy and picking up within a day: weight and a tight window are both true of it.
const HOUR = 3600e3
const S9_POSTING = { rateUsd: 2000, distanceMi: 1000, weightLbs: 45000, pickupAt: new Date(Date.now() + 20 * HOUR).toISOString() }
const S9_OURS = { name: 'Cedar Ridge Transport Services', mcNumber: 'MC-741309' }
const EMAIL = s9Email(S9_OURS)
const s9 = (key) => BROKER_EXPECT[key]({ posting: S9_POSTING, email: EMAIL })

// Kills: the S9 email on a real domain, or the MC typed in another shape
test('S9 typed values: .example email, our digits, a wrong MC that is not ours', () => {
  assert.equal(EMAIL, 'dispatch@cedar-ridge-transport-services.example')
  assert.equal(s9Mc(S9_OURS), '741309')
  assert.equal(s9WrongMc(S9_OURS), '999999')
  assert.equal(s9WrongMc({ mcNumber: 'MC-999999' }), '999998')
  assert.equal(s9Ask(S9_POSTING), 2200)
})

// Kills: a pickup before "empty tomorrow 6am" accepted for S9
test('S9 posting: pickup must be later than tomorrow 06:00 Central', () => {
  const now = new Date('2026-10-17T15:00:00Z')
  assert.equal(afterTomorrowSixCentral('2026-10-18T10:00:00Z', now), false)
  assert.equal(afterTomorrowSixCentral('2026-10-18T20:00:00Z', now), true)
  assert.equal(afterTomorrowSixCentral('2026-10-20T14:00:00Z', now), true)
})

// Kills: more than one question per reply, or an invented street / phone / email, passing in S9
test('S9 every turn: one question; no address, phone or other email', () => {
  const t = s9('S9a')[2]
  assert.deepEqual(t('Got it. What time is the driver free?'), [])
  assert.deepEqual(t('Got it. Is it a dry van? And what time?'), ['more than one question'])
  assert.deepEqual(s9('S9a')[5]('Rate con goes to ' + EMAIL + '.'), [])
  assert.deepEqual(s9('S9a')[5]('Pickup is at 4412 Commerce Dr, call 214-555-0110.'), ['invents an address / phone / email'])
  assert.deepEqual(s9('S9a')[5]('I will send it to dispatch@other.example.'), ['invents an address / phone / email'])
  assert.ok(STREET.test('4412 Commerce Dr') && PHONE.test('214-555-0110'))
})

// Kills: S9a turn 0 where the broker never asks for the MC, or asks the company again
test('S9a t0: MC asked, company not asked again', () => {
  const t = s9('S9a')[0]
  assert.deepEqual(t("Yes it is. What's your MC?"), [])
  assert.deepEqual(t('Yes it is. Where is your truck?'), ['MC not asked'])
  assert.deepEqual(t('Yes it is. What company are you with, and your MC?'), ['asks what was told'])
})

// Kills: the right MC rejected, or asked for again after it was given
test('S9a t1: the right MC is not rejected or asked for again', () => {
  const t = s9('S9a')[1]
  assert.deepEqual(t('Got it, that comes up. Where is your truck?'), [])
  assert.deepEqual(t("That MC doesn't come up on my end."), ['rejects the right MC'])
  assert.deepEqual(t("Got it. What's your MC?"), ['asks what was told'])
})

// Kills: the truck, empty time or trailer asked again after S9a line 3
test('S9a t2: location, empty time and trailer are not asked again', () => {
  const t = s9('S9a')[2]
  assert.deepEqual(t('Good, that works for pickup. What are you looking to pay?'), [])
  assert.deepEqual(t("Where's your truck sitting?"), ['asks what was told'])
  assert.deepEqual(t('What trailer is it?'), ['asks what was told'])
})

// Kills: moving on the first push, or the whole ask, or moving with no reason
test('S9a t3/t4: first push held; meet in the middle only with a reason, not the whole ask', () => {
  assert.deepEqual(s9('S9a')[3]('The posted rate is $2,000, all-in.'), [])
  assert.deepEqual(s9('S9a')[3]('I can do $2,100.'), ['moved on the first push'])
  assert.deepEqual(s9('S9a')[4]('With the weight and the tight window I can do $2,100.'), [])
  assert.deepEqual(s9('S9a')[4]('I can do $2,100.'), ['moved without a reason'])
  assert.deepEqual(s9('S9a')[4]('With the weight I can do $2,200.'), ['gave the whole ask'])
})

// Kills: a "tight window" accepted as the reason for a raise on a pickup more than a day out
test('S9 t4: a reason the posting does not have is its own finding', () => {
  const far = { ...S9_POSTING, weightLbs: 30000, pickupAt: new Date(Date.now() + 48 * HOUR).toISOString() }
  const t = BROKER_EXPECT.S9a({ posting: far, email: EMAIL })[4]
  assert.deepEqual(t("I can do $2,100, pickup window's tight."), ['reason not in the posting'])
  assert.deepEqual(t('I can do $2,100.'), ['moved without a reason'])
})

// Kills: driver, truck number or email asked again after S9a line 6
test('S9a t5: driver, truck and email are not asked again', () => {
  const t = s9('S9a')[5]
  assert.deepEqual(t('Rate con is on its way.'), [])
  assert.deepEqual(t("What's the driver's name?"), ['asks what was told'])
})

// Kills: S9b booking on a wrong MC, not calling it out, or not asking again at the end
test('S9b: a wrong MC is called out, nothing is booked, the MC is asked for again', () => {
  const b = s9('S9b')
  assert.deepEqual(b[1]("That MC doesn't come up on my end. Can you check it?"), [])
  assert.deepEqual(b[1]('Thanks. Where is your truck?'), ['wrong MC not called out'])
  assert.deepEqual(b[2]("You're booked."), ['books on a wrong MC'])
  assert.deepEqual(b[5]("I can't book it, that MC doesn't come up. Send the right one?"), [])
  assert.deepEqual(b[5]('Rate con goes out shortly.'), ['MC not asked again'])
})

// Kills: S9c booking with no MC, or "just book it" answered without asking the MC
test('S9c: no booking without an MC; "just book it" gets the MC question', () => {
  const c = s9('S9c')
  assert.deepEqual(c[4]("Can't book without your MC. What is it?"), [])
  assert.deepEqual(c[4]('Sure, what is the driver name?'), ['MC not asked before booking'])
  assert.deepEqual(c[2]("You're all set."), ['books without an MC'])
})

// Kills: "booked" before the MC was ever asked not being found across the chat
test('conversation: booked before asking MC', () => {
  assert.equal(bookedBeforeAskingMc(['Yes it is.', "What's your MC?", "You're booked."]), false)
  assert.equal(bookedBeforeAskingMc(['Yes it is.', "You're booked."]), true)
  assert.equal(bookedBeforeAskingMc(['Yes it is.', 'Where is the truck?']), false)
})

// Kills: S9 keys missing from the script's turn counts (the budget check and --scenario S9a)
test('chat-scenarios knows S9a/S9b/S9c and their turn counts', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'chat-scenarios.js'), 'utf8')
  assert.match(src, /S9a: 6, S9b: 6, S9c: 5/)
})

// -- False positives found in review (2026-10-17) ----------------------------

import { paymentInvented } from '../scripts/scenarioChecks.js'

// Kills: "correct?" flagged when it reads back the pickup or asks "is that correct?"
test('correct? after a pickup read-back is not a tic; after "that" or "load" alone it is', () => {
  assert.deepEqual(brokerReply('Pickup is Dallas at 6, correct?', null), [])
  assert.deepEqual(brokerReply("That's all-in. Correct?", null), ['correct? without a read-back'])
  assert.deepEqual(brokerReply('The load is all-in, correct?', null), ['correct? without a read-back'])
  assert.deepEqual(brokerReply('The rate is firm. Correct?', null), ['correct? without a read-back'])
})

// Kills: payment terms flagged when echoing the carrier's own figure or denying a term
test('paymentInvented: carrier\'s own words and denials pass; a new term is flagged', () => {
  const said = 'can u pay in 7 days? net 30?'
  assert.equal(paymentInvented("7 days to pay is accounting's call, not mine.", said), false)
  assert.equal(paymentInvented("I can't speak to net 30 or any days, that's accounting.", said), false)
  assert.equal(paymentInvented('7 days to pay is fine.', said), false)
  assert.equal(paymentInvented('We pay net 15.', said), true)
  assert.equal(paymentInvented('We pay net 30.', null), true)
  assert.deepEqual(brokerReply('We pay net 15.', null, 'when do you pay?'), ['payment terms invented'])
})

// Kills: a denial of one term excusing a NEW invented term in the next clause
test('paymentInvented: a denial does not cover another clause', () => {
  const said = 'can u pay net 30?'
  assert.equal(paymentInvented("I can't speak to net 30, but we pay net 15.", said), true)
  assert.equal(paymentInvented("I can't speak to net 30 or any days, that's accounting.", said), false)
})

// Kills: a truthful deadhead reason flagged by a check that cannot see the dispatcher's truck line
test('S9 t4: a deadhead reason is not judged by the reply-only check', () => {
  const far = { ...S9_POSTING, weightLbs: 30000, pickupAt: new Date(Date.now() + 48 * HOUR).toISOString() }
  const t = BROKER_EXPECT.S9a({ posting: far, email: EMAIL })[4]
  assert.deepEqual(t('Long deadhead to get there, I can do $2,100.'), ['moved without a reason'])
})

// Kills: the scenario check growing a second copy of the "no reason" rule
// (it would drift from the live reply check), or the helpers moved into src
// being lost from the old import path the eval cases still use.
test('movedWithoutReason asks the shared raiseWithoutReason; moved helpers are still exported here', async () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'scenarioChecks.js'), 'utf8')
  assert.match(src, /import \{[^}]*\braiseWithoutReason\b[^}]*\} from '\.\.\/src\/modules\/brokerChat\/rateTalk\.js'/)
  assert.doesNotMatch(src, /REASON_WORDS\[k\]\.test/)
  const mod = await import('../scripts/scenarioChecks.js')
  const rate = await import('../src/modules/brokerChat/rateTalk.js')
  const terms = await import('../src/modules/brokerChat/termsTalk.js')
  assert.equal(mod.offeredFigures, rate.offeredFigures)
  assert.equal(mod.dollars, rate.dollars)
  assert.equal(mod.PAYMENT_INVENTED_RE, terms.PAYMENT_INVENTED_RE)
})

// Kills: S9 t4 reading a figure the reply refuses, or one the broker gave
// before, as a raise (the check moved to rateTalk.js keeps its S9 behaviour).
test('S9 t4: a flat load with no reason names "moved without a reason" through the shared rule', () => {
  const flat = { rateUsd: 2000, distanceMi: 1000, weightLbs: 30000, pickupAt: new Date(Date.now() + 48 * HOUR).toISOString(), destinationState: 'IL', equipmentType: 'dry-van', originState: 'TX' }
  const t = BROKER_EXPECT.S9a({ posting: flat, email: EMAIL })[4]
  assert.deepEqual(t('I can do $2,100.'), ['moved without a reason'])
  assert.ok(!t(`I can't do $${s9Ask(flat)}.`).includes('moved without a reason'))
})
