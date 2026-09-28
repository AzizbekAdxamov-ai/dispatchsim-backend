// Process entry point: starts the HTTP server and wires up graceful
// shutdown. Application wiring itself lives in app.js.

import app from './app.js'
import config from './config.js'
import { pool } from './db/pool.js'
import { startJobs } from './jobs/dailyRefresh.js'
import { startOpsTick } from './jobs/opsTick.js'
import { startTelegramPush } from './jobs/telegramPush.js'
import { startTelegramPoll, stopTelegramPoll } from './jobs/telegramPoll.js'
import { describeTelegram } from './constants/telegramMeta.js'

const server = app.listen(config.port, () => {
  console.log('DispatchSim API → http://localhost:' + config.port)
  startJobs()
  startOpsTick()
  // The bridge's two halves. Each checks the switch itself and logs its
  // own off-line, so the boot log always explains the bridge's state.
  startTelegramPush()
  startTelegramPoll()
  // One line, no token in it: is the bridge on, and how does it listen.
  // A bot sitting silent in a group should be explainable from the boot
  // log alone, without anyone opening the code.
  const tg = describeTelegram(config)
  console.log(tg.ok
    ? `[telegram] bridge on — mode ${tg.mode}, ${tg.allowedChats === null ? 'any chat' : `${tg.allowedChats} allowed chat(s)`}, vision ${tg.vision ? 'on' : 'off'}, token ${tg.tokenFingerprint}`
    : `[telegram] bridge off — ${tg.reason}`)
})

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`)
  server.close(async (err) => {
    if (err) {
      console.error('Error while closing HTTP server:', err)
    }
    try {
      await pool.end()
    } catch (poolErr) {
      console.error('Error while closing PostgreSQL pool:', poolErr)
    }
    process.exit(err ? 1 : 0)
  })
}

process.on('SIGINT', () => { stopTelegramPoll(); shutdown('SIGINT') })
process.on('SIGTERM', () => { stopTelegramPoll(); shutdown('SIGTERM') })
