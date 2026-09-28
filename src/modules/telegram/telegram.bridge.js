// The bridge's decisions, as opposed to its plumbing.
//
// The poll loop classifies updates with the router; this module RESOLVES
// each labelled intent against the database and the existing chat
// service. One rule dominates everything here (plan section 0):
//
//   A Telegram message reaches the driver thread by calling
//   driverChat.service.sendMessage({ conversationId, userId, text })
//   -- and nothing else. Delay, budget, regeneration and refusal logic
//   live there already; none of it is reimplemented.
//
// The outgoing side goes through the same sentences the app uses: a
// budget refusal is told to the group as the budget fact, not disguised
// as the driver going quiet.

import { AppError } from '../../lib/errors.js'
import * as repo from './telegram.repository.js'
import { routeUpdate } from './telegram.router.js'
import { openConversation, sendMessage } from '../driverChat/driverChat.service.js'
import { createTelegramClient } from './telegram.client.js'
import config from '../../config.js'

// The chat service entry, held in a let so tests can point it at a spy.
// Production always uses the real one -- the bridge has exactly one door
// into the thread, and the tests assert on THAT, not on a copy of it.
let chatBackend = { openConversation, sendMessage }
export function setChatBackendForTests(backend) {
  chatBackend = backend
}

// How long a chat that typed into the void stays quiet before the bot
// reminds it, once, that it is not linked. Loud enough that a broken
// link is never a mystery; rare enough that a spam wave does not get a
// wall of reminders. Ten minutes, named as the choice it is.
const NOT_LINKED_NOTICE_MS = 10 * 60 * 1000

const HELP_TEXT = [
  'Commands:',
  '/d <name> — set which driver this chat is talking to',
  '/drivers — list the drivers',
  '/link <code> — bind this chat to your dispatcher account (code from the app)',
  '/help — this list',
  'Anything else is sent to the driver: reply to one of my messages, or pick a driver with /d first.',
].join('\n')

function driversText(rows) {
  return rows.map((d) => `${d.name} (${d.dutyStatus})`).join('\n')
}

// -- Outgoing, on behalf of the bot's own voice --------------------------
//
// The telegram client arrives as a parameter (the poll loop passes its
// own; tests pass a fake). botTelegram defaults it to the real one so
// production callers stay simple.
let botTelegram = null
export function setBotTelegramForTests(client) {
  botTelegram = client
}

async function botSend(chatId, text) {
  const tg = botTelegram ?? createTelegramClient({ token: config.telegramToken })
  try {
    await tg.sendMessage(chatId, text)
  } catch (err) {
    // The bot's own housekeeping lines are best-effort: a dead send here
    // is logged and dropped, never thrown into the poll loop.
    console.error(`[telegramBridge] bot send failed: ${err.message}`)
  }
}

// -- The update loop's per-update entry ----------------------------------
//
// Resolves the router's intent. Returns { reply?: string } for lines the
// bot says in the group; actual driver-message handling returns nothing
// and simply lands the words in the thread.

