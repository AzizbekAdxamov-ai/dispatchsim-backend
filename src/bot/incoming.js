// What the group typed, turned into what the app does about it.
//
// This is the bridge that used to be an HTTP route in one process and a
// POST in another. It is now a function call, because both halves ended
// up in the same process on 2026-09-29: the half that knows Telegram and
// the half that knows the database were never two systems, only two
// files with a network between them.
//
// Nothing here talks to Telegram. It returns the LINES to say, in order,
// and the loop says them -- so every branch below can be tested with no
// network, no database and no token, by handing in a fake `app`.

import { routeUpdate } from './router.js'
import { photoDecision, incomingRecordText, BLIND_PHOTO_NOTICE } from './vision.js'
import { AppError } from '../lib/errors.js'
import * as repo from './bot.repository.js'
import * as driverChat from '../modules/driverChat/driverChat.service.js'
import { getCarrier } from '../modules/carrier/carrier.repository.js'
import { getDriverContext } from '../modules/driverChat/driverChat.repository.js'
import { statusText } from './status.js'
import { isGroupChat, callName, stripBotMention } from './addressing.js'

// The app, as the bot needs it. One object, so a test can replace it
// whole: every call below goes through here and nothing reaches around
// it to the database.
export const realApp = {
  driversList: repo.driversList,
  driversByName: repo.driversByName,
  driverById: repo.driverById,
  getCarrier,
  openConversation: driverChat.openConversation,
  getDriverContext,
  sendMessage: driverChat.sendMessage,
}

const HELP_LINES = [
  'Commands:',
  '/d <name> — set which driver this chat is talking to',
  '/drivers — list the drivers',
  '/status — the current driver, from the dispatch system',
  '/help — this list',
  'Anything else is sent to the driver: reply to one of my messages, or pick a driver with /d first.',
]

export function helpText(carrierName, driver = null, { group = false } = {}) {
  const title = carrierName ? `${carrierName} — driver dispatch` : 'Driver dispatch'
  if (driver) {
    // One driver: nothing to choose, so nothing to explain about
    // choosing. /d and /drivers exist for the general case and would
    // only be two ways to be confused here.
    return [
      title,
      '',
      `You are talking to ${driver.truckId ? `${driver.name} · ${driver.truckId}` : driver.name}.`,
      'Just type. They answer when they can — a driver behind the wheel does not text back at once.',
      // In a group the two people talking to each other are left alone
      // (src/bot/addressing.js), and the way in has to be said once.
      ...(group
        ? [`In this group: reply to ${callName(driver.name)}'s message, or say "${callName(driver.name)}" — other talk is left alone.`]
        : []),
      '',
      '/status — where they are right now, from the dispatch system',
      '/help — this',
    ].join('\n')
  }
  return [title, '', ...HELP_LINES].join('\n')
}

// One command, one missing word, one sentence -- not the whole list.
// Typing /d and getting four commands back tells someone everything
// except which word they left out.
export function usageText(command) {
  if (command === 'd') {
    return ['That one needs a name: /d Marcus', '/drivers lists who is on the roster.'].join('\n')
  }
  if (command === 'link') {
    // Kept because the habit outlives the feature. Codes bound a chat to
    // one of many student accounts; there is one dispatcher and one
    // group now, both named in .env, and nothing to bind.
    return 'No code needed any more — this chat is already connected.'
  }
  return HELP_LINES.join('\n')
}

// The three intents that carry words meant for a driver, as opposed to
// a command about the bot itself.
const FOR_A_DRIVER = new Set(['to-driver', 'to-current', 'ask-who'])

// Commands that mean something different when there is only one driver:
// /d cannot choose, /help names the person, /status knows whom to show.
const ONE_DRIVER_COMMANDS = new Set(['set-driver', 'help', 'status'])

function rosterText(rows) {
  return rows.map((d) => `${d.name} (${d.dutyStatus})`).join('\n')
}

