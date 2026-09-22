// The words. Not the numbers.
//
// This file exists because of what an audit of the generator found: of the
// nine fields the model was asked for on every load, EIGHT were either
// picked from a closed list the prompt already contained, or a number the
// code clamped into a band it already knew. validate.js computes the rate
// band from equipment and distance and then overwrites whatever the model
// guessed. The model's contribution to a posting was one field --
// `commodity` -- and the price of that field was twenty-four network calls
// per refresh, four retries each, and a Groq daily quota emptied during an
// ordinary day of development.
//
// So the vocabulary lives here, as data, and the numbers are derived. The
// model can still WRITE this file -- see scripts/refresh-vocabulary.js --
// but it writes it once and thousands of postings are built from it. A
// generator that cannot run because a provider is rate-limited is not a
// generator.
//
// Everything below is invented or generic. No real carrier, dealer or
// person is named: the app attaches credit ratings, payment behaviour and
// safety records to these, and doing that to a real business or a real
// person would mean publishing false and damaging facts about them.

import { readFileSync } from 'node:fs'
import { validateVocabulary } from './vocabularySchema.js'

// ---------------------------------------------------------------------
// Commodities, by what actually hauls them
// ---------------------------------------------------------------------
//
// Keyed by equipment because the pairing is the realistic part. Frozen
// fish does not ride on a flatbed, and structural steel does not ride in
// a reefer. A student who learns "reefer means temperature-controlled
// freight" has learned something true.
const BUILT_IN_COMMODITIES = Object.freeze({
  'dry-van': [
    'Palletized canned goods', 'Boxed consumer electronics', 'Paper products',
    'Bottled water', 'Packaged snack foods', 'Household cleaning supplies',
    'Apparel in cartons', 'Pet food', 'Disposable tableware', 'Office furniture',
    'Cardboard packaging stock', 'Small appliances', 'Bagged coffee',
    'Printed books', 'Automotive parts in cases', 'Toys and games',
    'Paint in sealed pails', 'Bottled soft drinks', 'Personal care products',
    'Air filters',
    // Dry van is 45% of EQUIPMENT_MIX -- more than twice reefer's share --
    // and shipped with the same twenty entries reefer had. On a board of
    // 60 that is 27 dry-van loads drawing from 20 words, so a repeat was
    // not bad luck, it was division. vocabularySchema.js derives the
    // minimum from the mix and caught it.
    'Bottled juice', 'Laundry detergent', 'Bagged flour',
    'Breakfast cereal cases', 'Mattresses in cartons', 'Floor tile in cartons',
    'Bagged charcoal', 'Hand tools in cases', 'Bottled sauces', 'Carpet rolls',
  ],
  reefer: [
    'Fresh lettuce', 'Frozen french fries', 'Dairy — milk and cream',
    'Boxed strawberries', 'Frozen poultry', 'Cheese blocks', 'Fresh cut flowers',
    'Ice cream', 'Refrigerated dough', 'Bagged salad mix', 'Frozen seafood',
    'Yogurt cases', 'Fresh citrus', 'Chilled beef primals', 'Table grapes',
    'Frozen vegetables', 'Eggs in flats', 'Deli meats', 'Fresh berries',
    'Temperature-controlled pharmaceuticals',
  ],
  flatbed: [
    'Structural steel beams', 'Bundled lumber', 'Concrete pipe',
    'Aluminum coil', 'Roofing shingles', 'Steel rebar', 'Drywall sheets',
    'Granite slabs', 'Baled scrap metal', 'Pipe racks', 'Cinder block',
    'Utility poles', 'Fencing panels', 'Steel plate', 'Copper tubing',
    'Prefabricated wall panels', 'Bagged cement', 'Rolled insulation',
    'Landscaping stone', 'Guardrail sections',
  ],
  'step-deck': [
    'Excavator with attachments', 'Skid steer loader', 'Farm tractor',
    'Industrial generator', 'Air compressor unit', 'Boom lift',
    'Transformer housing', 'Baled hay', 'Modular office unit',
    'Rolling mill components', 'Crane counterweights', 'Trencher',
    'Sawmill equipment', 'Road roller', 'Conveyor sections',
    'Wind turbine hub', 'Storage tank shell', 'Forklift',
    'Paving machine', 'Steel coil on cradles',
  ],
  tanker: [
    'Food-grade vegetable oil', 'Liquid sweetener', 'Non-hazardous latex',
    'Bulk milk', 'Industrial water treatment fluid', 'Liquid fertilizer',
    'Molasses', 'Deionized water', 'Glycerin', 'Liquid soap base',
    'Corn syrup', 'Wine in bulk', 'Liquid animal feed supplement',
    'Sodium hydroxide solution', 'Antifreeze concentrate',
  ],
  'power-only': [
    'Preloaded dry-van trailer', 'Drop trailer relay', 'Loaded reefer trailer',
    'Customer trailer repositioning', 'Preloaded flatbed with tarps',
    'Sealed trailer — contents undeclared', 'Warehouse trailer shuttle',
  ],
})

