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

// The app, as the bot needs it. One object, so a test can replace it
// whole: every call below goes through here and nothing reaches around
// it to the database.
export const realApp = {
  driversList: repo.driversList,
  driversByName: repo.driversByName,
  driverById: repo.driverById,
  getCarrier,
  openConversation: driverChat.openConversation,
  sendMessage: driverChat.sendMessage,
}

const HELP_LINES = [
  'Commands:',
  '/d <name> — set which driver this chat is talking to',
  '/drivers — list the drivers',
  '/help — this list',
  'Anything else is sent to the driver: reply to one of my messages, or pick a driver with /d first.',
]

export function helpText(carrierName) {
  return [carrierName ? `${carrierName} — driver dispatch` : 'Driver dispatch', '', ...HELP_LINES].join('\n')
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
    return 'No code needed any more — this group is already the dispatch group.'
  }
  return HELP_LINES.join('\n')
}

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
      // One fixed driver short-circuits the question: the group talks, the
      // driver answers. Resolved here rather than in the router because it
      // needs the database (does the name still match anyone?), and the
      // router is the one place that must stay pure.
      if (fixedDriverName) {
        const matches = await app.driversByName(fixedDriverName)
        if (matches.length === 1) {
          next = { ...next, currentDriverId: matches[0].id }
          await deliver({ driverId: matches[0].id, fact, say, app, userId, vision })
          break
        }
        say(`The configured driver "${fixedDriverName}" is not on the roster${matches.length > 1 ? ' (more than one by that name)' : ''}. Fix TELEGRAM_DRIVER_NAME in .env.`)
        break
      }
      const roster = await app.driversList()
      say(`Who is this for? Reply to one of my messages, or pick with /d <name>:\n${rosterText(roster)}`)
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