// The whole turn: facts in, { state, replies } out.
//
// `state` is returned rather than mutated so the caller decides when it
// is written to disk -- after the lines are said, never before.
//
// `fixedDriverName` collapses the routing to one person: when set, a
// message that does not name a recipient goes to that driver without the
// /d step and without the roster question. The one group talks to one
// driver, which is the whole arrangement -- everything else (/d, /drivers,
// replies) keeps working for anyone who wants the general case.
export async function handleUpdate(fact, { state, app = realApp, userId, vision = false, fixedDriverName = null, botUsername = null }) {
  const replies = []
  const say = (text) => { replies.push(text) }
  let next = state

  // "@Bot where are you" reaches the driver as "where are you".
  if (botUsername && fact.text) fact = { ...fact, text: stripBotMention(fact.text, botUsername) }

  const intent = routeUpdate({
    text: fact.text ?? '',
    replyToTelegramMessageId: fact.replyToTelegramMessageId ?? null,
    currentDriverId: state.currentDriverId ?? null,
    botUsername,
  })

  // One group, one driver.
  //
  // When TELEGRAM_DRIVER_NAME is set this is not a default that the
  // routing can be talked out of: every message that is meant for a
  // driver goes to THAT driver. A reply to an old line, a /d left over
  // from before, a message that names nobody -- all the same person.
  // The alternative is a bot that is usually right about who it is
  // talking to, and words in the wrong driver's mouth are the one
  // failure nothing anywhere would show.
  //
  // Resolved from the database on every turn, not once at boot: a name
  // that stops matching (the driver quit, the roster was cleaned) must
  // say so rather than keep answering as a row that is gone.
  if (fixedDriverName && (FOR_A_DRIVER.has(intent.kind) || ONE_DRIVER_COMMANDS.has(intent.kind))) {
    const matches = await app.driversByName(fixedDriverName)
    if (matches.length !== 1) {
      say(`TELEGRAM_DRIVER_NAME is "${fixedDriverName}" and that matches ${matches.length} drivers on the roster. It has to match exactly one.`)
      return { state: next, replies }
    }
    const driver = matches[0]
    if (intent.kind === 'set-driver') {
      say(`This chat talks to ${driver.name}. Change TELEGRAM_DRIVER_NAME in .env and restart the bot to talk to someone else.`)
      return { state: next, replies }
    }
    if (intent.kind === 'help' || intent.kind === 'status') {
      const context = await app.getDriverContext(driver.id)
      if (!context) {
        say(`${driver.name} is on the roster but has no record the dispatch system can read.`)
        return { state: next, replies }
      }
      if (intent.kind === 'help') {
        const carrier = await app.getCarrier()
        say(helpText(carrier?.name, context.driver, { group: isGroupChat(fact.chatType, fact.chatId) }))
      } else {
        say(statusText(context))
      }
      return { state: next, replies }
    }
    next = { ...next, currentDriverId: driver.id }
    await deliver({ driverId: driver.id, fact, say, app, userId, vision })
    return { state: next, replies }
  }

  switch (intent.kind) {
    case 'help': {
      const carrier = await app.getCarrier()
      say(helpText(carrier?.name))
      break
    }

    case 'usage':
      say(usageText(intent.command))
      break

    case 'link':
      say(usageText('link'))
      break

    case 'drivers': {
      const roster = await app.driversList()
      say(roster.length > 0 ? rosterText(roster) : 'No drivers on the roster yet.')
      break
    }

    case 'set-driver': {
      const matches = await app.driversByName(intent.name)
      if (matches.length === 0) {
        const roster = await app.driversList()
        say(`No driver by that name. On the roster:\n${rosterText(roster)}`)
        break
      }
      if (matches.length > 1) {
        // Two people with one name is a fact about the roster, not an
        // excuse to pick one. Picking would put words in someone's
        // mouth and nothing anywhere would show it.
        say(`More than one driver is called that: ${matches.map((d) => d.id).join(', ')}. Use the id: /d ${matches[0].id}`)
        break
      }
      next = { ...next, currentDriverId: matches[0].id }
      say(`Talking to ${matches[0].name}.`)
      break
    }

    case 'to-driver': {
      // A reply names the thread. The bot remembers which of its own
      // lines came from which driver (state.targets); past that memory,
      // it asks rather than guesses.
      const driverId = state.targets?.[String(intent.replyToTelegramMessageId)] ?? null
      if (!driverId) {
        say("I can't tell who that reply was for. Pick a driver with /d <name>.")
        break
      }
      await deliver({ driverId, fact, say, app, userId, vision })
      break
    }

    case 'to-current': {
      // The standing /d choice, re-checked: a driver who left must not
      // silently catch messages.
      const driver = await app.driverById(intent.driverId)
      if (!driver) {
        next = { ...next, currentDriverId: null }
        say('That driver is gone. Pick another with /d <name>.')
        break
      }
      await deliver({ driverId: driver.id, fact, say, app, userId, vision })
      break
    }

    case 'ask-who': {
      // Only reached when no driver is fixed: with one configured, the
      // question never arises -- it was answered above, before the
      // switch, for every intent that carries words for a driver.
      const roster = await app.driversList()
      say(`Who is this for? Reply to one of my messages, or pick with /d <name>:\n${rosterText(roster)}`)
      break
    }

    case 'status': {
      // No fixed driver: the chat's current one, if a /d has chosen.
      const driver = state.currentDriverId ? await app.driverById(state.currentDriverId) : null
      if (!driver) {
        say('No driver picked yet. Pick one with /d <name>, then /status.')
        break
      }
      const context = await app.getDriverContext(driver.id)
      say(context ? statusText(context) : `${driver.name} has no record the dispatch system can read.`)
      break
    }

    case 'ignore':
    default:
      break
  }

  return { state: next, replies }
}

