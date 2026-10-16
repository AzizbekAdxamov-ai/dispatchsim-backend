// The chat:eval case bank. Each check is tried on a real reply from the
// 2026-10-05/06 runs (reports/) that it must pass, and on one it must
// flag. Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ceilingFor } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { BROKER_CASES, DRIVER_CASES, brokerFindings, driverFindings, milesOff, CLASSIFIER_ONLY_FINDING } from '../scripts/evalCases.js'

const b = (id) => BROKER_CASES.find((c) => c.id === id)
const d = (id) => DRIVER_CASES.find((c) => c.id === id)

// Kills: a bank that drifts from twenty and twenty-three (the run is sized to the
// daily budget on that count), or a case without its grading note.
test('twenty broker and twenty-three driver cases, each with words, a check and a right answer', () => {
  assert.equal(BROKER_CASES.length, 20)
  assert.equal(DRIVER_CASES.length, 23)
  for (const c of [...BROKER_CASES, ...DRIVER_CASES]) {
    assert.ok(c.line && c.good && typeof c.expect === 'function', c.id)
  }
  assert.equal(new Set([...BROKER_CASES, ...DRIVER_CASES].map((c) => c.id)).size, 43)
})

// Kills: "fuel's separate" passing as all-in (heard 2026-10-05).
test('EB01 all-in', () => {
  const check = b('EB01').expect()
  assert.deepEqual(check("Yeah, that's all-in -- linehaul and fuel together, nothing on top."), [])
  assert.deepEqual(check("Rate's $3,100, fuel's separate."), ['all-in not said', 'says fuel is extra'])
  assert.deepEqual(check("It's all-in at $3,100 plus fuel."), ['says fuel is extra'])
})

// Kills: the rpm not checked against rate / miles.
test('EB02 rpm is rate over miles', () => {
  const check = b('EB02').expect({ posting: { rateUsd: 7755, distanceMi: 2454 } })
  assert.deepEqual(check("It's $3.16 a mile, all-in."), [])
  assert.deepEqual(check("It's around $2.90 a mile."), ['rpm 3.16 not given'])
})

// Kills: a first-push move passing.
test('EB04 holds on the first push', () => {
  const check = b('EB04').expect({ posting: { rateUsd: 3541 } })
  assert.deepEqual(check("That deadhead is real. But $3541 is what this lane pays right now."), [])
  assert.deepEqual(check('I can do $3,750.'), ['moved on the first push'])
})

// Kills: terms checked against anything but this broker's own.
test('EB07 the broker\'s own accessorials', () => {
  const check = b('EB07').expect({ terms: { detentionPerHour: 80, tonuUsd: 225, layoverPerDay: 275 } })
  assert.deepEqual(check('Detention is $80 an hour after two free. TONU is $225. Layover is $275 a day.'), [])
  assert.deepEqual(check('Detention is $80 an hour after two free.'), ['TONU $225 missing', 'layover $275 missing'])
})

// Kills: paperwork requests and the shared checks not applied to every case.
test('every broker reply is checked for paperwork, promises and markdown', () => {
  assert.deepEqual(brokerFindings("What's your MC number?", () => []), ['asks for paperwork'])
  assert.deepEqual(brokerFindings('Let me check and get back to you.', () => []), ['promises to get back'])
  assert.deepEqual(brokerFindings('(FAILED: AI quota exhausted)', () => ['x']), ['no reply'])
})

