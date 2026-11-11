// Anything that only a long-running process would start does not exist on
// Vercel.
//
// api/index.js exports the Express app. server.js -- the only file that
// calls app.listen(), and the only file that starts a node-cron job -- is
// never imported there. So every job scheduled in server.js runs on a
// developer's laptop and nowhere else.
//
// This was found once, for the ops tick, and ops.routes.js says what it
// cost: "on the deployed app no load was ever delivered, no invoice was
// ever paid, no interest was ever charged. The entire cash model that
// migrations 019-022 exist for was dead in production and alive only on
// the developer's laptop."
//
// dailyRefresh.js had the same defect and kept it, because the fix was
// applied to the one job somebody happened to be looking at. Nothing would
// have looked wrong on the day of a deploy either: the board is full,
// because refresh:postings is run by hand before shipping. It empties
// about a day later, silently.
//
// So this file does not test the tick or the refresh. It tests the RULE:
// every job the server starts has a way in over HTTP.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = (p) => readFileSync(join(root, p), 'utf8')

test('every scheduled job is also reachable over HTTP', () => {
  // The rule, stated as a reachability question rather than a file
  // question: for each cron.schedule in src/jobs, the function it fires
  // must be one the ops routes can also fire.
  //
  // Matching by module would have been wrong and would have failed on the
  // job that IS correct -- the tick's route reaches it through
  // dispatch.service.js, not through opsTick.js. What the two paths share
  // is the work function, so that is what is compared.
  const routes = src('src/modules/ops/ops.routes.js')

  const jobs = readdirSync(join(root, 'src', 'jobs'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, text: src(`src/jobs/${f}`) }))

  assert.ok(jobs.length >= 2, `src/jobs/ ichida ${jobs.length} ta fayl — tekshiruv ishlamayapti`)

  const unreachable = []
  for (const job of jobs) {
    const scheduled = [...job.text.matchAll(/cron\.schedule\([^,]+,\s*\(\)\s*=>\s*(\w+)\(/g)]
      .map((m) => m[1])
    if (scheduled.length === 0) continue

    // What that callback ultimately calls: itself, plus anything it awaits
    // that this module imported. One level is enough -- a job whose work
    // is buried deeper than that is a job nobody can follow either.
    const imported = new Set(
      [...job.text.matchAll(/^import \{ ([^}]+) \}/gm)]
        .flatMap(([, names]) => names.split(',').map((n) => n.trim().split(' as ').pop())),
    )
    const candidates = new Set(scheduled)
    for (const name of scheduled) candidates.add(name)
    for (const name of imported) {
      if (new RegExp(`\\b${name}\\(`).test(job.text)) candidates.add(name)
    }

    const reachable = [...candidates].some((name) => new RegExp(`\\b${name}\\(`).test(routes))
    if (!reachable) unreachable.push(`${job.file} (${[...candidates].join(', ')})`)
  }

  assert.deepEqual(unreachable, [],
    `bu ishlar faqat uzoq yashaydigan jarayonda ishlaydi — Vercel'da hech qachon: ${unreachable.join(', ')}`)
})

test('both scheduler endpoints exist and accept GET', () => {
  // Vercel's scheduler issues a GET. A POST-only route would never be
  // called, and the config file would make it look configured.
  const routes = src('src/modules/ops/ops.routes.js')
  for (const path of ['/tick', '/refresh']) {
    assert.match(routes, new RegExp(`router\\.get\\('${path}'`), `GET ${path} yo'q`)
    assert.match(routes, new RegExp(`router\\.post\\('${path}'`), `POST ${path} yo'q`)
  }
})

test('neither endpoint runs without a secret', () => {
  // An open tick endpoint lets anyone drive the company's clock; an open
  // refresh endpoint lets anyone rebuild the board. Every handler the ops
  // routes expose obeys the same two-line rule: no secret configured ->
  // refuse, secret mismatched -> refuse.
  //
  // (The third handler this test used to count, /ops/telegram-push, is
  // gone: the bot folded into this project on 2026-09-29 and carries its
  // own replies -- an outbox for an HTTP scheduler to drain no longer
  // exists.)
  //
  // The secret check moved out of the handlers into middleware/opsSecret.js
  // (constant-time compare). The rule is now: the router applies it before
  // any route, and the middleware keeps both refusals.
  const routes = src('src/modules/ops/ops.routes.js')
  const guard = src('src/middleware/opsSecret.js')
  const useAt = routes.indexOf('router.use(requireOpsSecret)')
  assert.ok(useAt > -1, 'router requireOpsSecret ishlatmayapti')
  assert.ok(useAt < routes.indexOf("router.get('/tick'"), 'guard routelardan keyin turibdi')
  assert.match(guard, /if \(!expected\) return next\(new AppError\('TICK_NOT_CONFIGURED'\)\)/, 'sirsiz ishlayapti')
  assert.match(guard, /new AppError\('UNAUTHORIZED'\)/, 'sirni tekshirmayapti')
})

