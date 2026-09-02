// Process entry point: starts the HTTP server and wires up graceful
// shutdown. Application wiring itself lives in app.js.

import app from './app.js'
import config from './config.js'
import { pool } from './db/pool.js'
import { startJobs } from './jobs/dailyRefresh.js'

const server = app.listen(config.port, () => {
  console.log('DispatchSim API → http://localhost:' + config.port)
  startJobs()
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
