// Ask Groq for a new vocabulary, check it hard, write it to disk.
//
//   node scripts/refresh-vocabulary.js --dry-run    # show it, write nothing
//   node scripts/refresh-vocabulary.js              # write it
//
// This is the ONLY thing in the project that asks a model to produce seed
// data, and it is deliberately the only thing. The generator that builds
// postings, applicants and listings makes no network call at all: it reads
// words from a file and computes every number itself. That split is what
// went wrong before and what was fixed on 2026-09-12.
//
// The old arrangement asked the model for nine fields on every load, of
// which eight were "pick from this list I just gave you" or "a number
// between X and Y" that validate.js then overwrote anyway. It cost two
// dozen calls per refresh, it emptied a Groq daily quota during ordinary
// development, and when the calls failed the board stayed empty, which
// made the next restart try again. Failure fed the retry.
//
// Here the model does the one thing it is actually better at than a lookup
// table -- writing varied, plausible English -- once. One run produces a
// vocabulary that thousands of postings are built from, and a run that
// fails changes nothing, because the file is only replaced after it has
// passed every rule in vocabularySchema.js.
//
// What it may NOT write is in vocabularySchema.js: FIXED. Truck makes and
// models are real equipment, cities have coordinates, brokers carry credit
// ratings. Those are facts, not flavour.

import 'dotenv/config'
import { writeFileSync, readFileSync } from 'node:fs'
import { readAiConfig, sleep } from './seed/config.js'
import { chatJson } from './seed/aiClient.js'
import {
  validateVocabulary, normalizeVocabulary, WRITABLE, COMMODITY_MIN, FIXED,
} from './seed/vocabularySchema.js'
import { BANNED_WORDS } from './seed/validate.js'
import { EQUIPMENT_KEYS } from '../src/constants/equipment.js'

const OUT_PATH = new URL('./seed/vocabulary.generated.json', import.meta.url)
const DRY_RUN = process.argv.includes('--dry-run')

// Ask for more than the minimum. The minimum is what the board needs to
// avoid arithmetic repeats; asking for exactly that leaves no room for the
// checker to drop a duplicate or a banned word, and a batch one item short
// is a whole run rejected.
const OVER_ASK = 1.4
const overAsk = (n) => Math.ceil(n * OVER_ASK)

// Two instructions every prompt carries, both derived rather than typed.
//
// The first version of this script carried NEITHER, and both omissions
// showed up in the first real run on 2026-09-13: service notes came back
// at 80-105 characters against a 65-character rule, and four of them said
// "leak test" / "pressure tested" against a banned-word rule. The model
// had not been told either limit. A checker that rejects a batch for a
// rule the prompt never stated is measuring the prompt.
const BANNED_CLAUSE =
  `Never use any of these words, in any form: ${BANNED_WORDS.join(', ')}. `
  + 'This is a product rule, not a style preference.'

const lengthClause = (maxChars) =>
  `Every item must be at most ${maxChars} characters including spaces. `
  + 'Items longer than that are discarded, so keep them short rather than complete.'

// The system prompt as it is actually sent: what the list is, how long the
// items may be, and what may not appear in them.
const systemFor = (body, maxChars) => `${body} ${lengthClause(maxChars)} ${BANNED_CLAUSE}`

