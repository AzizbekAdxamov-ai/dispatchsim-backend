// The one seam between this process and Telegram's HTTP API.
//
// Every network call the bot makes goes through the object this factory
// returns, and every test hands in a fake -- so a test never opens a
// connection and cannot be broken by one.
//
// The six methods are exactly the Bot API calls this bot needs:
//   getMe           who this token belongs to, and what it may read
//   sendMessage     push a line into the group
//   sendChatAction  the "typing…" indicator, so an answer does not pop
//                   in out of nowhere like a machine's
//   getUpdates      long-poll for what people typed
//   getFile         resolve an incoming photo's file_id into a path
//   downloadFile    fetch that path's bytes
//
// Errors come back as plain Errors with a `status` attached (the HTTP
// status when there was one): the seam names the fact, the caller names
// the consequence.

const API_BASE = 'https://api.telegram.org'

export function createTelegramClient({ token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('createTelegramClient requires a token')

  async function call(method, body) {
    let res
    try {
      res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    } catch (err) {
      const e = new Error(`telegram ${method}: network error (${err.message})`)
      e.status = 0
      throw e
    }
    const payload = await res.json().catch(() => null)
    // The Bot API wraps everything in { ok, result, description }. ok=false
    // is an ANSWER (a 400 with "message is too long", say), not a network
    // failure -- the description is the useful part, so it rides the error.
    if (!res.ok || !payload?.ok) {
      const e = new Error(`telegram ${method}: ${payload?.description ?? `HTTP ${res.status}`}`)
      e.status = res.status
      throw e
    }
    return payload.result
  }

  return {
    // Answers two questions at once: is the token good, and is privacy
    // mode off. A bot with privacy ON is handed only commands addressed
    // to it -- it sits in the group and never sees a word of an ordinary
    // message, which looks exactly like a broken bridge.
    getMe: () => call('getMe'),
    // Can this bot talk to that chat at all, and what IS that chat? The
    // answer to the second question is worth printing: a group id is
    // negative and a private chat's is positive, and nothing else in the
    // bot ever says which one .env is pointed at.
    getChat: (chatId) => call('getChat', { chat_id: chatId }),
    sendMessage: (chatId, text) => call('sendMessage', { chat_id: chatId, text }),
    // Best-effort by nature: an indicator nobody saw is nothing lost. The
    // caller still decides what a failure means -- this only reports it.
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    getUpdates: (offset, timeoutSec) => call('getUpdates', { offset, timeout: timeoutSec }),
    getFile: (fileId) => call('getFile', { file_id: fileId }),
    // filePath comes from getFile's result; the token authenticates the
    // download, so this endpoint sits on the bot token too.
    downloadFile: async (filePath) => {
      const res = await fetchImpl(`${API_BASE}/file/bot${token}/${filePath}`)
      if (!res.ok) {
        const e = new Error(`telegram downloadFile: HTTP ${res.status}`)
        e.status = res.status
        throw e
      }
      return Buffer.from(await res.arrayBuffer())
    },
  }
}