test('every scheduler endpoint has a scheduler somewhere, and it is written down', () => {
  // Not "vercel.json schedules both". Vercel's Hobby plan refuses any cron
  // more frequent than daily -- the tick needs one a minute, because the
  // company calendar is compressed (a simulated day is thirty real minutes
  // since 2026-11-08, and payments wait on two-minute days) -- so the tick is driven from
  // outside and only the daily refresh is in vercel.json.
  //
  // What must hold is that NOTHING is left with no scheduler at all. An
  // endpoint nobody calls is the same dead job in a different place, and
  // the whole point of adding the route was to stop that happening
  // unnoticed. So each endpoint is either in vercel.json or described in
  // DEPLOY.md, and an endpoint in neither fails here.
  const routes = src('src/modules/ops/ops.routes.js')
  const endpoints = [...routes.matchAll(/router\.get\('(\/\w+)'/g)].map((m) => `/ops${m[1]}`)
  assert.ok(endpoints.length >= 2, `${endpoints.length} ta endpoint topildi`)

  const scheduled = new Set((JSON.parse(src('vercel.json')).crons ?? []).map((c) => c.path))
  const deploy = src('DEPLOY.md')

  const orphans = endpoints.filter((path) => !scheduled.has(path) && !deploy.includes(path))
  assert.deepEqual(orphans, [],
    `bu endpointlarni hech kim chaqirmaydi va hech qayerda yozilmagan: ${orphans.join(', ')}`)
})

test('no cron in vercel.json runs more often than the Hobby plan allows', () => {
  // "Hobby accounts are limited to daily cron jobs. This cron expression
  // would run more than once per day." -- that is a DEPLOY-TIME failure,
  // not a runtime one, so it is caught here rather than by a deploy that
  // is refused.
  // https://vercel.com/docs/cron-jobs/usage-and-pricing (2026-09-13)
  for (const { path, schedule } of JSON.parse(src('vercel.json')).crons ?? []) {
    const [minute, hour] = schedule.split(/\s+/)
    assert.ok(!minute.includes('*') && !minute.includes('/'),
      `${path}: "${schedule}" daqiqada bir necha marta ishlaydi — Hobby rad etadi`)
    assert.ok(!hour.includes('*') && !hour.includes('/'),
      `${path}: "${schedule}" kuniga bir necha marta ishlaydi — Hobby rad etadi`)
  }
})

test('the tick, which vercel cannot schedule, is documented with its header', () => {
  // A deploy guide that says "set up a scheduler" and not which header it
  // sends produces a scheduler returning 401 forever.
  const deploy = src('DEPLOY.md')
  assert.match(deploy, /x-ops-secret/, 'tashqi rejalashtiruvchi sarlavhasi yozilmagan')
  assert.match(deploy, /OPS_TICK_SECRET/, 'sir o\'zgaruvchisi yozilmagan')
  assert.match(deploy, /CRON_SECRET/, 'Vercel cron sarlavhasi yozilmagan')
})

test('the refresh endpoint says which of the four things happened', () => {
  // "refreshed: false" covers a cooldown, a healthy board and a failure.
  // Only one of those is worth looking into, and a scheduler log that
  // cannot tell them apart is a refresh that can stop happening unnoticed.
  const routes = src('src/modules/ops/ops.routes.js')
  assert.match(routes, /outcome/, 'natija qaytarilmayapti')
  const job = src('src/jobs/dailyRefresh.js')
  assert.match(job, /export const OUTCOME/, 'natijalar nomlanmagan')
  for (const state of ['RAN', 'BUSY', 'COOLDOWN', 'HEALTHY', 'FAILED']) {
    assert.match(job, new RegExp(`return OUTCOME\\.${state}`), `${state} hech qachon qaytarilmaydi`)
  }
})
