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
import { pollOnce, backoffMs } from './loop.js'
import { pushDue, createDeliveryTick, chatAdvice, TICK_SEC } from './outgoing.js'
import { readState, writeState, mergeState, claimOwnership, pidIsAlive, stateFileAgeMs } from './state.js'
import * as repo from './bot.repository.js'

// Set once main() has something to stop. Declared out here so the
// delivery tick, which is created before it, can still reach it.
let stop = () => process.exit(1)

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

  // Can the bot reach the chat in .env, and what kind of chat is it?
  //
  // This is the check that was missing on the afternoon the bot spent
  // repeating one reply into a chat that had blocked it (2026-09-29).
  // The failure was perfectly clear at every send and never once at
  // boot, which is the only place anybody was reading.
  //
  // The chat TYPE is printed because the id alone hides the most common
  // mistake there is here: a group id is negative, a private chat's is
  // positive, and TELEGRAM_CHAT_ID=6686277144 is one person, not a group.
  try {
    const chat = await telegram.getChat(config.telegramChatId)
    const title = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? ''
    console.log(`[bot] chat ${config.telegramChatId}: ${chat.type}${title ? ` "${title}"` : ''}`)
    // A private chat is a legitimate setup -- one dispatcher, one bot,
    // one driver -- and it is the one this bot actually runs in. The
    // type is printed so that a chat id pointed at the wrong place is
    // visible at boot; it is no longer treated as a mistake by itself.
  } catch (err) {
    console.error(`\n[bot] cannot reach chat ${config.telegramChatId}: ${err.message}`)
    console.error(chatAdvice(err))
    process.exitCode = 1
    return
  }

  const dispatcher = await repo.dispatcherByEmail(config.telegramDispatcherEmail)
  if (!dispatcher) {
    console.error(`[bot] no user with the address ${config.telegramDispatcherEmail}. Register it in the app first.`)
    process.exitCode = 1
    return
  }
  // One fixed driver for the whole group, resolved at boot so a typo is
  // named here and not at the first message.
  let fixedDriverName = null
  if (config.telegramDriverName) {
    const matches = await repo.driversByName(config.telegramDriverName)
    if (matches.length !== 1) {
      console.error(`[bot] TELEGRAM_DRIVER_NAME "${config.telegramDriverName}" matched ${matches.length} drivers -- it must match exactly one.`)
      process.exitCode = 1
      return
    }
    fixedDriverName = config.telegramDriverName
    console.log(`[bot] this chat talks to ${matches[0].name} — one bot, one driver`)
  }
  console.log(`[bot] speaking for ${dispatcher.name} <${dispatcher.email}>, chat ${config.telegramChatId}`)

  // One mutable state, one writer at a time -- the piece this process
  // got wrong the first afternoon it ran live (2026-09-29, three copies
  // of one driver reply within a minute). pollOnce parks inside a
  // 50-second long-poll holding the state it was HANDED; while it sits
  // there, the outgoing tick fires, sends a due reply and advances the
  // watermark through save(). When the poll returns, its own snapshot is
  // OLD: the watermark it carries has already been spent. Assigning its
  // return value back rewound the watermark and the next tick re-sent
  // the reply -- every poll return undoing the tick's progress.
  //
  // The fix is ownership, not locking: state lives HERE, both loops
  // advance it only through save(next), and neither copies a stale
  // snapshot back over it. save() also merges on the write path, so a
  // write based on a slightly old view cannot erase a field a newer one
  // already advanced (targets, deliveredThrough, offset all move
  // forward-only).
  let state = readState()

  // Is another copy already running? Two bots on one token is not a
  // theory: on 2026-09-29 one outlived the terminal it was started from
  // and kept answering for half an hour after everything had been
  // "stopped", with the group filling up and no way to tell what was
  // doing it. Telegram would have said 409 eventually -- this says it
  // now, and says the pid, which is the one thing needed to end it.
  const claim = claimOwnership(state, {
    pid: process.pid,
    isAlive: pidIsAlive,
    fileAgeMs: stateFileAgeMs(),
  })
  if (!claim.ok) {
    console.error(`\n[bot] another bot is already running as process ${claim.owner.pid} (started ${claim.owner.startedAt}).`)
    console.error('  Two copies cannot share one token. Stop that one first:')
    console.error(`    Windows:  Stop-Process -Id ${claim.owner.pid} -Force`)
    console.error(`    mac/Linux:  kill ${claim.owner.pid}\n`)
    process.exitCode = 1
    return
  }
  if (claim.tookOver) {
    console.warn(`[bot] taking over from process ${claim.tookOver.pid}, which is gone`)
  }

  const save = (next) => {
    state = mergeState(state, next)
    writeState(state)
  }

  // Sign the file: from here on it says which process is writing it.
  save({ owner: { pid: process.pid, startedAt: new Date().toISOString() } })

  // Outgoing on its own clock: a driver's answer is due minutes after
  // the question, long after the poll that carried it has returned.
  //
  // Wrapped in createDeliveryTick, which is the whole reason the same
  // reply stopped arriving twice: setInterval starts a pass whether or
  // not the last one finished, and two passes read the same watermark.
  const tick = createDeliveryTick(async () => {
    try {
      return await pushDue({
        state, chatId: config.telegramChatId, userId: dispatcher.id, telegram, save,
      })
    } catch (err) {
      if (err.permanentChatFailure) {
        // Every following send fails the same way, and the watermark has
        // not moved -- so nothing the driver said is lost, it is waiting.
        // Stopping says that once; the alternative is the same line
        // every fifteen seconds for as long as the bot runs.
        console.error(`\n[bot] cannot deliver to chat ${config.telegramChatId}: ${err.message}`)
        console.error(chatAdvice(err))
        console.error('[bot] nothing was lost — the replies are still queued. Fix the chat and start the bot again.\n')
        stop(1)
        return { fatal: true }
      }
      console.error(`[bot] could not carry a reply to the group: ${err.message}`)
      return { failed: true }
    }
  })
  const outgoing = setInterval(tick, TICK_SEC * 1000)

  const shutdown = async (code = 0) => {
    clearInterval(outgoing)
    await pool.end().catch(() => {})
    process.exit(code)
  }
  stop = shutdown
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  // How many times in a row the loop has come back to the same place.
  // pollOnce is told, and decides what the number means: past
  // MAX_TURN_ATTEMPTS it stops keeping the message and says so in the
  // group. The count also stretches the wait, so a database that is
  // down for an hour costs a line every minute instead of seven hundred
  // identical ones.
  let attempts = 0

  for (;;) {
    try {
      await pollOnce({
        telegram, state, save,
        userId: dispatcher.id,
        chatId: config.telegramChatId,
        vision: config.chatDriverVision,
        fixedDriverName,
        attempts,
      })
      attempts = 0
    } catch (err) {
      const fatal = fatalReason(err)
      if (fatal) {
        console.error(`\n[bot] ${fatal}\n`)
        clearInterval(outgoing)
        await pool.end().catch(() => {})
        process.exitCode = 1
        return
      }
      attempts += 1
      const waitMs = backoffMs(attempts)
      console.error(`[bot] ${err.message} — try ${attempts}, waiting ${Math.round(waitMs / 1000)}s`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
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
