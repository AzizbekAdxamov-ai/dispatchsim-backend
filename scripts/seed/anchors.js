// Fixed rows the AI never generates and the build stage never drops.
//
// The frontend's Loads/Dashboard/Chat mocks (frontend/src/data/mockData.js)
// still hardcode links like "Load #4472" and alert/chat entries keyed to
// specific driver names -- if the seeded DB doesn't contain a row with
// that exact id, those links 404 as "Load not found". These anchors keep
// those ids alive across every re-generation.
//
// Each anchor is shaped like an AI-produced LoadItem/DriverItem (see
// schemas.js) PLUS the fields a real row needs that the AI schema
// doesn't carry (id, status/dutyStatus) -- so the build stage can push
// anchors and AI rows through the same insert path without a special
// case. Distances, dates and dollar rates are deliberately left out:
// those are computed downstream from origin/destination and the current
// run's clock, the same as for AI-generated rows. `ratePerMile` here is
// only a suggestion for that computation, inside the $1.80-$3.20 band
// (loads_rpm_band in migration 007 would reject the real historical
// mock rate for #4471, which is why the mock's own $6.56/mi is not
// reused here).
//
// Origin/destination/broker/equipmentType/status values are copied
// verbatim from frontend/src/data/mockData.js `loads`; `commodity` is
// not present in that mock (the mock never modeled it) and is filled in
// here with something consistent with each load's equipment type.
export const ANCHOR_LOADS = [
  {
    id: '4468',
    originCity: 'Seattle',
    originState: 'WA',
    destinationCity: 'Portland',
    destinationState: 'OR',
    broker: 'Coyote Logistics',
    commodity: 'Construction equipment',
    equipmentType: 'step-deck',
    weightLbs: 14600,
    status: 'done',
    ratePerMile: 2.2,
  },
  {
    id: '4471',
    originCity: 'Dallas',
    originState: 'TX',
    destinationCity: 'Memphis',
    destinationState: 'TN',
    broker: 'XPO Logistics',
    commodity: 'Packaged consumer goods',
    equipmentType: 'dry-van',
    weightLbs: 28700,
    status: 'ontime',
    ratePerMile: 2.85,
  },
  {
    id: '4472',
    originCity: 'Atlanta',
    originState: 'GA',
    destinationCity: 'Orlando',
    destinationState: 'FL',
    broker: 'Coyote Logistics',
    commodity: 'Fresh produce',
    equipmentType: 'reefer',
    weightLbs: 22100,
    status: 'warn',
    ratePerMile: 2.95,
  },
  {
    id: '4473',
    originCity: 'Chicago',
    originState: 'IL',
    destinationCity: 'Detroit',
    destinationState: 'MI',
    broker: 'TQL',
    commodity: 'Industrial chemicals',
    equipmentType: 'tanker',
    weightLbs: 19400,
    status: 'crit',
    ratePerMile: 3.05,
  },
  {
    id: '4474',
    originCity: 'Phoenix',
    originState: 'AZ',
    destinationCity: 'Denver',
    destinationState: 'CO',
    broker: 'Landstar',
    commodity: 'Steel coils',
    equipmentType: 'flatbed',
    weightLbs: 31200,
    status: 'ontime',
    ratePerMile: 2.6,
  },
  {
    id: '4475',
    originCity: 'Houston',
    originState: 'TX',
    destinationCity: 'New Orleans',
    destinationState: 'LA',
    broker: 'XPO Logistics',
    commodity: 'General freight',
    equipmentType: 'dry-van',
    weightLbs: 17850,
    status: 'neutral',
    ratePerMile: 2.4,
  },
]

// The five named drivers frontend/src/data/mockData.js `loads` and
// fleetData.js `trucks` both reference by name (Marcus Webb, Elena
// Petrova, Devon Carter, Raj Malhotra, James Kim) -- one per anchor load
// above (minus #4475, which the mock leaves unassigned: driver: null).
// Ids follow migration 005's `drivers_id_format` CHECK ('d1', 'd23', ...).
//
// homeBaseCity/State and cdlClass come from each driver's mock CDL string
// ("CDL-A · TX-88421" etc). phone/email don't exist in the old mock (it
// only ever stored a CDL string) so they're filled in here: phone uses
// the NANP-reserved 555 exchange, email uses the IANA-reserved
// example.com domain -- both intentionally fake, not real contact info.
// `dutyStatus` mirrors migration 005's duty_status CHECK
// ('driving'|'on-duty'|'resting'|'off'), inferred from each driver's
// in-progress load in the mock; James Kim's load (#4468) is already
// delivered, so he's on-duty rather than driving.
export const ANCHOR_DRIVERS = [
  {
    id: 'd1',
    fullName: 'Marcus Webb',
    phone: '214-555-0142',
    email: 'marcus.webb@example.com',
    homeBaseCity: 'Dallas',
    homeBaseState: 'TX',
    cdlClass: 'A',
    dutyStatus: 'driving',
  },
  {
    id: 'd2',
    fullName: 'Elena Petrova',
    phone: '404-555-0198',
    email: 'elena.petrova@example.com',
    homeBaseCity: 'Atlanta',
    homeBaseState: 'GA',
    cdlClass: 'A',
    dutyStatus: 'driving',
  },
  {
    id: 'd3',
    fullName: 'Devon Carter',
    phone: '312-555-0167',
    email: 'devon.carter@example.com',
    homeBaseCity: 'Chicago',
    homeBaseState: 'IL',
    cdlClass: 'A',
    dutyStatus: 'driving',
  },
  {
    id: 'd4',
    fullName: 'Raj Malhotra',
    phone: '602-555-0123',
    email: 'raj.malhotra@example.com',
    homeBaseCity: 'Phoenix',
    homeBaseState: 'AZ',
    cdlClass: 'A',
    dutyStatus: 'driving',
  },
  {
    id: 'd5',
    fullName: 'James Kim',
    phone: '206-555-0184',
    email: 'james.kim@example.com',
    homeBaseCity: 'Seattle',
    homeBaseState: 'WA',
    cdlClass: 'A',
    dutyStatus: 'on-duty',
  },
]
