// The shipper and receiver of a posting: invented, and the same every time.
// (src/modules/brokerChat/stops.js.) No database, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stopsFor, NAME_FIRST, NAME_SECOND, NAME_SECOND_BY_EQUIPMENT } from '../src/modules/brokerChat/stops.js'
import { EQUIPMENT_KEYS } from '../src/constants/equipment.js'

const posting = (id) => ({ id, originCity: 'Dallas', originState: 'TX', destinationCity: 'Chicago', destinationState: 'IL' })

// Kills: names that change between the chat and the rate con (random, not hashed)
test('the same posting id always gives the same stops', () => {
  assert.deepEqual(stopsFor(posting('p-1')), stopsFor(posting('p-1')))
})

// Kills: every posting getting the same shipper
test('different postings differ', () => {
  const names = new Set(Array.from({ length: 20 }, (_, i) => stopsFor(posting(`p-${i}`)).shipper.name))
  assert.ok(names.size > 5, `only ${names.size} distinct shippers in 20 postings`)
})

// Kills: the city taken from anywhere but the posting, or a ZIP invented
test('city and state come from the posting; no ZIP', () => {
  const { shipper, receiver } = stopsFor(posting('p-1'))
  assert.deepEqual([shipper.city, shipper.state], ['Dallas', 'TX'])
  assert.deepEqual([receiver.city, receiver.state], ['Chicago', 'IL'])
  assert.match(shipper.street, /^\d{3,4} [A-Z]/)
  assert.doesNotMatch(JSON.stringify(shipper), /\b\d{5}\b/)
})

// Kills: the same company at both ends of a lane
test('shipper and receiver are never the same company', () => {
  for (let i = 0; i < 300; i += 1) {
    const { shipper, receiver } = stopsFor(posting(`lane-${i}`))
    assert.notEqual(shipper.name, receiver.name, `lane-${i}`)
  }
})

// Kills: a real company name slipping into the invented lists
test('no name from a small denylist of real companies', () => {
  const real = /walmart|amazon|target|costco|kroger|home depot|lowe|pepsi|coca|nestle|tyson|sysco|ups|fedex|procter|unilever|kraft|general mills|conagra|dole|del monte|heinz|campbell/i
  for (const w of [...NAME_FIRST, ...NAME_SECOND]) assert.doesNotMatch(w, real, w)
})

const withEquipment = (id, equipmentType, commodity) => ({ ...posting(id), equipmentType, commodity })
const namesOf = (equipmentType, commodity) => Array.from({ length: 200 }, (_, i) => {
  const { shipper, receiver } = stopsFor(withEquipment(`eq-${i}`, equipmentType, commodity))
  return [shipper.name, receiver.name]
}).flat()

// Kills: one generic name list -- live: copper tubing flatbed shipped from "... Foods Supply" / "... Cold Storage"
test('a flatbed load never has a food or cold-storage shipper or receiver', () => {
  for (const name of namesOf('flatbed', 'Copper tubing')) assert.doesNotMatch(name, /Foods|Cold Storage/, name)
})

// Kills: the reefer list borrowing building or machinery words
test('a reefer load never has a building, steel or machinery name', () => {
  for (const name of namesOf('reefer', 'Frozen chicken')) assert.doesNotMatch(name, /Building Products|Steel|Machinery/, name)
})

// Kills: an equipment key with no list (new key falls to undefined names)
test('every equipment key has its own name list, and the combined list covers them', () => {
  for (const key of EQUIPMENT_KEYS) {
    assert.ok(NAME_SECOND_BY_EQUIPMENT[key]?.length > 0, key)
    for (const word of NAME_SECOND_BY_EQUIPMENT[key]) assert.ok(NAME_SECOND.includes(word), word)
  }
})