// ---------------------------------------------------------------------
// People
// ---------------------------------------------------------------------
//
// Two pools crossed rather than a list of whole names: 60 x 60 is 3,600
// combinations, which is far more than the 20 applicants a day this
// generates and enough that a student does not see the same driver twice
// in a week. Deliberately broad in origin, because US trucking is.
const BUILT_IN_FIRST_NAMES = Object.freeze([
  'Marcus', 'Dwayne', 'Travis', 'Curtis', 'Wesley', 'Darnell', 'Terrance',
  'Miguel', 'Jesus', 'Ramon', 'Ernesto', 'Rafael', 'Hector', 'Alejandro',
  'Dmitri', 'Sergei', 'Yuri', 'Viktor', 'Oleg', 'Ivan',
  'Amrit', 'Gurpreet', 'Harjit', 'Balwinder', 'Jaspreet', 'Manjit',
  'Ahmed', 'Yusuf', 'Omar', 'Tariq', 'Bilal', 'Karim',
  'Dale', 'Wayne', 'Randy', 'Chuck', 'Lonnie', 'Roy', 'Earl', 'Buddy',
  'Tyler', 'Cody', 'Dustin', 'Brandon', 'Shane', 'Colt',
  'Linda', 'Sandra', 'Denise', 'Roberta', 'Yolanda', 'Tanya',
  'Nikolai', 'Pavel', 'Andriy', 'Taras',
  'Samuel', 'Joseph', 'Anthony', 'Vincent',
])

const BUILT_IN_LAST_NAMES = Object.freeze([
  'Webb', 'Hollis', 'Rutherford', 'Whitaker', 'Carver', 'Blaylock',
  'Dandridge', 'Tolliver', 'Stallworth', 'Pettigrew', 'Boykin', 'Hargrove',
  'Salazar', 'Delgado', 'Quintero', 'Escobedo', 'Vasquez', 'Cardenas',
  'Volkov', 'Petrov', 'Sokolov', 'Morozov', 'Kuznetsov', 'Orlov',
  'Sandhu', 'Grewal', 'Dhillon', 'Bajwa', 'Sekhon', 'Randhawa',
  'Haddad', 'Nasser', 'Farouk', 'Mansour', 'Rashid', 'Khalil',
  'Buchanan', 'Prescott', 'Ashworth', 'Fairbanks', 'Cordray', 'Lockhart',
  'Mullins', 'Yarborough', 'Kirkland', 'Hensley', 'Crenshaw', 'Rowland',
  'Okafor', 'Adeyemi', 'Mensah', 'Nwosu',
  'Vukovic', 'Novak', 'Horvat', 'Kovac',
  'Nguyen', 'Tran', 'Pham', 'Vo',
])

// ---------------------------------------------------------------------
// Truck market
// ---------------------------------------------------------------------
//
// Real manufacturers and real model lines: these are the trucks, and
// calling a Peterbilt something else would teach a student a wrong fact
// about the equipment they are supposed to learn. Nothing here says
// anything about the manufacturers themselves. Kept in sync with the
// engine table in src/constants/truckSpecs.js, which keys engines by make.
export const TRUCK_MODELS = Object.freeze({
  Freightliner: ['Cascadia', 'Cascadia Evolution', 'Columbia', 'M2 112'],
  Peterbilt: ['579', '389', '567', '520'],
  Kenworth: ['T680', 'W900', 'T880', 'T800'],
  Volvo: ['VNL 760', 'VNL 860', 'VNL 300', 'VNR 640'],
  'Western Star': ['4900', '5700XE', '49X', '47X'],
  International: ['LT625', 'ProStar', 'LoneStar', 'HX520'],
  Mack: ['Anthem', 'Pinnacle', 'Granite', 'CH613'],
})

export const TRUCK_MAKES = Object.freeze(Object.keys(TRUCK_MODELS))

// Invented dealer names. A real dealership does not get an invented
// asking price and an invented service history attached to it.
const BUILT_IN_SELLERS = Object.freeze([
  'Ridgeline Truck Sales', 'Copper Creek Equipment', 'Midstate Fleet Outlet',
  'Halverson Commercial Trucks', 'Broad River Truck Center',
  'Ironhorse Used Trucks', 'Sable Ridge Fleet Sales', 'Kettle Valley Trucks',
  'Northline Equipment Co', 'Gulfport Truck Exchange',
  'Prairie Star Commercial', 'Anvil Road Truck Sales',
])

