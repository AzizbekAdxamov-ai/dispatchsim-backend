// How big each market is, and what the load board is made of.
//
// This module imports NOTHING, on purpose.
//
// These numbers were spread across postings.js, applicants.js, trucks.js
// and generate.js -- which is where they are used, and would be the right
// place if nothing else needed them. Then vocabularySchema.js had to
// derive its minimum list lengths from the board mix and the visible
// targets, and importing those four files created a cycle:
//
//   vocabulary.js -> vocabularySchema.js -> generate.js -> vocabulary.js
//
// ESM does not refuse a cycle; it half-evaluates it. Importing generate.js
// first failed with "Cannot access 'EQUIPMENT_MIX' before initialization",
// while importing vocabulary.js first worked -- so whether the app started
// depended on which file was named first, which is the kind of bug that
// passes every test until the day an import is reordered.
//
// A module with no imports cannot be in a cycle. The files below still
// export these under their old names, so nothing outside this directory
// had to change.

// Daily volume, simultaneous visibility, and how long a day's pool has to
// last. coverageHours is 26 rather than 24 so a cron that slips by an hour
// does not leave the board empty while it waits.
export const POSTING_CONFIG = Object.freeze({
  poolTarget: 600,      // kuniga generatsiya qilinadigan e'lon
  visibleTarget: 60,    // bir vaqtda board'da ko'rinishi kerak
  coverageHours: 26,    // pool qancha vaqtni qoplaydi (cron 24s + 2s zaxira)
})

export const APPLICANT_CONFIG = Object.freeze({
  poolTarget: 50,       // kuniga generatsiya
  visibleTarget: 15,    // bir vaqtda bozorda ko'rinadigani
  coverageHours: 26,    // cron 24s + 2s zaxira
})

export const TRUCK_CONFIG = Object.freeze({
  poolTarget: 20,       // kuniga generatsiya
  visibleTarget: 12,    // bir vaqtda bozorda
  coverageHours: 26,    // cron 24s + 2s zaxira
})

// The mix on a real board. Dry van is most of it; power-only is a niche.
// vocabularySchema.js divides visibleTarget by this to work out how many
// commodities each equipment type needs before repeats become arithmetic
// rather than bad luck.
export const EQUIPMENT_MIX = Object.freeze([
  ['dry-van', 45], ['reefer', 20], ['flatbed', 18],
  ['step-deck', 7], ['tanker', 6], ['power-only', 4],
])

// How many distinct service notes a listing carries. generateTruckListing
// refuses to repeat a note within one listing, so a SERVICE_NOTES list
// shorter than the upper bound here never terminates.
export const SERVICE_NOTE_DRAW = Object.freeze([1, 3])

// What the truck_listings.service_notes field accepts, as schemas.js
// declares it: z.string().min(3).max(200). Written here so
// vocabularySchema.js can derive a per-note length from it without
// importing schemas.js and putting this module back in a cycle.
// test/vocabulary.test.js asserts the two numbers still agree.
export const SERVICE_NOTES_FIELD_MAX = 200
