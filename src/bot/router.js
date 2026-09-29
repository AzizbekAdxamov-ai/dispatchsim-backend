// What one incoming Telegram update MEANS, decided before anything is
// touched. Pure: given the update's facts, return a labelled intent.
// No database, no network, no clock -- the caller resolves the intent.
//
// The bridge never GUESSES who a message is for. Three ways to know, in
// strict order (plan section 2):
//   1. reply  -> the answered message names the thread
//   2. /d     -> the chat's current driver
//   3. else   -> ask, with the roster
// A wrong guess is the worst kind of silent failure -- words meant for
// one driver land in another's thread and nobody sees the mistake.
//
// Command grammar (everything else is a message):
//   /link <code>   bind this chat to a dispatcher account
//   /d <ism>       set who the chat is talking to
//
// The two that take an argument have a third outcome besides "did it"
// and "cannot": typed without the argument. That is 'usage' -- one
// sentence naming the missing word, not the whole list.
//   /drivers       print the roster
//   /help          print the commands
//
// Not linked? That is a fact about the CHAT, decided by the caller after
// the router: the router has no right to send anything anywhere.

// Parse "/cmd args..." -- the command word lower-cased, arguments verbatim
// (names may carry any spacing the user typed).
function parseCommand(text) {
  const match = /^\/([A-Za-z]+)(?:\s+(.*))?$/.exec(text.trim())
  if (!match) return null
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() }
}

export function routeUpdate({ text, replyToTelegramMessageId, currentDriverId }) {
  const command = parseCommand(text ?? '')

  // Commands are commands even as replies -- /link inside a reply still
  // binds the chat; only plain text falls through to the reply target.
  if (command) {
    switch (command.command) {
      case 'link':
        // Missing code: say what is missing rather than guess. This used
        // to route to 'help', and help is a LIST -- the whole command
        // grammar printed back at someone who typed one command slightly
        // wrong, with no line saying which part was wrong. Azizbek sent
        // a bare /link on 2026-09-29 and got four commands and no idea
        // what had happened. The code's format is the DB's CHECK; the
        // router only says which word is absent.
        return command.args
          ? { kind: 'link', code: command.args.toUpperCase() }
          : { kind: 'usage', command: 'link' }
      case 'd':
        return command.args
          ? { kind: 'set-driver', name: command.args }
          : { kind: 'usage', command: 'd' }
      case 'drivers':
        return { kind: 'drivers' }
      case 'help':
        return { kind: 'help' }
      default:
        // An unknown slash-word is probably a mistyped sentence, not a
        // message -- silently ignoring it beats dropping '/delivered to
        // Boston' into a driver's thread.
        return { kind: 'ignore' }
    }
  }

  // A reply to one of the bot's messages names the thread. The id is
  // resolved to a conversation by the caller (telegram_deliveries).
  if (replyToTelegramMessageId) {
    return { kind: 'to-driver', replyToTelegramMessageId }
  }

  // No reply: the chat's standing /d choice, if one is set. The caller
  // checks the link still exists and the driver still does.
  if (currentDriverId) {
    return { kind: 'to-current', driverId: currentDriverId }
  }

  // Nothing names a recipient. Ask, with the roster -- never pick.
  return { kind: 'ask-who' }
}
