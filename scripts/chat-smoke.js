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
import { chatConfigFor } from '../src/modules/chat/chatProvider.js'
import { CHAT_REPLY_MAX_CHARS } from '../src/constants/chatBudget.js'
import { FALLBACK_REPLY } from '../src/modules/brokerChat/brokerChat.prompt.js'
import * as service from '../src/modules/brokerChat/brokerChat.service.js'

const text = process.argv[2] || "Hi — is this load still available? What's your best rate on it?"

const config = chatConfigFor('broker')
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
await service.sendMessage({ conversationId: opened.conversation.id, userId, text })
const elapsedMs = Date.now() - t0

// sendMessage does NOT return the reply, deliberately: "Handing the caller
// a message it is not allowed to show yet is how a delay becomes a bug."
// This script destructured { brokerMessage } from it anyway, and had done
// since the delayed reply shipped -- every run until 2026-09-13 died
// earlier, on the model call, so nobody reached the line that would have
// said so.
//
// So the reply is read from where it actually is: written, with a
// deliver_at in the future. Reading it here is peeking at something the
// app will not show yet, which is the right thing for a smoke test and the
// wrong thing for anything else -- hence the plain sentence below saying
// so, rather than printing it as though a student would have seen it.
const pending = await pool.query(
  `SELECT content, deliver_at, kind,
          greatest(0, extract(epoch FROM (deliver_at - now())))::int AS waits_sec
     FROM broker_messages
    WHERE conversation_id = $1 AND role = 'broker'
    ORDER BY created_at DESC
    LIMIT 1`,
  [opened.conversation.id],
)

if (pending.rowCount === 0) {
  console.error('Broker javobi yozilmadi. Model chaqiruvi o\'tdi, lekin qator yo\'q.')
  await pool.end()
  process.exit(1)
}

const { content, waits_sec: waits } = pending.rows[0]

console.log(`${p.contact_name} > ${content}\n`)
console.log(`(model ${elapsedMs} ms, javob ${content.length} belgi)`)
console.log(`(ilova buni ${waits} soniyadan keyin ko'rsatadi — ${p.credit_rating} reytingli broker shuncha kutdiradi)`)

// What the reply is checked against before it is stored. Printed because a
// reply that passed is not the same as a reply that passed comfortably: a
// model sitting just under the length limit on a one-line question will go
// over it on a harder one.
const limitPct = Math.round((content.length / CHAT_REPLY_MAX_CHARS) * 100)
console.log(`(uzunlik chegarasining ${limitPct}% i ishlatildi)`)
if (content === FALLBACK_REPLY) {
  console.log('\nDIQQAT: bu zaxira javob. Model ikki marta yaroqsiz javob berdi.')
  console.log('Sabab yuqoridagi [brokerChat] retrying qatorida.')
}

await pool.end()
