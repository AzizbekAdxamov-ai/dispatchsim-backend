// Process entry point: starts the HTTP server and wires up graceful
// shutdown. Application wiring itself lives in app.js.

import app from './app.js'
import config from './config.js'
import { pool } from './db/pool.js'
import { startJobs } from './jobs/dailyRefresh.js'
import { startOpsTick } from './jobs/opsTick.js'
import { describeTelegram } from './constants/telegramMeta.js'

const server = app.listen(config.port, () => {
  console.log('DispatchSim API → http://localhost:' + config.port)
  startJobs()
  startOpsTick()
  // One line, no token in it: is the bot configured, and what is it set
  // to. The bot itself is a separate process (`npm run bot`); a bot
  // sitting silent in a group should be explainable from this boot log
  // alone, without anyone opening the code.
  const tg = describeTelegram(config)
  console.log(tg.ok
    ? `[telegram] bot configured — group ${tg.chatId}, dispatcher ${tg.dispatcherEmail}, vision ${tg.vision ? 'on' : 'off'}, token ${tg.tokenFingerprint} (run it: npm run bot)`
    : `[telegram] bot off — ${tg.reason}`)
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

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
