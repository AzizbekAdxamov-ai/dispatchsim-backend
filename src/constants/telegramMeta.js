// What the Telegram bridge looks like from the outside: which mode it
// listens in, whether it has a token, and -- for the diagnostic and the
// startup log -- the first four characters of that token.
//
// Mirrors chatProvider.js's describeChat() on purpose: one chat's provider
// diagnostics and this bridge's diagnostics answer the same kind of
// question ("is it configured, and is the thing configured the one I
// think it is") without ever printing the secret that would let someone
// else answer it for themselves.
//
// The token lives in .env only. It is never logged, never returned in
// full, never written into a test or a commit message. Four characters
// is enough to see at a glance that two environments hold the same bot
// or different ones, and not enough to be a token.
//
// Kept beside the config rather than inside chatProvider.js: the bridge
// has no provider to choose, and a function that only ever read one
// variable has no business sitting in a module about provider keys.

export const TELEGRAM_MODES = Object.freeze(['poll', 'webhook'])

export function describeTelegram(config) {
  if (!config.telegramEnabled) {
    return { ok: false, reason: 'TELEGRAM_BOT_TOKEN is empty — bridge is off' }
  }
  return {
    ok: true,
    mode: config.telegramMode,
    allowedChats: config.telegramAllowedChatIds.length > 0
      ? config.telegramAllowedChatIds.length
      : null, // null = any chat
    tokenFingerprint: `${config.telegramToken.slice(0, 4)}…(${config.telegramToken.length})`,
    vision: config.chatDriverVision,
  }
}
