// The words the board is built from, and the rules a generated vocabulary
// has to satisfy before it is allowed to replace them.
//
// The model writes this file once and thousands of postings are built from
// it. That is the point and also the risk: a bad word in a list of twenty
// commodities is not one bad posting, it is every posting on that
// equipment type, all day. So the rules are checked here, and the first
// thing checked is that the vocabulary which SHIPS satisfies them -- a
// rule the built-in data fails is a rule no model could have met either,
// and the first version of this schema had exactly that defect.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BUILT_IN, VOCABULARY_SOURCE, TRUCK_MODELS, TRUCK_MAKES,
  COMMODITIES, FIRST_NAMES, LAST_NAMES, SELLERS, SERVICE_NOTES,
  TRUCK_STOP_NAMES, REPAIR_SHOP_NAMES,
} from '../scripts/seed/vocabulary.js'
import {
  validateVocabulary, normalizeVocabulary, WRITABLE, FIXED, COMMODITY_MIN,
  NAME_PAIRS_MIN, SERVICE_NOTE_MAX_CHARS,
} from '../scripts/seed/vocabularySchema.js'
import {
  EQUIPMENT_MIX, POSTING_CONFIG, APPLICANT_CONFIG,
  SERVICE_NOTE_DRAW, SERVICE_NOTES_FIELD_MAX,
} from '../scripts/seed/marketTargets.js'
import { TruckListingItem } from '../scripts/seed/schemas.js'
import { BANNED, BANNED_WORDS } from '../scripts/seed/validate.js'
import { EQUIPMENT_KEYS } from '../src/constants/equipment.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(join(here, '..', p), 'utf8')

// A vocabulary that passes, to mutate one field of at a time. Built from
// what ships, so a test that breaks one rule is not also breaking five
// others by accident.
function valid() {
  return JSON.parse(JSON.stringify(BUILT_IN))
}

test('the vocabulary that ships satisfies the rules a generated one must', () => {
  const { ok, errors } = validateVocabulary(BUILT_IN)
  assert.deepEqual(errors, [], 'ichki lug\'at o\'z qoidalaridan o\'tmadi')
  assert.ok(ok)
})

test('a list is long enough that a full board need not repeat', () => {
  // The rule is arithmetic, not taste: if an equipment type shows N loads
  // at once and has fewer than N commodities, a repeat is guaranteed.
  const total = EQUIPMENT_MIX.reduce((sum, [, w]) => sum + w, 0)
  for (const [eq, weight] of EQUIPMENT_MIX) {
    const simultaneous = Math.ceil((POSTING_CONFIG.visibleTarget * weight) / total)
    assert.equal(COMMODITY_MIN[eq], simultaneous, `${eq}: minimum board'dan kelib chiqmagan`)
    assert.ok(BUILT_IN.COMMODITIES[eq].length >= simultaneous,
      `${eq}: ${BUILT_IN.COMMODITIES[eq].length} ta, bir vaqtda ${simultaneous} ta yuk ko'rinadi`)
  }
})

test('the minimums are derived, not typed in', () => {
  // The defect this catches: someone writing `min: 16` because it looks
  // generous. The first version of this schema did exactly that, and the
  // shipped power-only list of 7 failed it.
  const text = src('scripts/seed/vocabularySchema.js')
  assert.match(text, /EQUIPMENT_MIX/, 'board tarkibi ishlatilmagan')
  assert.match(text, /POSTING_CONFIG\.visibleTarget/, 'ko\'rinadigan son ishlatilmagan')

  // Comments stripped first. The claim is about the code: the file
  // DESCRIBES the `min: 16` it used to have, and a check that cannot tell
  // a comment from a declaration fails on the sentence explaining the fix.
  const code = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /min: \d+/, 'qo\'lda yozilgan minimum qaytib kelgan')
})

