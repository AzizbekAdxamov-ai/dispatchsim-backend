// Diagnose a failing chat provider call.
//
//   node scripts/chat-diag.js
//
// aiClient.js deliberately never puts a provider's response body into a
// thrown error — some providers echo request metadata, including the
// Authorization header, back in error bodies. That rule stays. This script
// is the sanctioned exception: it reads ONLY the provider's own
// `error.message` field and scrubs the key out of it before printing.

import 'dotenv/config'
import { chatConfigFor, describeChat } from '../src/modules/chat/chatProvider.js'
import { providerFor, dailyBudgetFor, chatMaxTokens } from '../src/constants/chatBudget.js'


// Which chat to diagnose. They can be on different keys now, so a
// diagnostic that silently picks one and reports "the chat" would be
// describing a configuration the other chat does not have.
const which = process.argv.includes('--driver') ? 'driver' : 'broker'

// Both configurations, side by side, before anything is called. This is
// the line that answers "are broker and driver on the same key or not"
// without anyone having to read .env and reason about fallbacks.
console.log('sozlama:')
for (const w of ['broker', 'driver']) {
  const d = describeChat(w)
  if (!d.ok) {
    console.log(`  ${w.padEnd(7)} SOZLANMAGAN — ${d.errors.join('; ')}`)
  } else {
    console.log(`  ${w.padEnd(7)} ${d.model || '(model yo\'q)'}  @ ${d.baseUrl}`)
    console.log(`          kalit ${d.keyFingerprint}  hamyon: ${d.wallet === 'both' ? 'UMUMIY' : 'alohida'}`)
  }
}
console.log('')

// A model is NOT required to run this. Finding out which models a key can
// call is what sections 2 and 4 are for, and refusing to start without one
// would make the diagnostic useless in the exact situation it exists for:
// the configured model has been retired and nobody knows what to put in
// its place. Only section 3 -- "call the configured model" -- needs one,
// and it says so and skips itself.
let config
let configError = null
try {
  config = chatConfigFor(which)
} catch (err) {
  configError = String(err.details ?? err.message)
  const probe = describeChat(which)
  const baseUrl = probe.baseUrl ?? process.env[`CHAT_${which.toUpperCase()}_BASE_URL`]
    ?? process.env.CHAT_BASE_URL
  const apiKey = process.env[`CHAT_${which.toUpperCase()}_API_KEY`] ?? process.env.CHAT_API_KEY
  if (!apiKey || !baseUrl) {
    console.error(`${which} chat sozlanmagan va kalitsiz hech narsa tekshirib bo'lmaydi:`)
    console.error(`  ${configError}`)
    process.exit(1)
  }
  // Enough to talk to the provider, not enough to call a model. That is
  // exactly the state this script is meant to get someone out of.
  config = { baseUrl: baseUrl.trim().replace(/\/+$/, ''), apiKey, model: null }
}

// Never let the key reach stdout, whatever the provider sends back.
function scrub(text) {
  if (typeof text !== 'string') return String(text)
  let out = text.split(config.apiKey).join('<KEY>')
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '<KEY>')
  return out
}

async function safeErrorMessage(response) {
  try {
    const data = await response.json()
    return scrub(data?.error?.message ?? JSON.stringify(data?.error ?? data).slice(0, 400))
  } catch {
    return '(no JSON body)'
  }
}

const head = { Authorization: `Bearer ${config.apiKey}` }

// What came back, and -- when nothing came back -- where the tokens went.
// An empty content field has two very different causes and they need
// different fixes: the model refused, or the model thought until it ran
// out of room. Only one of them is fixed by raising max_tokens.
function describeReply(data) {
  const message = data?.choices?.[0]?.message
  const content = (message?.content ?? '').trim()
  const reasoning = (message?.reasoning ?? '').trim()
  const usage = data?.usage
  if (content !== '') return `reply: ${JSON.stringify(content.slice(0, 60))}`
  if (reasoning !== '') {
    return `javob BO'SH -- ${reasoning.length} belgi fikrlashga ketdi, `
      + `${usage?.completion_tokens ?? '?'}/${chatMaxTokens()} token ishlatildi `
      + '(reasoning modeli: max_tokens kam, yoki bu model mos emas)'
  }
  return `javob BO'SH -- fikrlash ham yo'q (${usage?.completion_tokens ?? '?'} token)`
}

