// Run the SAME broker conversation against several models and print the
// replies side by side, so the model is chosen by how it sounds rather than
// by how its spec sheet reads.
//
//   node scripts/chat-compare.js
//   node scripts/chat-compare.js "2.10 is the best I can do, take it or leave it"
//
// A one-word probe ("say ok") tells you almost nothing about voice. This
// sends the real system prompt, a real posting, and a real carrier line.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { chatConfigFor } from '../src/modules/chat/chatProvider.js'
import { chatText } from './seed/aiClient.js'
import { buildBrokerSystemPrompt, buildMessages, trippedBannedWord, leaksReasoning } from '../src/modules/brokerChat/brokerChat.prompt.js'

// Which models to compare.
//
// This was a hand-written list three times and it rotted three times: it
// named OpenRouter ':free' ids after the chat moved to Groq, then Groq ids
// after it moved back. A list of models kept in source is a list of models
// that is wrong by the time someone reads it.
//
// So it is asked of the provider. CHAT_CANDIDATES still overrides, for
// comparing two specific models on purpose.
const MAX_CANDIDATES = 4

async function discoverCandidates(config) {
  const fromEnv = (process.env.CHAT_CANDIDATES || '').split(',').map((v) => v.trim()).filter(Boolean)
  if (fromEnv.length > 0) return fromEnv

  const r = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  if (!r.ok) throw new Error(`GET /models -> HTTP ${r.status}`)
  const ids = ((await r.json())?.data ?? []).map((m) => m.id)

  // ':free' is OpenRouter's marker for the models that cost nothing.
  // Groq does not use it and every model on its plan is callable, so
  // there the whole list is the candidate list -- filtering by a suffix
  // that provider never emits would compare nothing at all.
  const free = ids.filter((id) => id.endsWith(':free'))
  const pool = free.length > 0 ? free : ids
  // The configured model first when it is in the list: the comparison is
  // usually "is what I am running better or worse than the others".
  const mine = config.model && pool.includes(config.model) ? [config.model] : []
  return [...mine, ...pool.filter((id) => id !== config.model)].slice(0, MAX_CANDIDATES)
}

const carrierLine = process.argv[2]
  || "Hi — still got this one? I'm 90 miles out and can be there first thing. What's your best rate?"

const config = chatConfigFor('broker')

const CANDIDATES = await discoverCandidates(config)
console.log(`${CANDIDATES.length} ta model taqqoslanadi (${CANDIDATES.length} ta so'rov): ${CANDIDATES.join(', ')}\n`)

const row = await pool.query(`
  SELECT p.*, b.name, b.contact_name AS "contactName", b.persona, b.credit_rating
    FROM load_postings p JOIN brokers b ON b.id = p.broker_id
   WHERE p.status = 'open' AND p.posted_at <= now() AND p.expires_at > now()
   ORDER BY random() LIMIT 1
`)
if (row.rows.length === 0) {
  console.error('No live posting with a broker. Run: npm run refresh:postings')
  await pool.end(); process.exit(1)
}
const r = row.rows[0]

const posting = {
  originCity: r.origin_city, originState: r.origin_state,
  destinationCity: r.destination_city, destinationState: r.destination_state,
  distanceMi: r.distance_mi, commodity: r.commodity, weightLbs: r.weight_lbs,
  equipmentType: r.equipment_type, equipmentLengthFt: r.equipment_length_ft,
  rateUsd: r.rate_usd, pickupAt: r.pickup_at, deliveryAt: r.delivery_at,
}
const systemPrompt = buildBrokerSystemPrompt({
  broker: { name: r.name, contactName: r.contactName, persona: r.persona },
  posting,
})
const messages = buildMessages({ systemPrompt, history: [], newMessage: carrierLine })

console.log(`load   : ${posting.originCity}, ${posting.originState} -> ${posting.destinationCity}, ${posting.destinationState}`)
console.log(`         $${posting.rateUsd} / ${posting.distanceMi} mi = $${(posting.rateUsd / posting.distanceMi).toFixed(2)}/mi`)
console.log(`broker : ${r.contactName} at ${r.name} (${r.credit_rating})`)
console.log(`persona: ${r.persona}`)
console.log(`\ncarrier > ${carrierLine}\n`)
console.log('='.repeat(72))

for (const model of CANDIDATES) {
  const t0 = Date.now()
  process.stdout.write(`\n${model}\n`)
  try {
    const reply = await chatText({ messages, config: { ...config, model } })
    const ms = Date.now() - t0
    const text = reply.trim()
    const banned = trippedBannedWord(text)
    const sentences = (text.match(/[.!?]+/g) || []).length
    // Same detector the service uses, not a second copy — a narrower local
    // pattern is exactly why the 120B model's leak went unflagged here.
    const leak = leaksReasoning(text)
    console.log(`  ${ms} ms · ${text.length} chars · ~${sentences} sentences` +
      (banned ? ` · BANNED WORD: ${banned}` : '') +
      (leak ? ' · LEAKS REASONING' : ''))
    console.log(`  ${text.replace(/\n/g, '\n  ')}`)
  } catch (e) {
    console.log(`  FAILED: ${e.message}`)
  }
}

console.log(`\n${'='.repeat(72)}`)
console.log('Pick by voice: short, in character, asks something back, pushes on rate.')
console.log('Then set CHAT_MODEL in backend/.env')

await pool.end()