test('enough name pairs that a day of applicants does not keep colliding', () => {
  // Birthday bound: k draws from N pairs collide about k²/2N times. One a
  // day is the standard, so N >= poolTarget² / 2.
  const pairs = BUILT_IN.FIRST_NAMES.length * BUILT_IN.LAST_NAMES.length
  assert.equal(NAME_PAIRS_MIN, Math.ceil((APPLICANT_CONFIG.poolTarget ** 2) / 2))
  assert.ok(pairs >= NAME_PAIRS_MIN, `${pairs} ta juftlik, kamida ${NAME_PAIRS_MIN} kerak`)
})

test('the lists the model may not write are named, with truck models among them', () => {
  // Real manufacturers and real model lines. A model inventing
  // "Peterbilt 999" teaches a wrong fact about the equipment this app
  // exists to teach, and the makes are keyed to an engine table.
  assert.ok(FIXED.includes('TRUCK_MODELS'))
  assert.ok(FIXED.includes('BROKERS'))
  for (const name of FIXED) assert.ok(!(name in WRITABLE), `${name} ikkala ro'yxatda ham bor`)
  assert.deepEqual(TRUCK_MAKES, Object.keys(TRUCK_MODELS))
})

test('a generated file that touches a fixed list is refused', () => {
  const v = valid()
  v.TRUCK_MODELS = { Peterbilt: ['999'] }
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('TRUCK_MODELS')), errors.join('; '))
})

test('a commodity under two equipment types is refused', () => {
  // Freight does not cross trailers. A commodity under both reefer and
  // flatbed means the model listed freight instead of pairing it, and the
  // pairing is what the student is here to learn.
  const v = valid()
  v.COMMODITIES.flatbed = [...v.COMMODITIES.flatbed, v.COMMODITIES.reefer[0]]
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('reefer') && e.includes('flatbed')), errors.join('; '))
})

test('the same word twice does not count as a longer list', () => {
  const v = valid()
  v.SELLERS = [...v.SELLERS.slice(0, -1), v.SELLERS[0].toUpperCase()]
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('takrorlangan')), errors.join('; '))
})

test('a banned word anywhere rejects the whole file', () => {
  const v = valid()
  v.SERVICE_NOTES = [...v.SERVICE_NOTES, 'Brake test completed']
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('taqiqlangan')), errors.join('; '))
})

test('a missing equipment type is refused rather than left empty', () => {
  // An equipment type with no commodities is not an error anywhere
  // downstream -- it is a board with no flatbed freight, which reads as
  // nobody hauling flatbed that day.
  const v = valid()
  delete v.COMMODITIES.flatbed
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.ok(errors.some((e) => e.includes('flatbed')), errors.join('; '))
  assert.equal(Object.keys(BUILT_IN.COMMODITIES).sort().join(), [...EQUIPMENT_KEYS].sort().join())
})

test('there is no partial acceptance', () => {
  // Half a vocabulary -- some lists generated, some fallen back -- is a
  // board that cannot be reproduced from either source.
  const v = valid()
  v.SELLERS = []
  const { ok, vocabulary } = validateVocabulary(v)
  assert.equal(ok, false)
  assert.equal(vocabulary, null, 'rad etilgan lug\'atdan qism qaytdi')
})

test('a rejected overlay is loud, not silent', () => {
  const text = src('scripts/seed/vocabulary.js')
  assert.match(text, /console\.error/, 'rad etish jimgina')
  assert.match(text, /rad etildi/, 'sabab aytilmayapti')
})

test('nothing on the generation path calls a model', () => {
  // The whole arrangement: the model writes a file, on purpose, once.
  // A refresh that needs a provider is a refresh that fails when the
  // provider is rate-limited, and an empty board then feeds the retry.
  for (const f of [
    'scripts/seed/vocabulary.js',
    'scripts/seed/generate.js',
    'scripts/refresh-postings.js',
  ]) {
    const text = src(f)
    assert.doesNotMatch(text, /aiClient|chatJson|chatText/, `${f} model chaqiryapti`)
  }
  // And the one script that does is the one that is supposed to.
  assert.match(src('scripts/refresh-vocabulary.js'), /chatJson/)
})