const provider = providerFor(config.baseUrl)
console.log(`tekshirilyapti: ${which} chat`)
console.log(`base : ${config.baseUrl}  (${provider.name})`)
console.log(`model: ${config.model ?? "(qo'yilmagan — 3-bo'lim o'tkazib yuboriladi)"}`)
console.log(`key  : ${config.apiKey.slice(0, 7)}… (${config.apiKey.length} chars)\n`)

// 1) Is the key itself valid?
console.log('1) key check — GET /key')
try {
  const r = await fetch(`${config.baseUrl}/key`, { headers: head })
  console.log(`   HTTP ${r.status}`)
  if (r.ok) {
    const d = await r.json()
    const info = d?.data ?? d
    console.log(`   label: ${info?.label ?? '—'}`)
    console.log(`   usage: ${info?.usage ?? '—'}  limit: ${info?.limit ?? 'unlimited'}`)
    console.log(`   free tier: ${info?.is_free_tier ?? '—'}`)
  } else {
    console.log(`   ${await safeErrorMessage(r)}`)
  }
} catch (e) {
  console.log(`   network: ${scrub(e.message)}`)
}

// 2) Is the model visible to this account?
console.log('\n2) model check — GET /models')
try {
  const r = await fetch(`${config.baseUrl}/models`, { headers: head })
  if (r.ok) {
    const d = await r.json()
    const found = config.model ? (d?.data ?? []).find((m) => m.id === config.model) : null
    console.log(config.model
      ? (found ? `   found: ${found.id}` : `   RO'YXATDA YO'Q: ${config.model}`)
      : `   ${(d?.data ?? []).length} ta model ko'rinyapti (model qo'yilmagan)`)
    if (!found) {
      const free = (d?.data ?? []).filter((m) => m.id.endsWith(':free')).map((m) => m.id)
      console.log(`   free ids available: ${free.slice(0, 8).join(', ') || '(none)'}`)
    }
  } else {
    console.log(`   HTTP ${r.status} — ${await safeErrorMessage(r)}`)
  }
} catch (e) {
  console.log(`   network: ${scrub(e.message)}`)
}

// 3) The actual call, with the provider's own reason.
console.log('\n3) chat call — POST /chat/completions')
if (!config.model) {
  console.log(`   o'tkazib yuborildi — ${configError}`)
  console.log('   4-bo\'lim qaysi modellar javob berishini topadi.')
}
if (config.model) try {
  const r = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...head, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: 'Say the single word: ok' }],
      // Not 10. A reasoning model spends this budget on its own thinking
      // before it writes anything, so a probe of 10 tokens comes back
      // empty from a model that works perfectly at the size the chat
      // actually uses. Probing with a number the app never uses measures
      // the probe. chatMaxTokens() is what chatText() sends.
      max_tokens: chatMaxTokens(),
    }),
  })
  console.log(`   HTTP ${r.status}`)
  if (r.ok) {
    const d = await r.json()
    console.log(`   ${describeReply(d)}`)
  } else {
    console.log(`   reason: ${await safeErrorMessage(r)}`)
  }
} catch (e) {
  console.log(`   network: ${scrub(e.message)}`)
}

