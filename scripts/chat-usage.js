// What the chat has spent today, and what is left.
//
//   node scripts/chat-usage.js
//   node scripts/chat-usage.js --watch
//
// Written for the day real people are using the app. The provider's own
// dashboard reports the account; this reports the app -- who is talking,
// which wallet they are spending from, and how close the budget is. When a
// student says "the broker stopped answering", this is the first thing to
// look at, and it answers the question without opening anybody's account.

import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { DAILY_USAGE_SQL } from '../src/modules/chat/chatBudget.sql.js'
import { chatConfigFor, walletScopeFor, describeChat } from '../src/modules/chat/chatProvider.js'
import { providerFor, dailyBudgetFor, fairShare } from '../src/constants/chatBudget.js'
import appConfig from '../src/config.js'

const WATCH = process.argv.includes('--watch')
const WATCH_SECONDS = 30

function bar(used, total, width = 28) {
  const filled = total > 0 ? Math.min(width, Math.round((used / total) * width)) : 0
  return `${'█'.repeat(filled)}${'·'.repeat(width - filled)}`
}

async function report() {
  const now = new Date().toLocaleTimeString()
  console.log(`\n── ${now} ──────────────────────────────────────────`)

  const seen = new Set()
  for (const which of ['broker', 'driver']) {
    const described = describeChat(which)
    if (!described.ok) {
      console.log(`${which.padEnd(7)} SOZLANMAGAN — ${described.errors.join('; ')}`)
      continue
    }

    const config = chatConfigFor(which)
    const scope = walletScopeFor(which)

    // One wallet, reported once. Two chats on one key share a budget, and
    // printing it twice would read as twice the room.
    if (seen.has(scope)) continue
    seen.add(scope)

    const provider = providerFor(config.baseUrl)
    const budget = dailyBudgetFor(config.baseUrl, appConfig.chatRequestsPerDay)
    const { rows } = await pool.query(DAILY_USAGE_SQL, [
      '00000000-0000-0000-0000-000000000000', scope,
    ])
    const { account_used: used, seats } = rows[0]
    const share = fairShare(budget, Math.max(1, seats))

    const label = scope === 'both' ? 'broker + driver' : scope
    console.log(`${label.padEnd(16)} ${provider.name}  ${config.model}`)
    console.log(`  ${bar(used, budget)}  ${used}/${budget}`)
    console.log(`  bugun ${seats} ta dispecher, har biriga ${share} ta`)
    if (used >= budget) {
      console.log('  BYUDJET TUGADI — bugun hech kim xabar yubora olmaydi')
    } else if (used > budget * 0.8) {
      console.log(`  ${budget - used} ta qoldi`)
    }
  }

  // Who is actually using it. Not a leaderboard -- the question this
  // answers is "is one thread eating the budget", which the totals above
  // cannot show.
  const perUser = await pool.query(`
    WITH turns AS (
      SELECT c.user_id, 'driver' AS chat, m.provider_requests AS n FROM driver_messages m
        JOIN driver_conversations c ON c.id = m.conversation_id
       WHERE m.role = 'dispatcher' AND m.created_at >= date_trunc('day', now())
      UNION ALL
      SELECT c.user_id, 'broker', m.provider_requests FROM broker_messages m
        JOIN broker_conversations c ON c.id = m.conversation_id
       WHERE m.role = 'dispatcher' AND m.created_at >= date_trunc('day', now())
    )
    SELECT u.email,
           -- Requests, not turns (055): the same unit as the budget above.
           coalesce(sum(n) FILTER (WHERE chat = 'broker'), 0)::int AS broker,
           coalesce(sum(n) FILTER (WHERE chat = 'driver'), 0)::int AS driver,
           sum(n)::int AS total
      FROM turns t JOIN users u ON u.id = t.user_id
     GROUP BY u.email ORDER BY total DESC LIMIT 10`)

  if (perUser.rowCount > 0) {
    console.log('\n  dispecher                      broker  driver   jami')
    for (const r of perUser.rows) {
      console.log(`  ${r.email.slice(0, 28).padEnd(30)} ${String(r.broker).padStart(6)}`
        + `  ${String(r.driver).padStart(6)} ${String(r.total).padStart(6)}`)
    }
  } else {
    console.log('\n  bugun hali hech kim yozmagan')
  }

  // What the app is waiting to deliver. A broker takes 20-420 seconds to
  // answer depending on its credit rating, so a pending count is normal;
  // a pending count that does not fall is a tick that stopped running.
  const pending = await pool.query(`
    SELECT count(*)::int AS n,
           coalesce(max(extract(epoch FROM (deliver_at - now()))), 0)::int AS longest_sec
      FROM (
        SELECT deliver_at FROM broker_messages WHERE role = 'broker' AND deliver_at > now()
        UNION ALL
        SELECT deliver_at FROM driver_messages WHERE role = 'driver' AND deliver_at > now()
      ) q`)
  const { n, longest_sec: longest } = pending.rows[0]
  console.log(`\n  yetkazilishini kutayotgan javoblar: ${n}`
    + (n > 0 ? ` (eng uzog'i ${longest} soniya)` : ''))
}

if (WATCH) {
  console.log(`har ${WATCH_SECONDS} soniyada yangilanadi — to'xtatish uchun Ctrl+C`)
  for (;;) {
    await report()
    await new Promise((r) => setTimeout(r, WATCH_SECONDS * 1000))
  }
} else {
  await report()
  console.log('')
  await pool.end()
}
