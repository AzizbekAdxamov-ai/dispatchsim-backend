// Spec sheet for a used Class-8 tractor, derived from what the listing
// already says.
//
// NOTHING here is asked of the model. The seed generator produces make,
// model, year, odometer, price, trailer type and tyres; everything below
// follows from those. Three reasons:
//
//   1. A language model picking an engine for a 2010 Western Star gets it
//      wrong often enough to be noticed, and a wrong engine on a spec
//      sheet is worse than no engine.
//   2. Every field the model must produce is another way a row fails
//      validation and gets dropped. These cost nothing and never fail.
//   3. Derived means consistent: the same truck shows the same specs to
//      every student, on every page, forever.
//
// Each field earns its place by changing a decision. A day cab cannot run
// a two-day lane. A 40,000 lb rear axle decides whether 44,000 lbs of
// grain is legal. A manual gearbox narrows who you can hire for it. The
// ones that only decorate -- seat material, cabinet count, wood grain
// dash -- are left out on purpose.

// Engines by manufacturer. A truck maker fits its own engine or the one
// it has always offered, not an arbitrary pick.
const ENGINES = {
  Freightliner: [['Detroit', 'DD13', [410, 470]], ['Detroit', 'DD15', [455, 505]]],
  'Western Star': [['Detroit', 'DD15', [455, 505]], ['Detroit', 'DD16', [500, 600]]],
  Kenworth: [['PACCAR', 'MX-13', [405, 510]], ['Cummins', 'X15', [400, 565]]],
  Peterbilt: [['PACCAR', 'MX-13', [405, 510]], ['Cummins', 'X15', [400, 565]]],
  Volvo: [['Volvo', 'D13', [375, 500]], ['Volvo', 'D11', [325, 425]]],
  Mack: [['Mack', 'MP8', [415, 505]], ['Mack', 'MP7', [325, 405]]],
  International: [['Cummins', 'X15', [400, 565]], ['International', 'A26', [370, 500]]],
}
const DEFAULT_ENGINE = [['Cummins', 'X15', [400, 565]]]

// Automated gearboxes took over through the 2010s. An older truck is far
// more likely to be a manual, and a manual is harder to staff -- which is
// the point of showing it.
const TRANSMISSIONS = {
  'manual-10': '10-speed manual',
  'manual-13': '13-speed manual',
  'automated-12': '12-speed automated',
}

const SLEEPERS = {
  'day-cab': 'Day cab',
  'sleeper-72': '72" raised roof sleeper',
  'sleeper-82': '82" raised roof sleeper',
}

const SUSPENSIONS = { 'air-ride': 'Air ride', spring: 'Spring' }

// A synthetic manufacturer prefix. Real VINs begin with a World
// Manufacturer Identifier issued to an actual company (Western Star's is
// 5KJ), so generating one of those would be minting an identifier that
// could belong to a real truck on a real road. "DSM" belongs to nobody:
// the number reads like a VIN, is unique inside the simulator, and can
// never collide with a vehicle that exists.
const VIN_PREFIX = 'DSM'
// I, O and Q are excluded from real VINs to avoid confusion with 1 and 0.
const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)]
}

function between(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

// 17 characters exactly, like the real thing: 3 prefix + 8 body + 2 year
// + 4 serial. Getting the length wrong is the one detail anyone who works
// with trucks would spot immediately.
export function makeVin(rng, year) {
  let body = ''
  for (let i = 0; i < 8; i += 1) body += VIN_ALPHABET[Math.floor(rng() * VIN_ALPHABET.length)]
  return `${VIN_PREFIX}${body}${String(year).slice(-2)}${between(rng, 1000, 9999)}`
}

// Older trucks skew manual, newer skew automated. Not a hard rule --
// plenty of 2020 tractors are still 13-speeds.
function transmissionFor(rng, year) {
  const automatedChance = year >= 2018 ? 0.7 : year >= 2014 ? 0.45 : 0.15
  if (rng() < automatedChance) return 'automated-12'
  return rng() < 0.6 ? 'manual-13' : 'manual-10'
}

// A day cab cannot sleep a driver, so it cannot run a lane that takes more
// than a shift. Power-only and local work is where they belong.
function sleeperFor(rng, trailerType) {
  const dayCabChance = trailerType === 'power-only' ? 0.45 : 0.15
  if (rng() < dayCabChance) return 'day-cab'
  return rng() < 0.5 ? 'sleeper-72' : 'sleeper-82'
}

export function buildSpecs({ make, year, trailerType, rng }) {
  const [engineMake, engineModel, hpRange] = pick(rng, ENGINES[make] ?? DEFAULT_ENGINE)
  const transmission = transmissionFor(rng, year)
  const sleeper = sleeperFor(rng, trailerType)

  // A sleeper needs a longer frame than a day cab.
  const wheelbaseIn = sleeper === 'day-cab' ? between(rng, 176, 220) : between(rng, 228, 264)

  // Rear axle rating decides what the truck may legally haul. 40,000 lb
  // tandems are the norm; a 46,000 lb axle is heavy-haul spec and costs
  // fuel to run empty.
  const rearAxleLbs = rng() < 0.85 ? 40000 : 46000
  const frontAxleLbs = rearAxleLbs === 46000 ? 20000 : between(rng, 12000, 14600)

  return {
    vin: makeVin(rng, year),
    engineMake,
    engineModel,
    horsepower: between(rng, hpRange[0], hpRange[1]),
    transmission,
    sleeper,
    suspension: rng() < 0.9 ? 'air-ride' : 'spring',
    axleConfig: rng() < 0.92 ? '6x4' : '6x2',
    wheelbaseIn,
    frontAxleLbs,
    rearAxleLbs,
    gvwrLbs: frontAxleLbs + rearAxleLbs,
    // An auxiliary power unit runs the cab without idling the engine.
    // Real money on a sleeper, pointless on a day cab.
    hasApu: sleeper !== 'day-cab' && rng() < (year >= 2016 ? 0.45 : 0.2),
  }
}

export const TRANSMISSION_LABEL = TRANSMISSIONS
export const SLEEPER_LABEL = SLEEPERS
export const SUSPENSION_LABEL = SUSPENSIONS
export const TRANSMISSION_KEYS = Object.keys(TRANSMISSIONS)
export const SLEEPER_KEYS = Object.keys(SLEEPERS)
export const SUSPENSION_KEYS = Object.keys(SUSPENSIONS)