// What the chat is told when the model did not answer.
//
// These lines used to promise that "the reply will come when it is back".
// Nothing makes that true: a failed model call is not queued and nothing
// retries it -- the dispatcher's message is saved in the thread, and that
// is all. A promise the program does not keep is worse than silence,
// because the person waits for it. So the notice says what happened, with
// the cause when there is one, and what the person has to do: send again.
//
// Pure, exported for the tests. Returns null for anything that is not one
// of these failures -- those are bugs and stay loud.
const CAUSE_MAX_CHARS = 220

export function unansweredNotice(err) {
  if (!(err instanceof AppError)) return null
  if (err.code === 'CHAT_DAILY_LIMIT') {
    return "The AI provider's daily limit is used up. Your message is saved in the app, but it will not be answered — send it again tomorrow."
  }
  if (err.code === 'CHAT_PROVIDER_BUSY') {
    return 'The AI provider is busy right now. Your message is saved in the app, but nothing will retry it — send it again later.'
  }
  if (err.code === 'DRIVER_UNREACHABLE' || err.code === 'CHAT_UNAVAILABLE') {
    const cause = typeof err.details?.cause === 'string' ? err.details.cause.trim() : ''
    const why = cause ? ` (${cause.length > CAUSE_MAX_CHARS ? `${cause.slice(0, CAUSE_MAX_CHARS)}…` : cause})` : ''
    return `The AI did not answer${why}. Your message is saved in the app, but nothing will retry it — send it again.`
  }
  return null
}

// The one door into the chat. The driver's ANSWER does not come back
// here: driverChat.service writes it with a deliver_at in the future --
// a driver answers when they can stop -- and outgoing.js carries it to
// the group when that moment arrives.
export async function deliver({ driverId, fact, say, app, userId, vision }) {
  const conversation = await app.openConversation({ driverId, userId })
  const payload = { conversationId: conversation.conversation.id, userId, text: fact.text ?? '' }

  if (fact.photos?.length > 0) {
    const decision = photoDecision({ enabled: vision, photoCount: fact.photos.length })
    if (decision.photo) {
      const urls = fact.photos.map((photo) => photo.dataUrl).filter(Boolean)
      if (urls.length > 0) payload.images = urls
      const missing = fact.photos.filter((photo) => !photo.dataUrl)
      if (missing.length > 0) {
        say(`${missing.length === fact.photos.length ? 'The photo' : `${missing.length} of the photos`} did not come through (${missing[0].skipped ?? 'unknown reason'}). The driver was given the text.`)
      }
    } else if (decision.blind) {
      say(BLIND_PHOTO_NOTICE())
    }
    payload.text = incomingRecordText({ caption: fact.text, blind: Boolean(decision.blind) })
  }

  try {
    await app.sendMessage(payload)
  } catch (err) {
    // Two failures the group has to hear about, each named as the thing
    // that actually happened. "The driver is not answering" would be a
    // lie about a person standing right there; the provider is what is
    // not answering. Anything else is a bug and stays loud.
    const notice = unansweredNotice(err)
    if (notice) {
      say(notice)
      return
    }
    throw err
  }
}