// Service-history fragments, combined at generation time. Written as
// observations rather than judgements: a listing states what was done to
// the truck, and the student decides what that is worth.
const BUILT_IN_SERVICE_NOTES = Object.freeze([
  'Full service records available',
  'New drive tires at last inspection',
  'DPF cleaned and inspected',
  'Recent in-frame overhaul',
  'Aftertreatment serviced',
  'Clutch replaced under previous owner',
  'Air dryer and compressor replaced',
  'Fifth wheel rebuilt',
  'No accident history reported',
  'Single owner since new',
  'Regional haul only, no mountain grades',
  'Turbo replaced at 480k',
  'Radiator and charge air cooler replaced',
  'Steer tires near new',
  'Annual DOT inspection current',
  'Minor cosmetic damage to bumper',
  'Interior shows normal wear',
  'Recent alignment and brake service',
])

// ---------------------------------------------------------------------
// Facilities (migration 035) -- fuel stops, truck stops, rest areas and
// repair shops placed along cached road geometry by
// scripts/generate-facilities.js. Only two lists live here (rest_area
// names are structural, built from the nearest city -- see
// scripts/seed/facilities.js's restAreaName()) -- fuel and truck_stop
// share TRUCK_STOP_NAMES.
//
// Every name here is invented. REAL BRAND NAMES ARE NOT ALLOWED --
// see BANNED_TRUCK_STOP_BRANDS (validate.js) and
// vocabularySchema.js's WRITABLE.TRUCK_STOP_NAMES/REPAIR_SHOP_NAMES
// bannedExtra check: Pilot, Flying J, Love's, TA, TravelCenters, Petro,
// QuikTrip, Buc-ee's, Sapp Bros and Roady's are real companies, and
// attaching a fabricated price or service history to one of their names
// would be publishing a false, damaging fact about a real business (the
// same rule 013_brokers.sql states for brokers).
//
// Sized at 30 each -- above MAX_STOPS_PER_ROUTE (facilities.js: 27, the
// worst case for the longest cached route landing entirely on one kind),
// so scripts/generate-facilities.js's per-route pickUnusedName() never
// has to repeat a name on any route this project's schema allows.
//
// MAX_STOPS_PER_ROUTE moved from 21 to 27 when hosClock.js's fix to
// DAILY_DRIVE_MI (facilities.js: 770mi off the wrong legal number down
// to 605mi, the real 11-hour driving limit) shrank SPACING_MI with it --
// a denser corridor means MORE stops fit on the same 4000mi ceiling, so
// six names were added to each list to clear the new floor with the same
// margin the original 24 held over the old one.
const BUILT_IN_TRUCK_STOP_NAMES = Object.freeze([
  'Cedar Ridge Travel Plaza', 'Blue Mesa Fuel Stop', 'Prairie Wind Truck Stop',
  'Redwood Crossing Fuel Center', "Sunbelt Traveler's Stop", 'Overland Fuel & Travel',
  'Copper Creek Truck Plaza', 'Granite Pass Fuel Stop', 'Silver Spur Travel Center',
  'Northgate Fuel Plaza', 'Timberline Truck Stop', 'Highline Fuel & Service',
  'Eastbound Traveler Stop', 'Ironwood Fuel Depot', 'Sagebrush Truck Plaza',
  'Milestone Fuel Center', 'Broken Wheel Truck Stop', 'Longhaul Fuel & Rest',
  'Crossroads Fuel Plaza', 'Amber Valley Truck Stop', 'Westline Fuel Depot',
  'Stonegate Travel Plaza', 'Coyote Bend Fuel Stop', 'Wayfarer Truck Plaza',
  'Meadowlark Fuel & Travel', 'Palisade Truck Plaza', 'Driftwood Fuel Stop',
  'Bearclaw Travel Center', 'Sundown Truck & Fuel', 'Whistlestop Fuel Plaza',
])

const BUILT_IN_REPAIR_SHOP_NAMES = Object.freeze([
  'Ironhorse Diesel Repair', 'Redline Truck Service', 'Big Sky Diesel & Repair',
  'Roadside Fleet Repair', 'Anchor Point Truck Service', 'Steel Bridge Diesel Shop',
  'Highway Star Repair', 'Granite Creek Truck Repair', 'Norwood Diesel Service',
  'Trailhead Truck & Trailer Repair', 'Copperline Fleet Service', 'Overpass Diesel Repair',
  'Riverside Truck Service Center', 'Northbound Repair & Tire', 'Timber Fork Diesel Shop',
  'Wayside Truck Repair', 'Stonebridge Fleet Repair', 'Ridgeline Diesel & Trailer',
  'Crosscut Truck Service', 'Longview Repair Depot', 'Amber Creek Diesel Shop',
  'Sable Point Truck Repair', 'Westbound Fleet Service', 'Millstone Diesel Repair',
  'Farview Diesel & Trailer', 'Bluffside Truck Service', 'Hollowpine Fleet Repair',
  'Cinderpost Diesel Shop', 'Rimrock Truck Repair', 'Eastfork Fleet & Tire',
])