test('marketTargets imports nothing, so it cannot be in a cycle', () => {
  // vocabulary -> vocabularySchema -> generate -> vocabulary was a real
  // cycle: importing generate.js first threw "Cannot access EQUIPMENT_MIX
  // before initialization" while importing vocabulary.js first worked.
  // Whether the app started depended on import order.
  const text = src('scripts/seed/marketTargets.js')
  assert.doesNotMatch(text, /^\s*import\s/m, 'marketTargets.js import qilyapti')
})

test('whichever vocabulary is loaded, it satisfies the rules', () => {
  // This asserted VOCABULARY_SOURCE === 'built-in', which was true on the
  // machine it was written on and stopped being true the first time
  // anybody ran refresh:vocabulary. A test that fails because the feature
  // was used is testing the developer's directory, not the code.
  //
  // What actually has to hold is that the board is built from a
  // vocabulary that passes -- whichever one that is. vocabulary.js falls
  // back loudly when a generated file is rejected, so reaching here with
  // 'generated' means the file on disk was accepted.
  assert.ok(['built-in', 'generated'].includes(VOCABULARY_SOURCE),
    `noma'lum manba: ${VOCABULARY_SOURCE}`)

  const loaded = {
    COMMODITIES, FIRST_NAMES, LAST_NAMES, SELLERS, SERVICE_NOTES,
    TRUCK_STOP_NAMES, REPAIR_SHOP_NAMES,
  }
  const { ok, errors } = validateVocabulary(loaded)
  assert.deepEqual(errors, [], `yuklangan lug'at (${VOCABULARY_SOURCE}) qoidalardan o'tmadi`)
  assert.ok(ok)
})


// ---------------------------------------------------------------------
// What the first real generation run found
// ---------------------------------------------------------------------

test('the longest possible service-notes join fits the field', () => {
  // The silent cut: generateTruckListing joined up to three notes and then
  // .slice(0, 200) to fit the column, chopping a sentence mid-word on a
  // listing a student reads. The per-note limit is derived from the field
  // so the cut is unreachable -- this is the arithmetic that guarantees it.
  const worst = SERVICE_NOTE_MAX_CHARS * SERVICE_NOTE_DRAW[1]
    + '. '.length * (SERVICE_NOTE_DRAW[1] - 1)
  assert.ok(worst <= SERVICE_NOTES_FIELD_MAX,
    `eng uzun birikma ${worst} belgi, maydon ${SERVICE_NOTES_FIELD_MAX}`)
  // And one character more per note would not fit, so the limit is the
  // largest that works rather than a cautious guess well under it.
  const oneMore = (SERVICE_NOTE_MAX_CHARS + 1) * SERVICE_NOTE_DRAW[1]
    + '. '.length * (SERVICE_NOTE_DRAW[1] - 1)
  assert.ok(oneMore > SERVICE_NOTES_FIELD_MAX, 'chegara keragidan past olingan')
})

test('the field cap here is the one the schema actually enforces', () => {
  // SERVICE_NOTES_FIELD_MAX is written in marketTargets.js to keep that
  // module import-free. Two copies of a number drift; this is the check
  // that they have not.
  // Asked of the schema by behaviour rather than by reaching into zod's
  // internals: a note exactly at the cap is accepted and one character
  // more is not. Internals change between zod versions; what the schema
  // ACCEPTS is the thing that matters and the thing that stays stable.
  const base = {
    make: 'Kenworth', model: 'T680', year: 2019, odometerMi: 500000,
    trailerType: 'dry-van',
    tireFrontPct: 50, tireRearPct: 50, seller: 'Copper Creek Equipment',
  }
  const at = TruckListingItem.safeParse({ ...base, serviceNotes: 'a'.repeat(SERVICE_NOTES_FIELD_MAX) })
  const over = TruckListingItem.safeParse({ ...base, serviceNotes: 'a'.repeat(SERVICE_NOTES_FIELD_MAX + 1) })
  assert.equal(at.success, true, `sxema ${SERVICE_NOTES_FIELD_MAX} belgini qabul qilmadi`)
  assert.equal(over.success, false, `sxema ${SERVICE_NOTES_FIELD_MAX + 1} belgini qabul qildi`)
})

