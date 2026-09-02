// End-to-end check for the broker chat, without the frontend.
//
//   node scripts/chat-smoke.js
//   node scripts/chat-smoke.js "I can do 2.60 all in, picking up tomorrow AM"
//
// Picks a live posting that has a broker, opens a conversation as the first
// dispatcher it finds, sends one message, and prints the reply. This exists
// because code that has never actually run has come back broken twice.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { readAiConfig } from './seed/config.js'
import * as service from '../src/modules/brokerChat/brokerChat.service.js'

const text = process.argv[2] || "Hi — is this load still available? What's your best rate on it?"

const { config, errors } = readAiConfig({
  prefix: 'CHAT',
  defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: 'minimax/minimax-m3:free' },
})
if (!config) {
  console.error('Chat is not configured:')
  for (const e of errors) console.error(`  - ${e}`)
  console.error('\nAdd to backend/.env:')
  console.error('  CHAT_BASE_URL=https://openrouter.ai/api/v1')
  console.error('  CHAT_API_KEY=<your OpenRouter key>')
  console.error('  CHAT_MODEL=minimax/minimax-m3:free')
  process.exit(1)
}
console.log(`model : ${config.model}`)
console.log(`base  : ${config.baseUrl}\n`)

const posting = await pool.query(`
  SELECT p.id, p.origin_city, p.origin_state, p.destination_city, p.destination_state,
         p.rate_usd, p.distance_mi, b.name AS broker, b.contact_name, b.credit_rating
    FROM load_postings p
    JOIN brokers b ON b.id = p.broker_id
   WHERE p.status = 'open' AND p.posted_at <= now() AND p.expires_at > now()
   ORDER BY random() LIMIT 1
`)
if (posting.rows.length === 0) {
  console.error("No live posting with a broker. Run: npm run refresh:postings")
  await pool.end()
  process.exit(1)
}
const p = posting.rows[0]

const user = await pool.query(`
  SELECT u.id FROM users u
    JOIN user_roles r ON r.user_id = u.id AND r.role = 'dispatcher'
   LIMIT 1
`)
if (user.rows.length === 0) {
  console.error('No user holds the dispatcher role.')
  await pool.end()
  process.exit(1)
}
const userId = user.rows[0].id

console.log(`load  : ${p.origin_city}, ${p.origin_state} -> ${p.destination_city}, ${p.destination_state}`)
console.log(`        $${p.rate_usd} / ${p.distance_mi} mi = $${(p.rate_usd / p.distance_mi).toFixed(2)}/mi`)
console.log(`broker: ${p.contact_name} at ${p.broker} (rated ${p.credit_rating})\n`)

const opened = await service.openConversation({ postingId: p.id, userId })
console.log(`thread: ${opened.conversation.id} (${opened.messages.length} existing messages)\n`)

console.log(`dispatcher > ${text}\n`)
const t0 = Date.now()
const { brokerMessage } = await service.sendMessage({
  conversationId: opened.conversation.id,
  userId,
  text,
})
console.log(`${p.contact_name} > ${brokerMessage.content}\n`)
console.log(`(${Date.now() - t0} ms, ${brokerMessage.content.length} chars)`)

await pool.end()