// ---------------------------------------------------------------------
// The generated overlay
// ---------------------------------------------------------------------
//
// scripts/refresh-vocabulary.js can write vocabulary.generated.json. When
// that file is present AND passes vocabularySchema.js whole, its lists
// replace the built-in ones above. When it is absent, the built-ins are
// used. When it is present and fails, the built-ins are used AND the
// reason is printed -- a vocabulary that quietly did not load is a board
// that quietly did not change, and the person who generated it would
// spend an afternoon looking at the wrong thing.
//
// Nothing here calls a model. The generation path stays free of the
// network; the only thing that ever talks to Groq is the refresh script,
// run on purpose, writing a file a human can read before it is used.

const OVERLAY_PATH = new URL('./vocabulary.generated.json', import.meta.url)

function loadOverlay() {
  let text
  try {
    text = readFileSync(OVERLAY_PATH, 'utf8')
  } catch (err) {
    // Absent is the normal state, not a problem worth a line of output.
    if (err.code === 'ENOENT') return null
    console.error(`[vocabulary] vocabulary.generated.json o'qilmadi: ${err.message}`)
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    console.error(`[vocabulary] vocabulary.generated.json buzuq JSON: ${err.message}`)
    console.error('[vocabulary] ichki lug\'at ishlatilyapti')
    return null
  }

  const { ok, errors, vocabulary } = validateVocabulary(parsed.vocabulary ?? parsed)
  if (!ok) {
    console.error(`[vocabulary] vocabulary.generated.json rad etildi (${errors.length} ta xato):`)
    for (const e of errors.slice(0, 12)) console.error(`  - ${e}`)
    if (errors.length > 12) console.error(`  ... yana ${errors.length - 12} ta`)
    console.error('[vocabulary] ichki lug\'at ishlatilyapti')
    return null
  }

  const generatedAt = parsed.generatedAt ? ` (${parsed.generatedAt})` : ''
  console.log(`[vocabulary] generatsiya qilingan lug'at yuklandi${generatedAt}`)
  return vocabulary
}

const OVERLAY = loadOverlay()

// Which source each list came from. Exported so a test can assert that a
// run used the built-ins, and so scripts can say which vocabulary a board
// was built from instead of leaving it to be guessed.
export const VOCABULARY_SOURCE = Object.freeze(OVERLAY ? 'generated' : 'built-in')

export const COMMODITIES = Object.freeze(OVERLAY?.COMMODITIES ?? BUILT_IN_COMMODITIES)
export const FIRST_NAMES = Object.freeze(OVERLAY?.FIRST_NAMES ?? BUILT_IN_FIRST_NAMES)
export const LAST_NAMES = Object.freeze(OVERLAY?.LAST_NAMES ?? BUILT_IN_LAST_NAMES)
export const SELLERS = Object.freeze(OVERLAY?.SELLERS ?? BUILT_IN_SELLERS)
export const SERVICE_NOTES = Object.freeze(OVERLAY?.SERVICE_NOTES ?? BUILT_IN_SERVICE_NOTES)
export const TRUCK_STOP_NAMES = Object.freeze(OVERLAY?.TRUCK_STOP_NAMES ?? BUILT_IN_TRUCK_STOP_NAMES)
export const REPAIR_SHOP_NAMES = Object.freeze(OVERLAY?.REPAIR_SHOP_NAMES ?? BUILT_IN_REPAIR_SHOP_NAMES)

// The built-ins stay exported so the schema can be checked against them:
// test/vocabulary.test.js asserts that what ships satisfies the rules a
// generated file has to satisfy. A rule the built-in vocabulary fails is
// a rule no model could have met either.
export const BUILT_IN = Object.freeze({
  COMMODITIES: BUILT_IN_COMMODITIES,
  FIRST_NAMES: BUILT_IN_FIRST_NAMES,
  LAST_NAMES: BUILT_IN_LAST_NAMES,
  SELLERS: BUILT_IN_SELLERS,
  SERVICE_NOTES: BUILT_IN_SERVICE_NOTES,
  TRUCK_STOP_NAMES: BUILT_IN_TRUCK_STOP_NAMES,
  REPAIR_SHOP_NAMES: BUILT_IN_REPAIR_SHOP_NAMES,
})
