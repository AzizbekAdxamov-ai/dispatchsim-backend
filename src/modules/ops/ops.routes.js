// The tick, reachable over HTTP.
//
// node-cron only exists inside a process that keeps running. On Vercel
// there is no such process: api/index.js exports the Express app and
// server.js -- the only file that calls startOpsTick() -- is never
// imported. So on the deployed app no load was ever delivered, no invoice
// was ever paid, no interest was ever charged. The entire cash model that
// migrations 019-022 exist for was dead in production and alive only on
// the developer's laptop.
//
// This endpoint is the serverless half: a scheduler calls it, it runs one
// tick, it returns. Locally node-cron still drives the same function, and
// both are safe to run at once -- every stage is guarded by a conditional
// UPDATE, a unique index or SELECT ... FOR UPDATE, which is what made the
// tick idempotent in the first place.
import { Router } from 'express'
import { runTick } from '../loads/dispatch.service.js'
import { refreshIfNeeded, OUTCOME } from '../../jobs/dailyRefresh.js'
import { requireOpsSecret } from '../../middleware/opsSecret.js'

const router = Router()

// Secret check (constant time, both header shapes) lives in the middleware.
router.use(requireOpsSecret)

// GET as well as POST. Vercel's scheduler issues an HTTP **GET** to the
// path named in vercel.json -- confirmed in their docs, not assumed -- so
// a POST-only route would never be called and the bug this endpoint
// exists to fix would still be there, now with a config file that made it
// look fixed.
//
// Not requireAuth: a cron service has no session. Without a secret
// configured the endpoint refuses rather than running unauthenticated --
// an open tick endpoint would let anyone drive the company's clock.
//
// Auth: see middleware/opsSecret.js. Set OPS_TICK_SECRET and CRON_SECRET to
// the same value and either header shape works.
async function handleTick(req, res, next) {
  try {
    const result = await runTick()
    res.status(200).json({
      delivered: result.delivered.length,
      paid: result.paid.length,
      stopsSettled: result.stopsSettled.length,
      late: result.late.length,
      interestUsd: result.interest?.amountUsd ?? 0,
      insuranceUsd: result.insurance?.amountUsd ?? 0,
    })
  } catch (err) {
    next(err)
  }
}

// The daily board refresh, reachable the same way and for the same reason.
//
// The comment at the top of this file describes a bug: node-cron only
// exists inside a process that keeps running, server.js is the only file
// that starts it, and Vercel never imports server.js -- so on the deployed
// app the tick never ran. That was found and fixed for the tick.
//
// dailyRefresh.js had the identical defect and kept it. startJobs() is
// called from server.js and nowhere else, so on Vercel no posting was ever
// refreshed. Nothing would look broken on the day of a deploy: the board
// is full, because refresh:postings was run by hand before shipping. It
// empties about twenty-six hours later (POSTING_CONFIG.coverageHours),
// with no error anywhere, and the app looks like it has no freight.
//
// Same shape as the tick: the scheduler calls it, it runs one refresh, it
// returns. refreshIfNeeded keeps its own cooldown in sim_state, so calling
// this more often than needed costs a database round trip and does
// nothing else -- which is what makes it safe to point a once-an-hour
// scheduler at it and not think about it again.
async function handleRefresh(req, res, next) {
  try {
    const outcome = await refreshIfNeeded('http')
    // The outcome, not a boolean. "refreshed: false" covers three
    // different situations and only one of them is worth looking into.
    res.status(200).json({ outcome, refreshed: outcome === OUTCOME.RAN })
  } catch (err) {
    next(err)
  }
}

router.get('/tick', handleTick)
router.post('/tick', handleTick)
router.get('/refresh', handleRefresh)
router.post('/refresh', handleRefresh)

export default router
