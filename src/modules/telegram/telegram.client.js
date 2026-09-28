// The one seam between this codebase and Telegram's HTTP API.
//
// Everything the bridge does with the network goes through the object
// this factory returns, and every test hands in a fake -- the same
// arrangement chargeInterest({ run }) uses: the test never opens a
// connection, so it cannot be broken by one.
//
// The four methods are exactly the Bot API calls this app needs:
//   sendMessage    push a line into the group
//   getUpdates     long-poll for what people typed
//   getFile        resolve an incoming photo's file_id into a path
//   downloadFile   fetch that path's bytes (vision, stage 5)
//
// Errors come back as plain Errors with a `status` attached (the HTTP
// status when there was one) -- callers name the consequence, the seam
// names the fact. Nothing here knows about the outbox, the links or the
// router; those live above and inject this factory where they need it.

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
    sendMessage: (chatId, text) => call('sendMessage', { chat_id: chatId, text }),
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
