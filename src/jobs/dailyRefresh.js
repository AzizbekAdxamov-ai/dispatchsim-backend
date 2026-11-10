// Daily posting refresh job.
//
// Runs at 04:00 server time via node-cron, with a startup check that
// catches up if the last refresh was missed (e.g. server was down).
//
// THE STARTUP CHECK USED TO BE THE EXPENSIVE ONE. On 2026-09-10 it
// emptied a Groq daily quota during ordinary development: one refresh was
// 20 posting batches plus applicants plus truck listings, roughly two
// dozen model calls, and it fired on EVERY backend restart. Worse, the
// check that decides whether to refresh looks at how many postings are
// LIVE: when the calls failed, no postings were created, so the next
// restart saw an empty board and tried again. Failure fed the retry that
// caused it.
//
// So the attempt is recorded, not just the success, and a failed run
// holds the job off for a while. `sim_state` already exists for exactly
// this kind of "when did this last happen" fact.
//
// A REFRESH NOW COSTS NOTHING. scripts/refresh-postings.js was rewritten
// to derive every posting, applicant and listing from scripts/seed/
// generate.js, which makes no network call of any kind -- `grep aiClient
// scripts/refresh-postings.js` returns nothing. The guard below is kept
// anyway: it protects against a refresh storm, not only against a quota,
// and twenty restarts still means twenty rounds of INSERTs that the board
// did not ask for. What is gone is the reason it was urgent.
//
// The actual generation logic lives in scripts/refresh-postings.js
// (runRefresh export) — this file only handles scheduling and the
// catch-up decision.

import cron from 'node-cron'
import { pool } from '../db/pool.js'
import { POSTING_CONFIG, DEADHEAD_MAX_MI, MIN_NEAR_LOADS } from '../../scripts/seed/postings.js'

let running = false

async function runRefresh(coverageOnly = false) {
  const { runRefresh: refresh, runPostingRefresh } = await import('../../scripts/refresh-postings.js')
  // allowRemote: true is deliberate. This runs on prod (Vercel cron / the
  // /ops/refresh endpoint, protected by OPS_TICK_SECRET) where the database
  // is remote by definition; there is no argv to carry --allow-remote.
  return coverageOnly ? runPostingRefresh({ allowRemote: true }) : refresh({ allowRemote: true })
}

// How long to wait after a failed run before trying again. The original
// reason was a provider that had just refused two dozen model calls and
// was not going to change its mind in the ninety seconds it takes to
// restart a dev server. There are no model calls left to refuse; what can
// still fail is the database, and an hour is short enough that a real
// outage recovers on its own within a working session.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000

// A successful run covers a day by design (POSTING_CONFIG.coverageHours).
const RETRY_AFTER_SUCCESS_MS = 20 * 60 * 60 * 1000

const STATE_KEY = 'daily_refresh'

// A healthy national pool only needs a small posting refresh when a truck
// loses nearby options; it does not need new applicants or truck listings.
export const coverageOnlyRefresh = (coverageHealthy, marketNeedsRefresh) => !coverageHealthy && !marketNeedsRefresh

// Azizbek qarori 2026-11-04: inspect only currently visible open postings.
export async function fleetCoverageHealthy(runner = pool) {
  const { activeTruckLocations } = await import('../../scripts/refresh-postings.js')
  const locations = await activeTruckLocations(runner)
  for (const truck of locations) {
    const result = await runner.query(`SELECT count(DISTINCT destination_state)::int AS n FROM load_postings
      WHERE status = 'open' AND posted_at <= now() AND expires_at > now()
      AND road_miles($1, $2, origin_lat, origin_lon) <= $3
      AND ($4::text IS NULL OR equipment_type = $4)`,
    [truck.current_lat, truck.current_lon, DEADHEAD_MAX_MI, truck.trailer_type ?? null])
    if (Number(result.rows[0].n) < MIN_NEAR_LOADS) return false
  }
  return true
}

async function readState() {
  const result = await pool.query(
    `SELECT value FROM sim_state WHERE key = $1`, [STATE_KEY],
  )
  return result.rows[0]?.value ?? null
}