// One list per request. A single prompt for the whole vocabulary is one
// JSON object of several hundred strings: models truncate it, and the
// failure arrives as a parse error that says nothing about which list was
// the problem. Separate requests also mean a rejected list is re-asked
// alone rather than re-rolling everything that already passed.
const REQUESTS = [
  ...EQUIPMENT_KEYS.map((eq) => ({
    key: `COMMODITIES.${eq}`,
    want: overAsk(COMMODITY_MIN[eq]),
    maxChars: WRITABLE.COMMODITIES.maxChars,
    system:
      'You write freight commodity descriptions for a US trucking load board. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Each item is a short noun phrase naming what is on the trailer, 2 to 6 words, '
      + 'Title case, no punctuation except a comma or an em dash. '
      + 'No brand names and no company names.',
    user: (want) =>
      `Give ${want} distinct commodities that ship on a ${eq} trailer in the United States. `
      + `Every one must be freight that specifically suits a ${eq} and would not be hauled on `
      + 'a different trailer type. Vary the industries.',
  })),
  {
    key: 'FIRST_NAMES',
    want: overAsk(WRITABLE.FIRST_NAMES.min),
    maxChars: WRITABLE.FIRST_NAMES.maxChars,
    system:
      'You write given names for fictional US commercial truck drivers. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Each item is a single given name, no surname, no title, no initial.',
    user: (want) =>
      `Give ${want} distinct given names. US trucking draws from many origins -- include names `
      + 'common among American, Mexican, Punjabi, Eastern European, West African, Arab and '
      + 'Vietnamese communities in the industry. Include some names used by women. '
      + 'Do not name any real or well-known person.',
  },
  {
    key: 'LAST_NAMES',
    want: overAsk(WRITABLE.LAST_NAMES.min),
    maxChars: WRITABLE.LAST_NAMES.maxChars,
    system:
      'You write surnames for fictional US commercial truck drivers. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Each item is a single surname.',
    user: (want) =>
      `Give ${want} distinct surnames spanning the same range of origins found among US truck `
      + 'drivers. Do not use the surname of any real or well-known person.',
  },
  {
    key: 'SELLERS',
    want: overAsk(WRITABLE.SELLERS.min),
    maxChars: WRITABLE.SELLERS.maxChars,
    system:
      'You invent names for fictional used-truck dealerships in the United States. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Two to four words each, in the style of an independent regional dealer.',
    user: (want) =>
      `Invent ${want} distinct dealership names. They must be INVENTED: do not use the name of `
      + 'any dealership that exists. Avoid any name a real business is likely to already hold.',
  },
  {
    key: 'SERVICE_NOTES',
    want: overAsk(WRITABLE.SERVICE_NOTES.min),
    maxChars: WRITABLE.SERVICE_NOTES.maxChars,
    system:
      'You write single-line maintenance history notes for used commercial trucks. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Each item states a fact about what was done to the truck or what condition a part is '
      + 'in. State observations only. Never say whether the truck is a good or bad buy, never '
      + 'recommend, never warn.',
    user: (want) =>
      `Give ${want} distinct service-history notes a used truck listing might carry. `
      + 'Cover engine, aftertreatment, driveline, brakes, tires, and cosmetic condition. '
      + 'Write them the way a dealer writes a bullet point, not the way a mechanic writes '
      + 'an invoice line: "DPF cleaned and inspected", not "The diesel particulate filter '
      + 'was removed, cleaned and reinstalled at 412,000 miles." Percentages and fractions '
      + 'are fine.',
  },
  // Fictional truck-stop and repair-shop names for the facilities the
  // generator places along routes (scripts/seed/facilities.js). The real
  // chains are rejected by the schema's bannedExtra (BANNED_BRAND) -- the
  // prompt names that rule too, so fewer items are wasted on it.
  {
    key: 'TRUCK_STOP_NAMES',
    want: overAsk(WRITABLE.TRUCK_STOP_NAMES.min),
    maxChars: WRITABLE.TRUCK_STOP_NAMES.maxChars,
    system:
      'You invent names for fictional independent truck stops and travel plazas on US interstates. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Two to four words each, in the style of a regional independent stop.',
    user: (want) =>
      `Invent ${want} distinct truck-stop names. They must be INVENTED: never the name of a real `
      + 'truck-stop or travel-center chain (for example Pilot, Flying J, Love\'s, TA, Petro, '
      + 'QuikTrip, Buc-ee\'s, Sapp Bros, Roady\'s) or any business that exists.',
  },
  {
    key: 'REPAIR_SHOP_NAMES',
    want: overAsk(WRITABLE.REPAIR_SHOP_NAMES.min),
    maxChars: WRITABLE.REPAIR_SHOP_NAMES.maxChars,
    system:
      'You invent names for fictional independent heavy-truck repair shops in the United States. '
      + 'Reply with strict JSON only: {"items":[string]}. '
      + 'Two to four words each, in the style of a local diesel or fleet repair shop.',
    user: (want) =>
      `Invent ${want} distinct repair-shop names. They must be INVENTED: never the name of a real `
      + 'repair chain, dealer network or any business that exists.',
  },
]

const { config, errors } = readAiConfig({ prefix: 'AI' })
if (!config) {
  console.error('Lug\'at generatori ishga tushmadi:')
  for (const e of errors) console.error(`  - ${e}`)
  console.error('')
  console.error('AI_* Groq uchun. CHAT_* chat uchun -- bu ikkisi boshqa-boshqa.')
  process.exit(1)
}

