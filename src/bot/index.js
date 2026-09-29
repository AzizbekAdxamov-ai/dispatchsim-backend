// The bot. One process: it long-polls Telegram, asks the app what to do,
// and carries the driver's answers back to the group.
//
//   npm run bot
//
// It runs beside the API server (npm start), not inside it: a chat that
// stalls must not stall the app, and an API restart must not drop a
// long poll. They share this project, its .env, its database pool and
// its model client -- which is the whole reason the separate
// telegram_bot process was folded back in on 2026-09-29. Nothing
// travelled over HTTP between them that was not already a function call
// waiting to happen.

import 'dotenv/config'
import config from '../config.js'
import { pool } from '../db/pool.js'
import { createTelegramClient } from './telegram.js'
import { pollOnce } from './loop.js'
import { pushDue, TICK_SEC } from './outgoing.js'
import { readState, writeState } from './state.js'
import * as repo from './bot.repository.js'

const ERROR_BACKOFF_MS = 5000

async function main() {
  if (!config.telegramEnabled) {
    console.error('The bot is not configured. Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and TELEGRAM_DISPATCHER_EMAIL in .env')
    process.exitCode = 1
    return
  }

  const telegram = createTelegramClient({ token: config.telegramBotToken })

  // Who the bot is, and what it is allowed to read. A bot with privacy
  // mode ON is handed only commands addressed to it -- it sits in the
  // group and never sees a word of an ordinary message, which looks
  // exactly like a broken bot and is the single most common way this
  // stops working.
  const me = await telegram.getMe()
  console.log(`[bot] @${me.username} (${me.first_name})`)
  if (me.can_read_all_group_messages === false) {
    console.warn('[bot] privacy mode is ON — BotFather → /setprivacy → Disable, then remove and re-add the bot to the group')
  }

  const dispatcher = await repo.dispatcherByEmail(config.telegramDispatcherEmail)
  if (!dispatcher) {
    console.error(`[bot] no user with the address ${config.telegramDispatcherEmail}. Register it in the app first.`)
    process.exitCode = 1
    return
  }
  console.log(`[bot] speaking for ${dispatcher.name} <${dispatcher.email}>, group ${config.telegramChatId}`)

  let state = readState()
  const save = (next) => { state = next; writeState(next) }

  // Outgoing on its own clock: a driver's answer is due minutes after
  // the question, long after the poll that carried it has returned.
  const outgoing = setInterval(async () => {
    try {
      const result = await pushDue({
        state, chatId: config.telegramChatId, userId: dispatcher.id, telegram, save,
      })
      state = result.state
    } catch (err) {
      console.error(`[bot] could not carry a reply to the group: ${err.message}`)
    }
  }, TICK_SEC * 1000)

  const shutdown = async () => {
    clearInterval(outgoing)
    await pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  for (;;) {
    try {
      state = await pollOnce({
        telegram, state, save,
        userId: dispatcher.id,
        chatId: config.telegramChatId,
        vision: config.chatDriverVision,
      })
    } catch (err) {
      const fatal = fatalReason(err)
      if (fatal) {
        console.error(`\n[bot] ${fatal}\n`)
        clearInterval(outgoing)
        await pool.end().catch(() => {})
        process.exitCode = 1
        return
      }
      console.error(`[bot] ${err.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS))
    }
  }
}

// Some failures never fix themselves by waiting, and retrying them every
// five seconds produces a wall of identical lines that never says what
// to do. Each is named, explained once, and the loop stops.
export function fatalReason(err) {
  if (err?.status === 401) {
    return [
      'Telegram refused the token (401 Unauthorized).',
      'Waiting will not fix this. One of these is true:',
      '  - TELEGRAM_BOT_TOKEN is not this bot\'s current token',
      '    (BotFather\'s /revoke or /token issues a NEW one and kills the old)',
      '  - TELEGRAM_BOT_TOKEN is also set in the shell, and the shell wins over .env',
    ].join('\n')
  }
  if (err?.status === 409) {
    return [
      'Telegram says another process is already long-polling this bot (409 Conflict).',
      'Two copies cannot share one token: stop the other one, or delete the',
      'webhook if one was ever set.',
    ].join('\n')
  }
  return null
}

await main()
