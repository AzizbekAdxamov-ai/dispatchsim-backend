// What the Telegram bot looks like from the outside: is it wired up, which
// group it sits in and whose threads it speaks for -- without ever printing
// the token itself.
//
// Mirrors chatProvider.js's describeChat() on purpose: both answer the
// same kind of question ("is it configured, and is the thing configured
// the one I think it is") without publishing the secret that would let
// someone else answer it for themselves.
//
// Since 2026-09-29 the bot lives in this project (src/bot, `npm run bot`)
// instead of a second process with its own .env and a shared key: it
// needed this project's database and model client, and an HTTP hop
// between two halves of one bridge was a moving part the job does not
// have. The TOKEN moved in with it -- that is the one real cost of the
// merge -- so the fingerprint below is the token's, and this is the only
// place a boot line may quote it.

export function describeTelegram(config) {
  if (!config.telegramEnabled) {
    return {
      ok: false,
      reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_DISPATCHER_EMAIL are missing — bot is off',
    }
  }
  return {
    ok: true,
    chatId: config.telegramChatId,
    dispatcherEmail: config.telegramDispatcherEmail,
    tokenFingerprint: `${config.telegramBotToken.slice(0, 4)}…(${config.telegramBotToken.length})`,
    vision: config.chatDriverVision,
  }
}
