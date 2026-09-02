// Daily posting refresh job.
//
// Runs at 04:00 server time via node-cron, with a startup check that
// catches up if the last refresh was missed (e.g. server was down).
//
// The actual generation logic lives in scripts/refresh-postings.js
// (runRefresh export) — this file only handles scheduling and the
// catch-up decision.

import cron from 'node-cron'
import { pool } from '../db/pool.js'
import { POSTING_CONFIG } from '../../scripts/seed/postings.js'

let running = false

async function runRefresh() {
  const { runRefresh: refresh } = await import('../../scripts/refresh-postings.js')
  return refresh()
}

async function shouldRefresh() {
  const result = await pool.query(`
    SELECT
      (SELECT count(*) FROM load_postings
        WHERE status='open' AND posted_at <= now() AND expires_at > now()) AS live,
      (SELECT max(created_at) FROM load_postings) AS last_gen
  `)
  const { live, last_gen } = result.rows[0]

  // Refresh if fewer than half the visible target are live, or if
  // we've never generated, or if the last generation was >20h ago.
  if (Number(live) < POSTING_CONFIG.visibleTarget / 2) return true
  if (!last_gen) return true
  if (new Date(last_gen) < new Date(Date.now() - 20 * 60 * 60 * 1000)) return true
  return false
}

async function refreshIfNeeded(reason) {
  if (running) return
  running = true
  try {
    const needRefresh = await shouldRefresh()
    if (needRefresh) {
      console.log(`[dailyRefresh] starting refresh (${reason})`)
      await runRefresh()
      console.log(`[dailyRefresh] refresh complete (${reason})`)
    } else {
      console.log(`[dailyRefresh] skip — board is healthy (${reason})`)
    }
  } catch (err) {
    console.error(`[dailyRefresh] failed (${reason}): ${err.message}`)
  } finally {
    running = false
  }
}

export function startJobs() {
  if (process.env.NODE_ENV === 'test') return
  if (!process.env.AI_API_KEY) {
    console.log('[dailyRefresh] skipped — no AI_API_KEY')
    return
  }

  // Startup check — catch up if needed
  refreshIfNeeded('startup')

  // Daily at 04:00
  cron.schedule('0 4 * * *', () => refreshIfNeeded('cron'))
}