// `client` threads the caller's transaction through every read and write
// (the poll loop leaves it null and uses the pool; tests pass their
// inRollback client so nothing they do ever commits).
export async function handleUpdate(update, telegram = null, client = null) {
  const chatId = update.chatId
  const text = update.text ?? ''
  const from = update.fromTgUserId ?? null

  const link = await repo.getLinkByChat(chatId, client)
  const intent = routeUpdate({
    text,
    replyToTelegramMessageId: update.replyToTelegramMessageId ?? null,
    currentDriverId: link?.currentDriverId ?? null,
  })

  switch (intent.kind) {
    // -- /link <code> -----------------------------------------------------
    case 'link': {
      // Find-then-consume. The consume repeats the validity checks in its
      // WHERE, so a code typed twice in the same second links once.
      const found = await repo.findValidCode(intent.code, client)
      if (!found) {
        await botSend(chatId, 'Unknown or expired code. Generate a new one in the app (Settings → Telegram).')
        return {}
      }
      const consumed = await repo.markCodeUsed(intent.code, client)
      if (!consumed) {
        await botSend(chatId, 'That code was just used. Generate a new one in the app.')
        return {}
      }
      await repo.upsertLink({ chatId, userId: consumed.userId, linkedByTgUser: from }, client)
      await botSend(chatId, 'Linked. This chat now dispatches as that account.')
      return {}
    }

    // -- /d <ism> ---------------------------------------------------------
    case 'set-driver': {
      if (!link) {
        await botSend(chatId, 'This chat is not linked yet. Use /link <code> first.')
        return {}
      }
      const matches = await repo.driversByName(intent.name, client)
      if (matches.length === 0) {
        await botSend(chatId, `No driver named "${intent.name}". /drivers lists them.`)
        return {}
      }
      if (matches.length > 1) {
        // Two people, one name: the PERSON decides, the code never does.
        await botSend(chatId, `Several drivers are named "${intent.name}". Reply to one of their messages, or use the exact name:\n${driversText(matches)}`)
        return {}
      }
      await repo.setCurrentDriver(chatId, matches[0].id, client)
      await botSend(chatId, `Talking to ${matches[0].name} now.`)
      return {}
    }

    case 'drivers': {
      const roster = await repo.driversList(client)
      await botSend(chatId, roster.length > 0 ? driversText(roster) : 'No drivers on the roster yet.')
      return {}
    }

    case 'help': {
      await botSend(chatId, HELP_TEXT)
      return {}
    }

    // -- Plain text, aimed at a driver ------------------------------------
    case 'to-driver': {
      if (!link) {
        await notifyNotLinked(chatId, client)
        return {}
      }
      const target = await repo.findReplyTarget({
        chatId,
        telegramMessageId: intent.replyToTelegramMessageId,
      }, client)
      if (!target) {
        await botSend(chatId, "I can't tell who that reply was for. Pick a driver with /d <name>.")
        return {}
      }
      return deliverToThread({ conversationId: target.conversationId, userId: target.userId, text, chatId })
    }

    case 'to-current': {
      if (!link) {
        await notifyNotLinked(chatId, client)
        return {}
      }
      // The standing /d choice. Re-checked against the drivers table: a
      // driver who left (QUIT) must not silently catch messages.
      const driver = await repo.driverById(intent.driverId, client)
      if (!driver) {
        await repo.setCurrentDriver(chatId, null, client)
        await botSend(chatId, 'That driver is gone. Pick another with /d <name>.')
        return {}
      }
      const conversation = await chatBackend.openConversation({ driverId: driver.id, userId: link.userId })
      return deliverToThread({ conversationId: conversation.conversation.id, userId: link.userId, text, chatId })
    }

    case 'ask-who': {
      if (!link) {
        await notifyNotLinked(chatId, client)
        return {}
      }
      const roster = await repo.driversList(client)
      await botSend(chatId, `Who is this for? Reply to one of my messages, or pick with /d <name>:\n${driversText(roster)}`)
      return {}
    }

    case 'ignore':
    default:
      return {}
  }
}

// -- The one door into the chat -------------------------------------------

async function deliverToThread({ conversationId, userId, text, chatId }) {
  try {
    await chatBackend.sendMessage({ conversationId, userId, text })
  } catch (err) {
    if (err instanceof AppError && err.code === 'CHAT_DAILY_LIMIT') {
      // The budget fact, in the group's own words. Saying "the driver is
      // ignoring you" here would be a lie about a person standing right
      // there -- the account is out of model requests, which is a
      // different fact with a different answer.
      await botSend(chatId, 'The AI provider\'s daily limit is used up. Messages still land in the app; replies resume tomorrow.')
      return {}
    }
    throw err
  }
}

// A chat with no link is told ONCE per window, not per message.
let noticeMap = null
let noticeMapLoaded = false

async function notifyNotLinked(chatId, client = null) {
  const now = Date.now()
  if (!noticeMapLoaded) {
    noticeMap = await repo.getNoticeMap(client)
    noticeMapLoaded = true
  }
  const last = noticeMap[String(chatId)] ? new Date(noticeMap[String(chatId)]).getTime() : 0
  if (now - last < NOT_LINKED_NOTICE_MS) return
  noticeMap[String(chatId)] = new Date(now).toISOString()
  await repo.setNoticeMap(noticeMap, client)
  await botSend(chatId, 'This chat is not linked yet. Generate a code in the app (Settings → Telegram) and send /link <code>.')
}

// The poll loop calls this on start so a restarted process re-reads the
// notice map instead of spamming one notice per message after a crash.
export function resetNoticeCache() {
  noticeMap = null
  noticeMapLoaded = false
}