async function writeState(value) {
  await pool.query(
    `INSERT INTO sim_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STATE_KEY, JSON.stringify(value)],
  )
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

// Exported, and it says what it did.
//
// It returned undefined on every path, which was fine while the only
// caller was a timer that ignored the answer. src/modules/ops/ops.routes.js
// is an HTTP endpoint a scheduler calls, and an endpoint that cannot tell
// "refreshed" from "still in its cooldown" from "the board was fine"
// reports the same 200 for all three -- so a refresh that silently stopped
// happening would look exactly like one that ran.
//
//   ran       a refresh happened
//   busy      another call is inside one right now
//   cooldown  too soon since the last attempt
//   healthy   the board does not need one
//   failed    it was attempted and threw
export const OUTCOME = Object.freeze({
  RAN: 'ran', BUSY: 'busy', COOLDOWN: 'cooldown', HEALTHY: 'healthy', FAILED: 'failed',
})

export async function refreshIfNeeded(reason) {
  if (running) return OUTCOME.BUSY
  running = true
  try {
    // The cooldown is checked BEFORE the board-health check, and that
    // order is the whole point. Health says "the board is empty, generate
    // something"; when generation is what failed, the empty board is the
    // SYMPTOM and obeying it spends another two dozen calls on the same
    // refusal.
    const state = await readState()
    if (state?.lastAttemptAt) {
      const since = Date.now() - new Date(state.lastAttemptAt).getTime()
      const wait = state.ok ? RETRY_AFTER_SUCCESS_MS : RETRY_AFTER_FAILURE_MS
      if (since < wait && (!state.ok || await fleetCoverageHealthy())) {
        const mins = Math.ceil((wait - since) / 60000)
        console.log(
          `[dailyRefresh] skip — last attempt ${state.ok ? 'succeeded' : 'failed'}` +
          ` ${Math.round(since / 60000)} min ago, next in ${mins} min (${reason})`,
        )
        return OUTCOME.COOLDOWN
      }
    }

    const coverageHealthy = await fleetCoverageHealthy()
    const marketNeedsRefresh = await shouldRefresh()
    const needRefresh = !coverageHealthy || marketNeedsRefresh
    if (!needRefresh) {
      console.log(`[dailyRefresh] skip — board is healthy (${reason})`)
      return OUTCOME.HEALTHY
    }

    console.log(`[dailyRefresh] starting refresh (${reason})`)
    // Recorded BEFORE the run, so a crash mid-refresh still counts as an
    // attempt. A cooldown that only survives a clean failure is no
    // cooldown at all.
    await writeState({ lastAttemptAt: new Date().toISOString(), ok: false, reason })
    await runRefresh(coverageOnlyRefresh(coverageHealthy, marketNeedsRefresh))
    await writeState({ lastAttemptAt: new Date().toISOString(), ok: true, reason })
    console.log(`[dailyRefresh] refresh complete (${reason})`)
    return OUTCOME.RAN
  } catch (err) {
    if (err.quotaExhausted) {
      // Said plainly, because it is not a bug and the fix is not in this
      // codebase. Silence here reads as a broken generator.
      console.error(
        `[dailyRefresh] stopped — the AI provider is out of quota (${reason}).` +
        ` Existing postings are untouched; nothing new until the quota resets.`,
      )
    } else {
      console.error(`[dailyRefresh] failed (${reason}): ${err.message}`)
    }
    return OUTCOME.FAILED
  } finally {
    running = false
  }
}

export function startJobs() {
  if (process.env.NODE_ENV === 'test') return
  // No AI key check. The generator makes every row locally now; refusing
  // to schedule it because a provider key is absent would leave the board
  // empty for a reason that no longer applies.

  // Startup check — catch up if needed
  refreshIfNeeded('startup')

  // Daily at 04:00
  cron.schedule('0 4 * * *', () => refreshIfNeeded('cron'))
  // Azizbek qarori 2026-11-04: recheck expiring/booked nearby postings every 15 minutes.
  cron.schedule('*/15 * * * *', () => refreshIfNeeded('coverage'))
}