test('a service note can say sixty percent', () => {
  // The first generated batch was rejected over "Brake pads on all four
  // axles show 60% remaining material." A note that cannot carry a
  // percentage cannot carry the most ordinary thing a note says. The
  // character was missing from the allowed set, not from the sentence.
  const v = valid()
  v.SERVICE_NOTES = [...v.SERVICE_NOTES, 'Brake pads show 60% remaining']
  const { ok, errors } = validateVocabulary(v)
  assert.equal(ok, true, errors.join('; '))
})

test('a bad item is dropped, not paid for with the whole batch', () => {
  // The over-ask exists so bad items can be discarded. The first version
  // of this schema never discarded anything, so two real runs were thrown
  // away over a handful of long sentences and seven duplicate surnames --
  // with a hundred and thirty good names in the same response.
  const raw = {
    SELLERS: [
      ...BUILT_IN.SELLERS,
      'x'.repeat(200),                 // too long
      BUILT_IN.SELLERS[0],             // duplicate
      'Fine Motors Simulation Sales',  // banned word
    ],
  }
  const { vocabulary, dropped } = normalizeVocabulary(raw)
  assert.equal(vocabulary.SELLERS.length, BUILT_IN.SELLERS.length, 'yaxshi elementlar yo\'qoldi')
  assert.equal(dropped.length, 3)
  assert.deepEqual(dropped.map((d) => d.why).sort(),
    ['takrorlangan', "taqiqlangan so'z", '200 belgi, chegara 40'].sort())
})

test('normalizing keeps the first pairing and drops the second', () => {
  const raw = valid()
  raw.COMMODITIES.flatbed = [...raw.COMMODITIES.flatbed, raw.COMMODITIES.reefer[0]]
  const { vocabulary, dropped } = normalizeVocabulary(raw)
  assert.equal(vocabulary.COMMODITIES.reefer.includes(raw.COMMODITIES.reefer[0]), true,
    'birinchi juftlik saqlanmadi')
  assert.equal(vocabulary.COMMODITIES.flatbed.includes(raw.COMMODITIES.reefer[0]), false,
    'ikkinchi nusxa tashlanmadi')
  assert.ok(dropped.some((d) => d.why.includes('reefer')), JSON.stringify(dropped))
  // And what survives passes the gate.
  assert.equal(validateVocabulary(vocabulary).ok, true)
})

test('nothing is rewritten to make it fit', () => {
  // Shortening a note or renaming a driver would be inventing data and
  // attributing it to the model. Whatever survives is exactly what came
  // back, minus surrounding whitespace.
  const raw = { SELLERS: ['  Copper Creek Equipment  ', 'y'.repeat(200)] }
  const { vocabulary } = normalizeVocabulary(raw)
  assert.deepEqual(vocabulary.SELLERS, ['Copper Creek Equipment'])
})

test('every rule the checker enforces is a rule the prompt states', () => {
  // Two runs were rejected for limits the model was never told: a
  // character count and a banned-word list. A checker that enforces a
  // rule the prompt omits is measuring the prompt.
  const prompt = src('scripts/refresh-vocabulary.js')
  assert.match(prompt, /BANNED_WORDS\.join/, "taqiqlangan so'zlar promptga kirmayapti")
  assert.match(prompt, /maxChars/, 'uzunlik chegarasi promptga kirmayapti')
  // Derived, not retyped: a list written out by hand here would drift from
  // the one validate.js enforces.
  assert.doesNotMatch(prompt, new RegExp(`'${BANNED_WORDS[0]}'`),
    "taqiqlangan so'zlar qo'lda ko'chirilgan")
  assert.ok(BANNED.test(`a ${BANNED_WORDS[0]} here`))
})
