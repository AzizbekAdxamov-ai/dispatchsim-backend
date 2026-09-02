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
import { readAiConfig } from './seed/config.js'
import { chatText } from './seed/aiClient.js'
import { buildBrokerSystemPrompt, buildMessages, trippedBannedWord, leaksReasoning } from '../src/modules/brokerChat/brokerChat.prompt.js'

// Only models that answered a plain instruction cleanly on this account.
// Edit freely — chat:diag prints the current usable list.
const CANDIDATES = (process.env.CHAT_CANDIDATES || [
  'minimax/minimax-m3:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'minimax/minimax-m2.7:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)

const carrierLine = process.argv[2]
  || "Hi — still got this one? I'm 90 miles out and can be there first thing. What's your best rate?"

const { config, errors } = readAiConfig({
  prefix: 'CHAT',
  defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: CANDIDATES[0] },
})
if (!config) {
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

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
