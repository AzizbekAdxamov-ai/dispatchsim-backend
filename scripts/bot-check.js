// Is the bot pointed at the real company data? Read-only, no Telegram.
//
//   npm run bot:check
//
// The question it answers is the one that cannot be answered by reading
// the code: the code says "the dispatcher named in .env" and "the driver
// named in .env", and only the database knows whether those two names
// are anybody. Everything below is a SELECT.

import 'dotenv/config'
import config from '../src/config.js'
import { pool } from '../src/db/pool.js'
import * as repo from '../src/bot/bot.repository.js'
import { getCarrier } from '../src/modules/carrier/carrier.repository.js'
import { getDriverContext } from '../src/modules/driverChat/driverChat.repository.js'
import { situationLines } from '../src/modules/driverChat/driverChat.prompt.js'

const ok = (line) => console.log(`  ok    ${line}`)
const bad = (line) => { console.log(`  FAIL  ${line}`); failed += 1 }
let failed = 0

try {
  // Which database. The host and the name, never the password -- this
  // script prints what it found, and a connection string is a secret.
  const url = new URL(process.env.DATABASE_URL)
  console.log(`\n  database   ${url.hostname}:${url.port || 5432}${url.pathname}`)
  console.log(`  group      ${config.telegramChatId ?? '(not set)'}`)
  console.log(`  dispatcher ${config.telegramDispatcherEmail || '(not set)'}`)
  console.log(`  driver     ${config.telegramDriverName ?? '(not fixed — the group picks with /d)'}\n`)

  if (!config.telegramEnabled) {
    bad('the bot is not configured — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_DISPATCHER_EMAIL')
  } else {
    ok('the bot is configured')
  }

  const carrier = await getCarrier()
  if (carrier?.name) ok(`carrier: ${carrier.name}, ${carrier.mcNumber ?? 'no MC'}`)
  else bad('no carrier row — the driver will not know who they work for')

  const dispatcher = config.telegramDispatcherEmail
    ? await repo.dispatcherByEmail(config.telegramDispatcherEmail)
    : null
  if (dispatcher) ok(`dispatcher: ${dispatcher.name} <${dispatcher.email}>`)
  else bad(`no user with the address ${config.telegramDispatcherEmail || '(none set)'} — register it in the app first`)

  const roster = await repo.driversList()
  console.log(`  ok    roster: ${roster.length} driver${roster.length === 1 ? '' : 's'}${roster.length > 0 ? ` (${roster.map((d) => d.name).join(', ')})` : ''}`)

  // The whole point: the driver the group talks to, and what they know
  // right now. These are the lines the model is given -- if they are
  // wrong here, they are wrong in the chat.
  let driver = null
  if (config.telegramDriverName) {
    const matches = await repo.driversByName(config.telegramDriverName)
    if (matches.length === 1) {
      driver = matches[0]
      ok(`the group talks to ${driver.name} (${driver.id})`)
    } else {
      bad(`TELEGRAM_DRIVER_NAME "${config.telegramDriverName}" matches ${matches.length} drivers — it must match exactly one`)
    }
  } else if (roster.length === 1) {
    driver = roster[0]
    ok(`only one driver on the roster (${driver.name}) — set TELEGRAM_DRIVER_NAME to make that the rule`)
  }

  if (driver) {
    const context = await getDriverContext(driver.id)
    if (!context) {
      bad(`no context row for ${driver.id}`)
    } else {
      console.log('')
      for (const line of situationLines({ driver: context.driver, load: context.load })) {
        console.log(`    ${line}`)
      }
    }
  }

  console.log(failed === 0 ? '\n  hammasi joyida\n' : `\n  ${failed} ta muammo\n`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error(`\n  could not check: ${err.message}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