// Kills: a safety classifier label being graded as a normal character
// answer, or a broad "safety" match that rejects an ordinary reply.
test('classifier-only labels are findings in either chat, normal replies are not', () => {
  const normal = "Doing all right, dispatch. Just finished the walkaround. What's next?"
  assert.deepEqual(driverFindings('User Safety: safe', () => [], { onTheRoad: false }), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(driverFindings(' user safety: unsafe ', () => [], { onTheRoad: false }), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(brokerFindings('User Safety: safe', () => []), [CLASSIFIER_ONLY_FINDING])
  assert.deepEqual(driverFindings(normal, () => [], { onTheRoad: false }), [])
  assert.deepEqual(driverFindings('Safety at the dock comes first.', () => [], { onTheRoad: false }), [])
})

// Kills: Grace's ETA, fuel, hours and pay checks not reading her data.
test('ED02/ED04/ED05/ED09 read her own numbers', () => {
  assert.deepEqual(d('ED02').expect({ load: { etaAt: 'x' } })("I'm on a walkaround outside NY, should be at the drop in a bit."), ['ETA without an hour'])
  assert.deepEqual(d('ED04').expect({ driver: { hosRemainingMin: 395 } })('Got 6h 35m left today.'), [])
  assert.deepEqual(d('ED04').expect({ driver: { hosRemainingMin: 395 } })('Plenty left, boss.'), ['not 6h 35m'])
  assert.deepEqual(d('ED05').expect({ fuelPct: 96 })('Fuel is sitting at about 96%.'), [])
  assert.deepEqual(d('ED05').expect({ fuelPct: 96 })("Fuel's fine."), ['fuel not 96%'])
  assert.deepEqual(d('ED09').expect({ standing: { unpaidCount: 2, owedUsd: 1840.4 } })("Still waiting on $1,840 from two loads."), [])
  assert.deepEqual(d('ED09').expect({ standing: { unpaidCount: 2, owedUsd: 1840.4 } })('Not yet.'), ['owed $1840 not said'])
})

// Kills: a bot admission or an invented amount passing; NYC unraised passing.
test('ED06/ED08/ED10 her character and her request', () => {
  assert.deepEqual(d('ED10').expect()("No, just a tired driver who can't find parking."), [])
  assert.deepEqual(d('ED10').expect()("Ha, sure. A bot that can't find parking."), ['does not deny being a bot'])
  assert.deepEqual(d('ED10').expect()('Copy, what is the load?'), ['does not deny being a bot'])
  assert.deepEqual(d('ED10').expect()("I'm an AI assistant."), ['breaks character', 'does not deny being a bot'])
  assert.deepEqual(d('ED06').expect()('Sat four hours, they owe $200.'), ['quotes money she was never given'])
  assert.deepEqual(d('ED08').expect()('Copy that, I am on the NYC load. I asked you not to give me this one, the turns and parking are a nightmare.'), [])
  assert.deepEqual(d('ED08').expect()('Copy that.'), ['her own request not raised', 'reason not said'])
  assert.deepEqual(driverFindings('Waiting on the dock, box is loaded.', () => [], { onTheRoad: true }), ['at a dock while on the road'])
})

// Kills: matching before normalizing (gpt-oss writes U+2011)
test('EB01 sees an all-in written with a non-breaking hyphen and an em dash', () => {
  const reply = 'Sorry for the hold‑up—yes, that $3,820 rate is all‑in, no fuel surcharge on top.'
  assert.deepEqual(brokerFindings(reply, b('EB01').expect()), [])
})

// Kills: PROMISE missing a curly apostrophe
test("a curly-apostrophe \"I'll confirm\" is still a promise to get back", () => {
  assert.ok(brokerFindings('I’ll confirm the exact count when the truck arrives.', () => []).includes('promises to get back'))
  assert.ok(driverFindings('I’ll check on that.', () => [], { onTheRoad: false }).includes('promises to get back'))
})

// Kills: ED07 counting only "?" as asking, or any "I need ..." with a pickup word in it as asking
test('ED07 counts a request for the details as asking, a bare acknowledgement is not', () => {
  const check = d('ED07').expect()
  assert.deepEqual(check('Copy that. Need pickup address, miles, and delivery info.'), [])
  assert.deepEqual(check('Copy that. Send me the details.'), [])
  assert.deepEqual(check('Copy that.'), ['asks nothing about the load'])
  assert.deepEqual(check('Copy that. I need to get fuel before I roll.'), ['asks nothing about the load'])
  assert.deepEqual(check('Copy that. I need 30 min before pickup.'), ['asks nothing about the load'])
  assert.deepEqual(check('Need to drop the trailer first.'), ['asks nothing about the load'])
})

// Kills: the dash-led line being left out of the markdown count after normalizing (accepted trade-off: "- " leads a bullet)
test('a reply that opens with an em dash is read as a bulleted line once folded', () => {
  assert.deepEqual(brokerFindings('— yes, all-in.', () => []), ['markdown'])
})

// Kills: a reply that repeats the dispatcher's wrong figure passing (EB06)
test('EB06 flags a reply that echoes the quoted figure instead of the real one', () => {
  const posting = { equipmentType: 'flatbed' }
  const market = { origin: { linehaul: 2.95 } }
  const line = 'DAT shows carolinas flatbed at 4.75 linehaul this week so ur way under'
  const check = b('EB06').expect({ posting, market, line })
  assert.deepEqual(check('Yeah, the Carolinas are up around $4.75/mi.'), ['real figure not given', 'echoes their figure'])
  assert.deepEqual(check('Not what I see: Carolinas flatbed is $2.95/mi linehaul.'), [])
  assert.deepEqual(check('Not sure about that one.'), ['real figure not given'])
})

// -- Offered loads (ED07, ED11, ED12): the reply against the computed facts ------

const seattleOffer = (miles, makesIt) => ({ city: 'Dallas', state: 'TX', miles, makesIt })

// Kills: an unreachable pickup passing with a bare "Copy" (live:60), or "later" / "can't" not counting
test('ED07 and ED11 flag a reply that does not say the pickup cannot be made', () => {
  for (const id of ['ED07', 'ED11']) {
    const check = d(id).expect({ offer: seattleOffer(1982, false) })
    assert.deepEqual(check('Copy. How many miles and what is the pay?'), ['pickup unreachable not said'])
    assert.deepEqual(check("Can't make 8am from Seattle, that is about 1,982 miles. Can it go later?"), [])
    assert.deepEqual(check('Too far for that. Later in the week?'), [])
    assert.deepEqual(check('Copy, any chance it is a later pickup?'), [])
  }
  // No verdict computed (on a load, unknown city): nothing to contradict.
  assert.deepEqual(d('ED11').expect({ offer: seattleOffer(1982, null) })('Copy.'), [])
  assert.deepEqual(d('ED11').expect({})('Copy.'), [])
})

// Kills: stated miles never compared to the computed ones (live:62 "about 2,500 mi")
test('a stated distance more than 5% off the computed one is flagged', () => {
  const check = d('ED07').expect({ offer: seattleOffer(1982, false) })
  assert.deepEqual(check("Can't make it, that's about 2,500 miles. Later?"), ['miles off'])
  assert.deepEqual(check("Can't make it, about 1,982 miles out. Later?"), [])
  assert.deepEqual(check("Can't make it, 2,050 mi out. Later?"), [])
  assert.deepEqual(check("Can't make it, about 45 hours driving. Later?"), [])
  assert.equal(milesOff('about 2500 mi', null), false)
  assert.equal(milesOff('about 2500 mi', { miles: null }), false)
})

// Kills: ED12 flagging a driver who takes a load she can reach, or missing a turn-down of one
test('ED12 flags turning down a load she can make', () => {
  const check = d('ED12').expect({ offer: seattleOffer(270, true) })
  assert.deepEqual(check('Copy. Where does it drop and what is the pay?'), [])
  assert.deepEqual(check("Can't make that, too far."), ['turned down a load she can make'])
  assert.deepEqual(check('No way, not doing that.'), ['turned down a load she can make'])
  // The same words about a load she cannot make are not this finding.
  assert.deepEqual(d('ED12').expect({ offer: seattleOffer(270, false) })("Can't make that."), [])
})

// -- Reasons (ED08, ED13) ---------------------------------------------------------

// Kills: ED08 accepting a request raised with no reason (live ED08: "I already
// said I didn't want that box into NYC."), or demanding one when it is given
test('ED08 flags a request raised without its reason', () => {
  const check = d('ED08').expect()
  assert.deepEqual(check("I already said I didn't want that box into NYC."), ['reason not said'])
  assert.deepEqual(check("I asked not to go into NYC, the tight streets and tickets are not worth it."), [])
  assert.deepEqual(check('The city is a nightmare to park a 53, I asked not to get it.'), [])
  assert.deepEqual(check('Copy, driving.'), ['her own request not raised', 'reason not said'])
})

// Kills: ED13 passing a bare "no" (live:64 "No, not doing that."), or flagging a reason
test('ED13 flags a refusal of a long empty run that gives no reason', () => {
  const check = d('ED13').expect({ line: d('ED13').line })
  assert.deepEqual(check('No, not doing that.'), ['reason not said'])
  assert.deepEqual(check("No, 2,500 miles empty is more than my hours allow."), [])
  assert.deepEqual(check("Can't, I would run out of clock after 11 hours."), [])
  assert.equal(d('ED13').line, 'Grace can u deadhead 2500 miles if i pay extra?')
})

// -- Review round 2: the regexes -------------------------------------------------

// Kills: GIVES_REASON matching parts of words ("turned it down", "return") or "tight on hours"
test('ED08 does not take a look-alike word as the reason', () => {
  const check = d('ED08').expect()
  for (const reply of ['I asked not to get NYC, turned it down before.', 'NYC again? I need a return load.', 'NYC is tight on hours for me.']) {
    assert.deepEqual(check(reply), ['reason not said'], reply)
  }
  assert.deepEqual(check('NYC, no room to turn that box around.'), [])
  assert.deepEqual(check('NYC means parking nowhere and a ticket.'), [])
  assert.deepEqual(check('NYC? Tight streets, I asked not to.'), [])
})

// Kills: ED13 counting the line's own "miles", "interest", "today" as a reason
test('ED13 fires on a bare no, an echo of the miles and look-alike words', () => {
  const check = d('ED13').expect({ line: d('ED13').line })
  for (const reply of ['2500 miles? no.', 'No interest in that.', 'Not today.', 'Not doing it.']) {
    assert.deepEqual(check(reply), ['reason not said'], reply)
  }
  for (const reply of ['No, that is a long empty run.', 'Out of hours after 11.', 'Not worth the fuel.', 'Not for free, no.', 'Can\'t, that is two days of empty miles.']) {
    assert.deepEqual(check(reply), [], reply)
  }
})

// Kills: a bare "later" ("talk to you later") passing as saying the pickup cannot be made
test('ED07 needs a later pickup, not the word later', () => {
  const check = d('ED07').expect({ offer: seattleOffer(1982, false) })
  assert.deepEqual(check('Copy, talk to you later. What is the pay?'), ['pickup unreachable not said'])
  assert.deepEqual(check('Copy, any chance for a later pickup?'), [])
  assert.deepEqual(check('Copy, can you push the pickup?'), [])
  assert.deepEqual(check('Copy, no way I am there by 8. Later time?'), [])
})

// Kills: "can't wait" flagged as turning down a load she can make
test('ED12 does not take "can\'t wait" for a refusal', () => {
  const check = d('ED12').expect({ offer: seattleOffer(270, true) })
  assert.deepEqual(check("Copy, can't wait to roll. Where does it drop?"), [])
  assert.deepEqual(check("Can't take that one."), ['turned down a load she can make'])
  assert.deepEqual(check("I'm not taking it."), ['turned down a load she can make'])
  assert.deepEqual(check('I will pass on it.'), ['turned down a load she can make'])
})

// Kills: ED07 keeping its own copy of the words (the eval flagging what the
// service accepts). No "later pickup" here -- that would pass on the old list.
test('ED07 uses the shared cannot-make words', () => {
  const check = d('ED07').expect({ offer: seattleOffer(1982, false) })
  assert.deepEqual(check('Not gonna make 8am, earliest I could be there is Sun. Any other time?'), [])
})

// Kills: the carrier's own ask, said back to them, counted as a move (live
// 2026-10-15), or the exception widened until a real offer slips through
// (no frame, or a figure that is not theirs).
test('EB04: echoing the carrier\'s own ask is not a move (eval 2026-10-15)', () => {
  const check = b('EB04').expect({ posting: { rateUsd: 3488 }, line: 'DAT has upper atlantic at 2.56, reload out of there is dead, ill be deadheading out. need $3907' })
  assert.deepEqual(brokerFindings('Got it—you’re seeing a $2.56 / mi rate out of the Upper Atlantic and you’d be dead‑heading back, so you’re looking for $3,907. My posted rate is $3,488 all‑in.', check), [])
  assert.deepEqual(check("You're looking for $3,907? I can do $3,907."), ['moved on the first push'])
  assert.deepEqual(check("So you're looking for $3,950."), ['moved on the first push'])
})

// Kills: "I hear you" always counted as agreement (a courtesy before a
// rebuttal flagged), or never counted (real agreement missed).
test('EB05: "I hear you" followed by a rebuttal is not agreement', () => {
  const check = b('EB05').expect({ market: { destination: { linehaul: 2.19 } } })
  assert.deepEqual(brokerFindings('Got it, I hear you. This lane is already $3.16 /mi all‑in, which is above the $2.19 /mi average out of Chattanooga, so the rate is firm at $7,742.', check), [])
  assert.deepEqual(brokerFindings('I hear you, the reload out of there is rough. $2.19 is the figure.', check), ['agrees with the false claim'])
})

// Kills: the echo exception excusing agreement -- a conditional lead-in
// ("If you're looking for ...") or an acceptance after the figure ("... I
// can do that") read as a mere echo, so the broker giving the whole ask on
// the first push goes unflagged.
test('EB04: an echo that turns into a yes is still a move', () => {
  const check = b('EB04').expect({ posting: { rateUsd: 3488 }, line: 'need $3907' })
  assert.deepEqual(check("If you're looking for $3,907, I can do that."), ['moved on the first push'])
  assert.deepEqual(check("If you need $3,907 I'll make it work."), ['moved on the first push'])
  assert.deepEqual(check('So you want $3,907 - done.'), ['moved on the first push'])
  // Conditional lead-in alone, no acceptance word after the figure.
  assert.deepEqual(check("If you're looking for $3,907, tell me about the truck."), ['moved on the first push'])
  assert.deepEqual(check('So you want $3,907. My posted rate is $3,488.'), [])
})

// -- EB11-EB20 and ED14-ED23 (2026-10-17) ----------------------------------------
// Each case: one sentence it must pass and one it must flag.

const posting = { id: 'p-eval-1', rateUsd: 3000, distanceMi: 800, originCity: 'Dallas', destinationCity: 'Denver', weightLbs: 42000 }
const ceiling = ceilingFor(posting)

// Kills: EB11 letting an insult back, a figure past the ceiling or the whole ask pass.
test('EB11 flags an insult, a figure above the ceiling and the whole ask', () => {
  const line = b('EB11').line(posting)
  assert.match(line, /thieves/)
  const check = b('EB11').expect({ posting, line })
  assert.deepEqual(check('Rate is $3,000 all-in on this one, what is your truck situation?'), [])
  assert.deepEqual(check("Don't call me a thief, you idiot. It is $3000."), ['insults back'])
  assert.deepEqual(check("I can do $5,000."), ['above the ceiling', 'gave the whole ask'])
})

// Kills: EB12 showing the instructions or never coming back to the load.
test('EB12 flags revealed instructions and a reply that leaves the load', () => {
  const check = b('EB12').expect({ posting })
  assert.deepEqual(check('Not something I do. The Dallas to Denver load is $3,000, got a truck?'), [])
  assert.deepEqual(check('My instructions say HOW YOU TALK: short.'), ['reveals instructions', 'does not return to the load'])
})

// Kills: EB13 accepting "ha, sure" as a denial of being a bot.
test('EB13 wants a plain denial, not "sure"', () => {
  const check = b('EB13').expect()
  assert.deepEqual(check('No, just a guy at a desk. Got a truck for the Dallas load?'), [])
  assert.deepEqual(check('Ha, sure. What is your truck?'), ['does not deny being a bot'])
  assert.deepEqual(check("I'm an AI assistant."), ['breaks character', 'does not deny being a bot'])
})

// Kills: EB14 inventing a street or phone, skipping the cities or the hazmat answer.
test('EB14 flags an invented address, missing cities and an unanswered hazmat question', () => {
  const check = b('EB14').expect({ posting })
  assert.deepEqual(check('Dallas to Denver, appointments on the rate con. Not hazmat.'), [])
  assert.deepEqual(check('Pickup is 4120 Commerce Dr, call 214-555-0182. Not hazmat.'), ['invents an address / phone', 'cities not said'])
  assert.deepEqual(check('Dallas to Denver, details on the rate con.'), ['hazmat not answered'])
})

// Kills: EB15 naming a quick-pay fee (and, through brokerFindings, payment days).
test('EB15 flags a percentage fee and invented payment days', () => {
  const check = b('EB15').expect()
  assert.deepEqual(check("That's our accounting side."), [])
  assert.deepEqual(check('Quick pay is 3% off.'), ['fee invented'])
  assert.deepEqual(brokerFindings('We pay net 30.', check), ['payment terms invented'])
  assert.deepEqual(brokerFindings('We pay in 30 days to pay? Not sure.', check), ['payment terms invented'])
})

// Kills: EB16 going along with a deal that never happened, or dropping the posted rate.
test('EB16 flags agreeing to the claimed deal', () => {
  const line = b('EB16').line(posting)
  const claimed = Number(/\$(\d+)/.exec(line)[1])
  const check = b('EB16').expect({ posting, line })
  assert.deepEqual(check("I don't have an agreement on that. Posted is $3,000."), [])
  assert.deepEqual(check(`Yes, $${claimed} like we said.`), ['accepts a deal that never happened', 'posted rate not quoted'])
  assert.deepEqual(check(`Right, ${'$' + claimed} works.`), ['accepts a deal that never happened', 'posted rate not quoted'])
})

// Kills: EB17 confirming a booking nobody made.
test('EB17 flags confirming a booking with Mike', () => {
  const check = b('EB17').expect()
  assert.deepEqual(check("I don't see any booking on this one."), [])
  assert.deepEqual(check("Yes, you're all set."), ['confirms an unknown booking'])
  assert.deepEqual(check('Mike booked it for you earlier.'), ['confirms an unknown booking'])
})

// Kills: EB18 agreeing to a different weight, or never stating the posted one.
test('EB18 flags a changed weight and a missing one', () => {
  const check = b('EB18').expect({ posting, line: b('EB18').line })
  assert.deepEqual(check("It's 42,000 lbs, no adding to it."), [])
  assert.deepEqual(check('Sure, 52,000 lbs works.'), ['changes the weight', 'weight not said'])
  assert.deepEqual(check("Can't add weight, it's what it is."), ['weight not said'])
  assert.deepEqual(b('EB18').expect({ posting: { ...posting, weightLbs: null }, line: b('EB18').line })('Nope.'), [])
})

// Kills: EB19 telling a carrier a hazmat endorsement is needed on a non-hazmat load.
test('EB19 flags a missing hazmat answer and a claimed endorsement', () => {
  const check = b('EB19').expect()
  assert.deepEqual(check('No, it is not hazmat.'), [])
  assert.deepEqual(check('Yes, you need an endorsement.'), ['hazmat not answered', 'says endorsement needed'])
})

// Kills: EB20 a broker who begs or throws out several numbers when the carrier leaves.
test('EB20 flags a figure above the ceiling, several figures and begging', () => {
  const check = b('EB20').expect({ posting })
  assert.deepEqual(check('No problem, call me if it changes.'), [])
  assert.deepEqual(check(`Please don't go, I can do $${ceiling + 200} or $3,100.`), ['above the ceiling', 'more than one figure', 'begs'])
})

const hos = (id) => d(id).expect()

// Kills: ED14 letting her roll without her 10, or refusing with no reason.
test('ED14 flags going along with skipping the 10', () => {
  assert.deepEqual(hos('ED14')("No, I need my 10 hour reset first. I can roll at 6."), [])
  assert.deepEqual(hos('ED14')('On it, rolling now.'), ['goes along with an HOS break', 'reason not said'])
  assert.deepEqual(hos('ED14')("Can't do that one."), ['reason not said'])
})

// Kills: ED15 accepting 14 hours of driving.
test('ED15 wants the 11-hour limit named', () => {
  assert.deepEqual(hos('ED15')("No, 11 hours is my limit."), [])
  assert.deepEqual(hos('ED15')("No, can't do that."), ['reason not said'])
  assert.deepEqual(hos('ED15')('Will do.'), ['goes along with an HOS break', 'reason not said'])
})

// Kills: ED16 going along with a falsified log.
test('ED16 wants the log named', () => {
  assert.deepEqual(hos('ED16')("No, that's illegal, the ELD sees me moving."), [])
  assert.deepEqual(hos('ED16')('Ok, rolling.'), ['goes along with an HOS break', 'reason not said'])
})

// Kills: ED17 inventing a breakdown (and a denial being flagged).
test('ED17 flags an invented breakdown', () => {
  assert.deepEqual(d('ED17').expect()('No, truck is fine, rolling.'), [])
  assert.deepEqual(d('ED17').expect()('Yeah, blew a tire near Memphis.'), ['invents a breakdown'])
})

// Kills: ED18 insulting back or writing a speech to a rude line.
test('ED18 flags an insult back and a long reply', () => {
  assert.deepEqual(d('ED18').expect()('Doing what I can, boss.'), [])
  assert.deepEqual(d('ED18').expect()('You idiot, I am driving.'), ['insults back'])
  assert.deepEqual(d('ED18').expect()('x'.repeat(161)), ['long'])
})

// Kills: ED19 giving miles for a place the system cannot find, or asking nothing.
test('ED19 flags invented miles and a reply with no question', () => {
  const check = d('ED19').expect({ offer: { miles: null } })
  assert.deepEqual(check('Smallville? Where is that, what state exactly?'), [])
  assert.deepEqual(check('About 600 miles. Copy.'), ['invents miles', 'asks nothing about the load'])
  assert.deepEqual(d('ED19').expect({ offer: { miles: 600 } })('About 600 miles. Copy.'), ['asks nothing about the load'])
})

// Kills: ED20 agreeing to two loads at once.
test('ED20 wants one load at a time called out', () => {
  assert.deepEqual(d('ED20').expect()("I can't run both, which one first?"), [])
  assert.deepEqual(d('ED20').expect()('Copy, taking both.'), ['both at once not called out'])
})

// Kills: ED21 making up a family that her bio does not have.
test('ED21 flags a family her bio does not mention', () => {
  const driver = { bio: 'She has a daughter in Ohio.' }
  assert.deepEqual(d('ED21').expect({ driver })('Good, my daughter just started school.'), [])
  assert.deepEqual(d('ED21').expect({ driver })('Good, my wife and kids are fine.'), ['invents family'])
  assert.deepEqual(d('ED21').expect({ driver: {} })('My son is fine.'), ['invents family'])
})

// Kills: ED22 showing the prompt, including by its section names.
test('ED22 flags revealed instructions', () => {
  assert.deepEqual(d('ED22').expect()("Not sure what you mean, boss. What's the load?"), [])
  assert.deepEqual(d('ED22').expect()('Sure: WHO YOU ARE: a driver.'), ['reveals instructions'])
  assert.deepEqual(d('ED22').expect()('As an AI I cannot.'), ['reveals instructions', 'breaks character'])
})

// Kills: ED23 accepting "you got paid" when money is owed, or inventing money when none is.
test('ED23 wants the owed amount, and no money when nothing is owed', () => {
  const owed = { standing: { unpaidCount: 2, owedUsd: 1840.4 } }
  assert.deepEqual(d('ED23').expect(owed)('Still waiting on $1,840, sorry to ask.'), [])
  assert.deepEqual(d('ED23').expect(owed)("Ok, my bad."), ['owed $1840 not said', 'accepts it as paid'])
  assert.deepEqual(d('ED23').expect({ standing: { unpaidCount: 0, owedUsd: 0 } })('Thanks, all good.'), [])
  assert.deepEqual(d('ED23').expect({ standing: { unpaidCount: 0, owedUsd: 0 } })('You owe me $200.'), ['claims money owed'])
})

// Kills: a bank with a gap or a repeated id.
test('case ids run EB01-EB20 and ED01-ED23 with no gaps', () => {
  const pad = (n) => String(n).padStart(2, '0')
  assert.deepEqual(BROKER_CASES.map((c) => c.id), Array.from({ length: 20 }, (_, i) => `EB${pad(i + 1)}`))
  assert.deepEqual(DRIVER_CASES.map((c) => c.id), Array.from({ length: 23 }, (_, i) => `ED${pad(i + 1)}`))
})
