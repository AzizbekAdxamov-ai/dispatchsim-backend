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

export function helpText(carrierName, driver = null) {
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
export async function handleUpdate(fact, { state, app = realApp, userId, vision = false, fixedDriverName = null }) {
  const replies = []
  const say = (text) => { replies.push(text) }
  let next = state

  const intent = routeUpdate({
    text: fact.text ?? '',
    replyToTelegramMessageId: fact.replyToTelegramMessageId ?? null,
    currentDriverId: state.currentDriverId ?? null,
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
        say(helpText(carrier?.name, context.driver))
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
    if (err instanceof AppError && err.code === 'CHAT_DAILY_LIMIT') {
      say("The AI provider's daily limit is used up. Messages still land in the app; replies resume tomorrow.")
      return
    }
    if (err instanceof AppError && (err.code === 'DRIVER_UNREACHABLE' || err.code === 'CHAT_UNAVAILABLE')) {
      say('The chat provider is not answering right now. Your message is in the app; the reply will come when it is back.')
      return
    }
    throw err
  }
}
