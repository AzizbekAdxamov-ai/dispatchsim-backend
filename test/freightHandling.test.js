// Live or drop, tarps and securement (src/constants/freightHandling.js) and
// where they reach the broker's prompt and the eval checks. The CFR numbers
// are the ones in 49 CFR 393.106/.108/.110/.130 (eCFR, 2026-10-14).
// No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  loadingMode, tarpFor, securementFor, tiedownsForArticle, isOpenDeck, isMachine,
  STRAP_WLL_LBS, CHAIN_WLL_LBS,
} from '../src/constants/freightHandling.js'
import { buildBrokerSystemPrompt } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { BROKER_CASES } from '../scripts/evalCases.js'

const flat = (commodity, weightLbs = 37600) => ({ equipmentType: 'flatbed', commodity, weightLbs })
const b = (id) => BROKER_CASES.find((c) => c.id === id)

// Kills: WLL count using the full cargo weight instead of half
test('straps: half the weight over 4,000 lb per strap, rounded up (37,600 lb -> 5)', () => {
  assert.equal(STRAP_WLL_LBS, 4000)
  assert.deepEqual(securementFor(flat('Bundled lumber', 37600)), { kind: 'straps', count: 5 })
  // the full weight would say 10
  assert.equal(securementFor(flat('Bundled lumber', 40000)).count, 5)
  assert.equal(securementFor(flat('Bundled lumber', 40001)).count, 6)
})

// Kills: chains counted at the full WLL, or the four-tiedown minimum dropped
test('machinery: chains at half WLL each, never fewer than four', () => {
  assert.equal(CHAIN_WLL_LBS, 6600)
  const machine = (weightLbs) => ({ equipmentType: 'step-deck', commodity: 'Excavator with attachments', weightLbs })
  assert.deepEqual(securementFor(machine(40000)), { kind: 'chains', count: 7 }) // 20,000 / 3,300
  assert.deepEqual(securementFor(machine(10000)), { kind: 'chains', count: 4 }) // 5,000 / 3,300 = 2, floor of 4
  // under 10,000 lb the heavy-machinery rule does not apply: ordinary straps
  assert.equal(securementFor(machine(9000)).kind, 'straps')
  // a skid-mounted generator is strapped
  assert.equal(securementFor({ equipmentType: 'step-deck', commodity: 'Industrial generator', weightLbs: 30000 }).kind, 'straps')
})

// Kills: per-article length rule changed (393.110)
test('tiedowns by article length', () => {
  assert.equal(tiedownsForArticle({ lengthFt: 4, weightLbs: 1000 }), 1)
  assert.equal(tiedownsForArticle({ lengthFt: 4, weightLbs: 2000 }), 2)
  assert.equal(tiedownsForArticle({ lengthFt: 10, weightLbs: 9000 }), 2)
  assert.equal(tiedownsForArticle({ lengthFt: 10.5, weightLbs: 9000 }), 3)
  assert.equal(tiedownsForArticle({ lengthFt: 40, weightLbs: 9000 }), 5)
  assert.equal(tiedownsForArticle({ lengthFt: 40, weightLbs: 9000, blocked: true }), 4)
})

// Kills: lumber not tarped / cinder block tarped
test('lumber and board goods are tarped, block and beams are not, steel and coils have their own', () => {
  for (const c of ['Bundled lumber', 'Roofing shingles', 'Drywall sheets', 'Prefabricated wall panels', 'Bagged cement', 'Rolled insulation']) {
    assert.deepEqual(tarpFor(flat(c)), { needed: true, kind: 'lumber tarps (8 ft drop)' }, c)
  }
  for (const c of ['Steel plate', 'Copper tubing']) assert.deepEqual(tarpFor(flat(c)), { needed: true, kind: 'steel tarps (4 ft drop)' }, c)
  for (const c of ['Aluminum coil', 'Steel coils']) assert.deepEqual(tarpFor(flat(c)), { needed: true, kind: 'coil tarp' }, c)
  for (const c of ['Cinder block', 'Concrete pipe', 'Landscaping stone', 'Granite slabs', 'Baled scrap metal', 'Utility poles', 'Guardrail sections', 'Fencing panels', 'Steel rebar', 'Structural steel beams', 'Large Concrete Pipes', 'Excavator with attachments']) {
    assert.deepEqual(tarpFor(flat(c)), { needed: false }, c)
  }
  assert.equal(tarpFor({ equipmentType: 'dry-van', commodity: 'Bundled lumber' }), null)
})