// 4) Which free models this account can ACTUALLY call.
//
// Listing a model is not the same as being allowed to call it: some free
// ids are gated to approved "agentic harness" apps and answer 403 from a
// custom client. The only reliable way to know is to try each one.
//
// The only reliable way is also the expensive way, and this section used
// to do it without saying so. It probed EVERY id ending in ':free' with a
// real chat call. On OpenRouter that is fifty-odd ids against a key rated
// for fifty requests a day -- so running the diagnostic once spent the
// whole budget, and the diagnostic then reported that no model answered.
// The cause was the diagnostic. A measurement that destroys what it
// measures reports its own footprint as the finding.
//
// Now it spends a stated number of requests, stops as soon as it has
// enough working models to choose from, and prints the bill either way.
const PROBE_LIMIT = 8
const ENOUGH = 3

console.log('\n4) which free models actually answer')
console.log(`   eng ko'pi bilan ${PROBE_LIMIT} ta so'rov sarflanadi (${ENOUGH} tasi ishlasa to'xtaydi)`)
console.log(`   ${provider.name}: kuniga ${provider.requestsPerDay}, ilova byudjeti ${dailyBudgetFor(config.baseUrl)}`)
if (provider.note) console.log(`   ${provider.note}`)
console.log('')

let spent = 0
try {
  const r = await fetch(`${config.baseUrl}/models`, { headers: head })
  const d = await r.json()
  const all = (d?.data ?? []).map((m) => m.id)
  // ':free' is OpenRouter's marker. Groq does not use it and every model
  // on its developer plan is callable, so there the whole list is the
  // candidate list -- filtering by a suffix that provider never emits
  // would print "(none)" about an account that works fine.
  const freeIds = all.filter((m) => m.endsWith(':free'))
  const candidates = (freeIds.length > 0 ? freeIds : all).slice(0, PROBE_LIMIT)

  if (candidates.length === 0) {
    console.log('   /models hech narsa qaytarmadi')
  }

  const working = []
  for (const id of candidates) {
    if (working.length >= ENOUGH) {
      console.log(`   (to'xtatildi -- ${ENOUGH} ta ishlaydigan model topildi, ${candidates.length - spent} tasi sinalmadi)`)
      break
    }
    spent += 1
    try {
      const probe = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...head, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: 'Say the single word: ok' }],
          max_tokens: 10,
        }),
      })
      if (probe.ok) {
        const pd = await probe.json()
        const said = (pd?.choices?.[0]?.message?.content ?? '').trim()
        // HTTP 200 with nothing in it is not a working model. Reporting it
        // as OK is how `reply: ""` got printed next to the word OK and
        // read as a pass.
        if (said === '') {
          console.log(`   BO'SH ${id}  -> ${describeReply(pd)}`)
        } else {
          console.log(`   OK   ${id}  -> ${JSON.stringify(said.slice(0, 40))}`)
          working.push(id)
        }
      } else {
        const why = (await safeErrorMessage(probe)).slice(0, 90)
        console.log(`   ${probe.status}  ${id}  -> ${why}`)
        // A 429 here means the budget is already gone. Every further probe
        // would return the same thing and spend a request to say it.
        if (probe.status === 429) {
          console.log('   (429 -- kunlik limit tugagan, qolgan modellar sinalmadi)')
          break
        }
      }
    } catch (e) {
      console.log(`   ERR  ${id}  -> ${scrub(e.message).slice(0, 60)}`)
    }
  }

  console.log('')
  console.log(`   sarflandi: ${spent + 1} ta so'rov (3-bo'limdagi bittasi bilan)`)
  if (working.length > 0) {
    console.log(`   Ishlayapti: ${working.join(', ')}`)
    console.log('')
    console.log('   backend/.env ichiga qo\'ying:')
    console.log(`     CHAT_MODEL=${working[0]}`)
    console.log('   Broker va driver uchun boshqa-boshqa model kerak bo\'lsa:')
    console.log(`     CHAT_BROKER_MODEL=${working[0]}`)
    console.log(`     CHAT_DRIVER_MODEL=${working[1] ?? working[0]}`)
  } else {
    console.log('   Hech qaysi model javob bermadi.')
  }
} catch (e) {
  console.log(`   ${scrub(e.message)}`)
}
