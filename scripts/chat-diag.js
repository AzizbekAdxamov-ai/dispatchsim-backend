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
import { readAiConfig } from './seed/config.js'

const { config, errors } = readAiConfig({
  prefix: 'CHAT',
  defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: 'minimax/minimax-m3:free' },
})
if (!config) {
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
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

console.log(`base : ${config.baseUrl}`)
console.log(`model: ${config.model}`)
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
    const found = (d?.data ?? []).find((m) => m.id === config.model)
    console.log(found ? `   found: ${found.id}` : `   NOT LISTED: ${config.model}`)
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
try {
  const r = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...head, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: 'Say the single word: ok' }],
      max_tokens: 10,
    }),
  })
  console.log(`   HTTP ${r.status}`)
  if (r.ok) {
    const d = await r.json()
    console.log(`   reply: ${JSON.stringify(d?.choices?.[0]?.message?.content)}`)
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
console.log('\n4) which free models actually answer')
try {
  const r = await fetch(`${config.baseUrl}/models`, { headers: head })
  const d = await r.json()
  const freeIds = (d?.data ?? []).filter((m) => m.id.endsWith(':free')).map((m) => m.id)

  const working = []
  for (const id of freeIds) {
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
        const said = (pd?.choices?.[0]?.message?.content ?? '').trim().slice(0, 30)
        console.log(`   OK   ${id}  -> ${JSON.stringify(said)}`)
        working.push(id)
      } else {
        const why = (await safeErrorMessage(probe)).slice(0, 90)
        console.log(`   ${probe.status}  ${id}  -> ${why}`)
      }
    } catch (e) {
      console.log(`   ERR  ${id}  -> ${scrub(e.message).slice(0, 60)}`)
    }
  }

  console.log('')
  if (working.length > 0) {
    console.log(`   Usable now: ${working.join(', ')}`)
    console.log(`   Put one in backend/.env as CHAT_MODEL=`)
  } else {
    console.log('   No free model answered. Use a paid one, e.g.')
    console.log('   CHAT_MODEL=deepseek/deepseek-v4-flash-0731')
  }
} catch (e) {
  console.log(`   ${scrub(e.message)}`)
}