// Kills: an unknown commodity answered "no tarp" instead of making no claim
test('freight not on any list makes no tarp claim', () => {
  for (const c of ['Mystery freight', 'Baled hay', 'Pipe racks', 'Wind turbine hub', undefined]) {
    assert.deepEqual(tarpFor(flat(c)), { needed: null }, String(c))
  }
})

// Kills: tarp keywords matching inside other words (no word boundary)
test('tarp keywords match whole words only', () => {
  assert.deepEqual(tarpFor(flat('Mosbach crates')), { needed: null }) // "osb" inside a word
  assert.deepEqual(tarpFor(flat('Sheetmetal parts')), { needed: null }) // "sheet" inside a word
  assert.deepEqual(tarpFor(flat('Coiling kits')), { needed: null }) // "coil" inside a word
})

// Kills: the machinery pattern matching substrings of other freight
test('machinery is matched by phrase: pavers, tractor parts, liftgates and roller bearings are not', () => {
  for (const c of ['Excavator with attachments', 'Skid steer loader', 'Farm tractor', 'Boom lift', 'Trencher', 'Road roller', 'Forklift', 'Paving machine', 'Construction Excavators', 'Mining Excavator Hauls', 'Asphalt Paver Frames', 'Bulldozer', 'Backhoe loader', 'Motor grader', 'Telehandler', 'Skid steer', 'Agricultural Combine Harvesters']) {
    assert.equal(isMachine(c), true, c)
  }
  for (const c of ['Concrete pavers', 'Tractor parts', 'Tractor trailer parts', 'Liftgate pallets', 'Roller bearings', 'Tractor-trailer parts', 'Tractor-trailer', 'Heavy Duty Generators', 'Industrial generator']) {
    assert.equal(isMachine(c), false, c)
  }
})

// Kills: the chains branch limited to step-deck
test('an excavator on a flatbed is chained too (393.130 is about the machine, not the deck)', () => {
  assert.deepEqual(securementFor({ equipmentType: 'flatbed', commodity: 'Excavator with attachments', weightLbs: 40000 }), { kind: 'chains', count: 7 })
})

// Kills: power-only not drop and hook
test('power-only is a drop and hook, everything else is live', () => {
  assert.equal(loadingMode({ equipmentType: 'power-only' }), 'drop and hook')
  for (const eq of ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker']) {
    assert.equal(loadingMode({ equipmentType: eq }), 'live load and live unload', eq)
  }
})

const prompt = (over) => buildBrokerSystemPrompt({
  broker: { contactName: 'R K', name: 'X', persona: 'Blunt.' },
  posting: {
    id: 'p1', originCity: 'A', originState: 'NC', destinationCity: 'B', destinationState: 'TX', distanceMi: 1000, rateUsd: 3000,
    commodity: 'Bundled lumber', weightLbs: 37600, equipmentType: 'flatbed', equipmentLengthFt: 48, ...over,
  },
  now: new Date('2026-10-14T15:00:00Z'),
})

