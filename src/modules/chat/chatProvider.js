// Which provider, which model and which key each chat uses -- and whether
// the two chats are spending from the same wallet.
//
// Two env families, each falling back to the shared one:
//
//   CHAT_BROKER_BASE_URL / _API_KEY / _MODEL
//   CHAT_DRIVER_BASE_URL / _API_KEY / _MODEL
//   CHAT_BASE_URL        / _API_KEY / _MODEL      <- what both inherit
//
// Set only CHAT_* and both chats run on one key, sharing one budget. Set
// CHAT_DRIVER_API_KEY as well and the driver chat has its own key and its
// own budget. Nothing in the code chooses between those two arrangements;
// .env does, and the budget follows.

import { readAiConfig } from '../../../scripts/seed/config.js'
import { AppError } from '../../lib/errors.js'
import appConfig from '../../config.js'
import { DEFAULT_CHAT_BASE_URL } from '../../constants/chatBudget.js'

const PREFIX = Object.freeze({ broker: 'CHAT_BROKER', driver: 'CHAT_DRIVER' })

// The error each chat raises when it has no usable configuration. They are
// different codes because they put a sentence about a different person on
// the student's screen, and telling a dispatcher the broker is unreachable
// while they are typing to a driver is a lie the code would be telling.
const FAILURE = Object.freeze({ broker: 'CHAT_UNAVAILABLE', driver: 'DRIVER_UNREACHABLE' })

function read(which) {
  return readAiConfig({
    prefix: PREFIX[which],
    fallbackPrefix: 'CHAT',
    defaults: { baseUrl: DEFAULT_CHAT_BASE_URL },
    requireModel: true,
  })
}

// Attach the chat's own fallback model when one is configured.
function withFallback(which, config) {
  // Each chat can switch when its primary model is throttled, and only when
  // its own CHAT_*_FALLBACK_MODEL names one (blank = no fallback). The
  // fallback is a model id on the SAME base URL and key as the primary, so
  // it works on any provider; whether that provider has the model is for
  // .env to get right.
  const fallbackModel = which === 'driver'
    ? appConfig.chatDriverFallbackModel
    : appConfig.chatBrokerFallbackModel
  if (fallbackModel && config.model !== fallbackModel) {
    return { ...config, fallbackModel }
  }
  return config
}

export function chatConfigFor(which) {
  const { config, errors } = read(which)
  if (!config) throw new AppError(FAILURE[which], errors.join('; '))
  // `chat` names whose config this is: the request builder picks the
  // reasoning effort per chat (chatBudget.js groqReasoningEffort).
  return { ...withFallback(which, config), chat: which }
}

// Do the two chats spend from one allowance or two?
//
// Answered by comparing the resolved base URL and key, never by asking
// whether a particular variable happens to be set: CHAT_DRIVER_API_KEY can
// be present and hold the same key as CHAT_API_KEY, and treating that as
// two budgets would let one key be spent twice.
//
// The keys are compared, never logged, never returned and never put in an
// error. Only the answer leaves this function.
export function walletScopeFor(which) {
  const mine = read(which).config
  const other = read(which === 'broker' ? 'driver' : 'broker').config

  // One side unconfigured means there is nothing to share with. The
  // configured side stands alone rather than being told it shares a
  // budget with a chat that cannot make a call at all.
  if (!mine || !other) return which

  const same = mine.baseUrl === other.baseUrl && mine.apiKey === other.apiKey
  return same ? 'both' : which
}

// For the diagnostic and the startup log: what is configured, with no key
// material in it. `keyFingerprint` is the first four characters, which is
// enough to see at a glance that two chats hold the same key or different
// ones, and not enough to be a key.
export function describeChat(which) {
  const { config: base, errors } = read(which)
  if (!base) return { which, ok: false, errors }
  const config = withFallback(which, base)
  return {
    which,
    ok: true,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel ?? null,
    keyFingerprint: `${config.apiKey.slice(0, 4)}…(${config.apiKey.length})`,
    wallet: walletScopeFor(which),
  }
}
