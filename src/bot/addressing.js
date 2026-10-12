// Is this message meant for the driver, or for the other person in the
// group?
//
// In a private chat every message is for the driver: there is nobody
// else to talk to. A GROUP with two dispatchers in it (Azizbek,
// 2026-10-01: "I'll add the bot to the group and one more dispatcher;
// they talk to each other") is different. Most of what is typed there is
// the two people talking -- "did you book the Dallas one?" -- and a bot
// that answers every line puts words in the driver's mouth about a
// conversation she was never in, and spends a model call on each of
// them out of a budget of a few dozen a day.
//
// So in a group the driver hears only what is addressed to her, the way
// a person in a group chat does:
//   - a reply to one of the bot's lines (Telegram's "reply"),
//   - an @mention of the bot,
//   - her first name, as a word ("Grace, where are you?").
// Commands (/status, /help) are for the bot, not her, and always pass:
// the router decides what they mean.
//
// Pure: facts in, a yes or no out. No network, no database, no clock.

const GROUP_TYPES = new Set(['group', 'supergroup'])

// Telegram says what kind of chat it is. When it does not (an old update,
// a test fact), a group's id is negative and a person's is positive --
// the same fact the boot log prints.
export function isGroupChat(chatType, chatId) {
  if (chatType) return GROUP_TYPES.has(chatType)
  return Number(chatId) < 0
}

// The name people call the driver by: the first word of the configured
// name. "Grace Lindqvist" -> "Grace".
export function callName(driverName) {
  const first = String(driverName ?? '').trim().split(/\s+/)[0]
  return first || null
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A whole word, any case, letters on neither side -- so "Grace" matches
// "grace, you there?" and "Hi Grace!" but not "Graceland".
export function mentionsName(text, name) {
  if (!name) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}($|[^\\p{L}\\p{N}_])`, 'iu').test(String(text ?? ''))
}

export function mentionsBot(text, botUsername) {
  if (!botUsername) return false
  return new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'i').test(String(text ?? ''))
}

// "@DispatchBot where are you" -> "where are you". The handle is how the
// group reaches the bot; the driver should read the sentence, not the
// plumbing.
export function stripBotMention(text, botUsername) {
  if (!botUsername || typeof text !== 'string') return text
  return text.replace(new RegExp(`@${escapeRegExp(botUsername)}\\b[,:]?\\s*`, 'gi'), '').trim()
}

function repliesToBot(fact, botUsername) {
  if (!fact.replyToTelegramMessageId || !fact.replyToFromBot) return false
  // With the bot's own handle known, a reply to SOME OTHER bot in the
  // group is not a reply to this one.
  if (botUsername && fact.replyToUsername) {
    return fact.replyToUsername.toLowerCase() === botUsername.toLowerCase()
  }
  return true
}

export function addressedToDriver(fact, { botUsername = null, driverName = null } = {}) {
  if (!fact) return false
  if (!isGroupChat(fact.chatType, fact.chatId)) return true
  const text = fact.text ?? ''
  if (text.trim().startsWith('/')) return true
  if (repliesToBot(fact, botUsername)) return true
  if (mentionsBot(text, botUsername)) return true
  return mentionsName(text, callName(driverName))
}