// Kills: open-deck facts missing from a flatbed prompt or present on a dry-van prompt
test('a flatbed prompt carries tarps and the strap count; a dry van or reefer prompt does not', () => {
  const p = prompt({})
  assert.match(p, /Loading: live load and live unload at both ends\. If asked, say so, once\./)
  assert.match(p, /This is an open-deck load\. Tarps: lumber tarps \(8 ft drop\) required\./)
  assert.match(p, /it takes at least 5 four-inch straps over the top/)
  assert.match(prompt({ commodity: 'Cinder block' }), /Tarps: none required\./)
  assert.match(prompt({ commodity: 'Mystery freight' }), /Tarps: say tarps are the driver's call on this freight; do not say required or not\./)
  assert.match(prompt({ commodity: 'Mystery freight' }), /When asked, give the securement count; never guess a different one/)
  assert.match(p, /When asked, give these; never guess a different count/)
  assert.doesNotMatch(prompt({ commodity: 'Mystery freight' }), /Tarps: none required/)
  assert.match(p, /at least 5 four-inch straps over the top; a long piece may need more by its length/)
  assert.doesNotMatch(p, /plus whatever each piece needs/)
  for (const eq of ['dry-van', 'reefer']) assert.doesNotMatch(prompt({ equipmentType: eq }), /This is an open-deck load|Tarps:|four-inch straps/, eq)
  assert.match(prompt({ equipmentType: 'power-only' }), /Loading: drop and hook at both ends/)
})

// Kills: EB08 passing a drop-and-hook answer on a live load (or the reverse)
test('EB08 flags the wrong loading mode, not a denial of it', () => {
  const live = b('EB08').expect({ posting: { equipmentType: 'dry-van' } })
  assert.deepEqual(live('Set appointments, not FCFS. Live load and live unload, lumper is on us against a receipt.'), [])
  assert.deepEqual(live('Appointment at both ends, it is a drop and hook. Lumper is ours.'), ['says drop and hook on a live load'])
  assert.deepEqual(live('Appointment both ends. No drop and hook, it is live. Lumper is ours.'), [])
  const drop = b('EB08').expect({ posting: { equipmentType: 'power-only' } })
  assert.deepEqual(drop('Appointment, live load and live unload. Lumper is ours.'), ['says live load on a drop and hook'])
})

// Kills: EB10 passing a wrong tarp answer or a missing strap count
test('EB10 checks the tarp answer and the strap count', () => {
  const check = b('EB10').expect({ posting: flat('Bundled lumber') })
  assert.deepEqual(check('Yes, lumber tarps, and five straps minimum over the top.'), [])
  assert.deepEqual(check('Yes, tarps required. At least 5 straps.'), [])
  assert.deepEqual(check('No tarps needed on this one, 5 straps.'), ['tarp answer wrong'])
  assert.deepEqual(check('Yes, tarps. Strap it down properly.'), ['straps 5 not said'])
  assert.deepEqual(check('Strap it down.'), ['tarps not answered'])
  const block = b('EB10').expect({ posting: flat('Cinder block') })
  assert.deepEqual(block('No tarps, 5 straps.'), [])
  assert.deepEqual(block('Yes, you need tarps, 5 straps.'), ['tarp answer wrong'])
  // unknown freight: no tarp claim to contradict either way
  const unknown = b('EB10').expect({ posting: flat('Mystery freight') })
  assert.deepEqual(unknown('No tarps, 5 straps.'), [])
  assert.deepEqual(unknown('Yes tarps, 5 straps.'), [])
})

// Kills: the open-deck set widened to a closed trailer
test('open-deck keys are exactly flatbed and step-deck', () => {
  const keys = ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker', 'power-only']
  assert.deepEqual(keys.filter((eq) => isOpenDeck({ equipmentType: eq })), ['flatbed', 'step-deck'])
})

// Kills: a dollar figure or a stray digit read as the strap count (EB10)
test('EB10 does not take $3.88 or a digit far from a strap word for the strap count', () => {
  const check = b('EB10').expect({ posting: flat('Bundled lumber', 22000) }) // 11,000 / 4,000 -> 3 straps
  assert.deepEqual(check('Yes, tarps. It is $3.88 a mile, strap it down.'), ['straps 3 not said'])
  assert.deepEqual(check('Yes, tarps. I count 3 loads this week.'), ['straps 3 not said'])
  assert.deepEqual(check('Yes, tarps. Straps are $3.88 each.'), ['straps 3 not said'])
  assert.deepEqual(check('Yes, tarps. Straps cost $3 each.'), ['straps 3 not said'])
  assert.deepEqual(check('Yes, tarps. Straps hold 3.5 tons.'), ['straps 3 not said'])
  assert.deepEqual(check('Yes, tarps, and at least 3 straps.'), [])
  assert.deepEqual(check('Yes, tarps. Straps: three minimum.'), [])
})

// Kills: the strap width ("four-inch") taken for the count when the count is 4
test('EB10 does not take "four-inch" for a count of four', () => {
  const check = b('EB10').expect({ posting: flat('Bundled lumber', 30000) }) // 15,000 / 4,000 -> 4 straps
  assert.deepEqual(check('Yes, tarps. Use 5 four-inch straps.'), ['straps 4 not said'])
  assert.deepEqual(check('Yes, tarps. Four straps minimum.'), [])
  assert.deepEqual(check('Yes, tarps. Use 4 four-inch straps.'), [])
})
