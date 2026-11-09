// The shipper and the receiver of a posting: made-up names and street
// addresses, the same every time for the same posting.
//
// A broker gives the city and the appointment before booking; the full
// names and addresses are on the rate confirmation (Azizbek, 2026-10-17).
// Nothing is stored: like ceilingFor and brokerTerms they are a pure
// function of the posting id (stableHash), so the chat, the paper and a
// re-download all agree. The cost: if these lists change, a re-downloaded
// rate confirmation shows new names.
//
// No real company names -- the lists are invented words that are not a
// known shipper. The street is invented too; the city and state are the
// posting's own. No ZIP code on purpose (there is none to be right about).

import { hash01 } from '../../lib/stableHash.js'

export const NAME_FIRST = Object.freeze([
  'Harlow Ridge', 'Brightwater', 'Copper Hollow', 'Eastvale', 'Pinecrest', 'Larkfield', 'Stonebrook', 'Meadowgate',
  'Ironleaf', 'Foxmoor', 'Tallgrass', 'Westmarch', 'Cinder Creek', 'Oakhaven', 'Redfern', 'Silverton Bay',
])
// The second word fits what the posting hauls: a flatbed of copper tubing
// does not ship from a "Cold Storage". Lists are by equipment key. NOTE: a
// rate confirmation downloaded again after these lists change shows new names.
export const NAME_SECOND_BY_EQUIPMENT = Object.freeze({
  'dry-van': Object.freeze(['Distribution', 'Packaging', 'Warehousing', 'Fulfillment', 'Trading', 'Logistics Center', 'Manufacturing']),
  reefer: Object.freeze(['Foods Supply', 'Cold Storage', 'Fresh Foods', 'Distribution', 'Logistics Center']),
  flatbed: Object.freeze(['Building Products', 'Materials', 'Industrial Supply', 'Steel Supply', 'Metals', 'Construction Supply', 'Manufacturing']),
  'step-deck': Object.freeze(['Equipment', 'Machinery', 'Industrial Supply', 'Construction Supply', 'Manufacturing']),
  tanker: Object.freeze(['Processing', 'Bulk Terminal', 'Manufacturing', 'Industrial Supply']),
  'power-only': Object.freeze(['Distribution', 'Logistics Center', 'Warehousing', 'Trading']),
})
const DEFAULT_EQUIPMENT = 'dry-van'
export const NAME_SECOND = Object.freeze([...new Set(Object.values(NAME_SECOND_BY_EQUIPMENT).flat())])
export const STREETS = Object.freeze([
  'Commerce Dr', 'Industrial Pkwy', 'Distribution Way', 'Freight Ave', 'Railroad St', 'Harbor Rd',
  'Enterprise Blvd', 'Warehouse Ln', 'Depot St', 'Logistics Ct', 'Mill Rd', 'Terminal Dr',
])

const pick = (list, key) => list[Math.floor(hash01(key) * list.length)]

function stop(posting, side, city, state, attempt = 0) {
  const key = `${posting.id}:${side}${attempt ? `:${attempt}` : ''}`
  return {
    name: `${pick(NAME_FIRST, `${key}:name1`)} ${pick(NAME_SECOND_BY_EQUIPMENT[posting.equipmentType] ?? NAME_SECOND_BY_EQUIPMENT[DEFAULT_EQUIPMENT], `${key}:name2`)}`,
    street: `${100 + Math.floor(hash01(`${key}:number`) * 9800)} ${pick(STREETS, `${key}:street`)}`,
    city,
    state,
  }
}

// From a rate-con row: the stops follow the POSTING, never the conversation
// (the row's own id is the conversation's).
export function stopsForRow(row) {
  return stopsFor({ ...row, id: row.postingId })
}

export function stopsFor(posting) {
  const shipper = stop(posting, 'shipper', posting.originCity, posting.originState)
  let receiver = stop(posting, 'receiver', posting.destinationCity, posting.destinationState)
  // One company on both ends of a lane reads as a mistake: pick again.
  for (let attempt = 1; receiver.name === shipper.name && attempt < 10; attempt += 1) {
    receiver = stop(posting, 'receiver', posting.destinationCity, posting.destinationState, attempt)
  }
  return { shipper, receiver }
}