console.log(`model: ${config.model}  @ ${config.baseUrl}`)
console.log(`${REQUESTS.length} ta so'rov, har biri ketma-ket (${config.requestSpacingMs}ms oralig'ida)\n`)

const collected = {}
const failed = []

for (const [i, req] of REQUESTS.entries()) {
  if (i > 0) await sleep(config.requestSpacingMs)
  process.stdout.write(`  ${req.key.padEnd(24)} `)
  try {
    const data = await chatJson({
      system: systemFor(req.system, req.maxChars),
      user: req.user(req.want),
      config,
    })
    const items = Array.isArray(data?.items) ? data.items : null
    if (!items) throw new Error('javobda items massivi yo\'q')
    collected[req.key] = items.map((v) => (typeof v === 'string' ? v.trim() : v))
    console.log(`${items.length} ta`)
  } catch (err) {
    console.log(`XATO — ${err.message}`)
    failed.push(req.key)
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length} ta so'rov muvaffaqiyatsiz: ${failed.join(', ')}`)
  console.error('Hech narsa yozilmadi — yarim lug\'at lug\'at emas.')
  process.exit(1)
}

// Reassemble into the shape vocabulary.js expects.
const vocabulary = { COMMODITIES: {} }
for (const [key, items] of Object.entries(collected)) {
  if (key.startsWith('COMMODITIES.')) vocabulary.COMMODITIES[key.slice('COMMODITIES.'.length)] = items
  else vocabulary[key] = items
}

// Drop what cannot be kept, then judge what is left. The over-ask above
// exists for exactly this: a batch is not lost to one long sentence.
const { vocabulary: cleaned, dropped } = normalizeVocabulary(vocabulary)

if (dropped.length > 0) {
  console.log(`\n${dropped.length} ta element tashlandi:`)
  const byReason = new Map()
  for (const d of dropped) byReason.set(d.why.replace(/\d+/g, 'N'), (byReason.get(d.why.replace(/\d+/g, 'N')) ?? 0) + 1)
  for (const [why, n] of byReason) console.log(`  ${String(n).padStart(3)} × ${why}`)
  // The first few in full, so a systematic problem is visible rather than
  // just counted. A prompt that is wrong produces the same drop N times.
  for (const d of dropped.slice(0, 5)) {
    console.log(`      ${d.where}: "${d.value.slice(0, 56)}" — ${d.why}`)
  }
}

const { ok, errors: vocabErrors } = validateVocabulary(cleaned)

console.log('')
if (!ok) {
  console.error(`Lug'at rad etildi (${vocabErrors.length} ta xato):`)
  for (const e of vocabErrors) console.error(`  - ${e}`)
  console.error('')
  console.error('Hech narsa yozilmadi — bu ro\'yxat darajasidagi xato, element tashlash bilan tuzalmaydi.')
  console.error('Qayta ishga tushiring, yoki modelni almashtiring.')
  process.exit(1)
}

for (const [eq, items] of Object.entries(cleaned.COMMODITIES)) {
  console.log(`  COMMODITIES.${eq.padEnd(12)} ${String(items.length).padStart(3)} ta  (kerak ${COMMODITY_MIN[eq]})`)
}
for (const key of ['FIRST_NAMES', 'LAST_NAMES', 'SELLERS', 'SERVICE_NOTES', 'TRUCK_STOP_NAMES', 'REPAIR_SHOP_NAMES']) {
  console.log(`  ${key.padEnd(24)} ${String(cleaned[key].length).padStart(3)} ta  (kerak ${WRITABLE[key].min})`)
}
console.log(`\n  o'zgarmaydigan ro'yxatlar (model yoza olmaydi): ${FIXED.join(', ')}`)

if (DRY_RUN) {
  console.log('\n--dry-run — fayl yozilmadi\n')
  process.exit(0)
}

// What was replaced, so a bad batch can be undone by hand.
let previous = null
try {
  previous = JSON.parse(readFileSync(OUT_PATH, 'utf8'))?.generatedAt ?? null
} catch { /* no previous file */ }

writeFileSync(OUT_PATH, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: config.model,
  baseUrl: config.baseUrl,
  vocabulary: cleaned,
}, null, 2)}\n`, 'utf8')

console.log(`\n  yozildi: scripts/seed/vocabulary.generated.json`)
if (previous) console.log(`  almashtirildi: ${previous}`)
console.log('  keyingi refresh:postings shu lug\'atdan quradi\n')
