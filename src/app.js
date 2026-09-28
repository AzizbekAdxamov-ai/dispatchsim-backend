// Express application setup: middleware stack and route mounting only.
// Actual listening happens in server.js so this file can be imported by
// tests without opening a network port.

import express from 'express'
import cors from 'cors'
import config from './config.js'
import authRoutes from './modules/auth/auth.routes.js'
import adminRoutes from './modules/admin/admin.routes.js'
import loadsRoutes from './modules/loads/loads.routes.js'
import driversRoutes from './modules/drivers/drivers.routes.js'
import statsRoutes from './modules/stats/stats.routes.js'
import fleetRoutes from './modules/fleet/fleet.routes.js'
import financeRoutes from './modules/finance/finance.routes.js'
import loadBoardRoutes from './modules/loadBoard/loadBoard.routes.js'
import brokerChatRoutes from './modules/brokerChat/brokerChat.routes.js'
import brokerCheckRoutes from './modules/brokerCheck/brokerCheck.routes.js'
import cashRoutes from './modules/cash/cash.routes.js'
import alertsRoutes from './modules/alerts/alerts.routes.js'
import payrollRoutes from './modules/payroll/payroll.routes.js'
import driverChatRoutes from './modules/driverChat/driverChat.routes.js'
import telegramRoutes from './modules/telegram/telegram.routes.js'
import opsRoutes from './modules/ops/ops.routes.js'
import hrRoutes from './modules/hr/hr.routes.js'
import trackingRoutes from './modules/tracking/tracking.routes.js'
import documentsRoutes from './modules/documents/documents.routes.js'
import facilitiesRoutes from './modules/facilities/facilities.routes.js'
import complianceRoutes from './modules/compliance/compliance.routes.js'
import tripsRoutes from './modules/trips/trips.routes.js'
import { notFound } from './middleware/notFound.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

// Trust the first hop proxy (e.g. a load balancer/reverse proxy in front of
// the app). Needed for req.ip / X-Forwarded-For to be read correctly, which
// express-rate-limit relies on to key limits per real client IP.
app.set('trust proxy', 1)

// `credentials` is intentionally omitted: the API is authenticated with a
// Bearer token in the Authorization header, not cookies, so there is no
// need to allow credentialed cross-origin requests.
//
// In development the allowed origin is any port on localhost, not one
// hardcoded port. Vite takes the next free port when 5173 is busy -- two
// dev servers running at once is ordinary -- and the page served on 5174
// then had EVERY request refused by this line. The browser hides a CORS
// refusal from the page (that is the point of it), so the app saw a
// generic network failure and told the user "Cannot reach the server. Is
// the API running?" while the API was answering /health perfectly well.
// An error that names the wrong cause costs more than the bug it reports.
//
// Production is unchanged: one origin, from CORS_ORIGIN, and no wildcard.
// A localhost origin is only reachable from the developer's own machine,
// so widening it there grants nobody anything they did not already have.
const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

app.use(cors({
  origin: config.isProd
    ? config.corsOrigin
    : (origin, cb) => cb(null, !origin || origin === config.corsOrigin || LOCALHOST_ORIGIN.test(origin)),
}))

app.use(express.json({ limit: '100kb' }))

// Unauthenticated, unrated liveness check for load balancers/uptime checks.
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true })
})

app.use('/auth', authRoutes)
app.use('/admin', adminRoutes)
app.use('/loads', loadsRoutes)
app.use('/drivers', driversRoutes)
app.use('/stats', statsRoutes)
app.use('/fleet', fleetRoutes)
app.use('/finance', financeRoutes)
app.use('/alerts', alertsRoutes)
app.use('/payroll', payrollRoutes)
app.use('/driver-chat', driverChatRoutes)
app.use('/telegram', telegramRoutes)
app.use('/load-board', loadBoardRoutes)
app.use('/broker-chat', brokerChatRoutes)
app.use('/broker-check', brokerCheckRoutes)
app.use('/cash', cashRoutes)
app.use('/ops', opsRoutes)
app.use('/hr', hrRoutes)
app.use('/tracking', trackingRoutes)
app.use('/documents', documentsRoutes)
app.use('/facilities', facilitiesRoutes)
app.use('/compliance', complianceRoutes)
app.use('/trips', tripsRoutes)

// Must stay last, in this order: notFound only catches requests that fell
// through every real route above, and errorHandler must be the very last
// middleware so it can catch errors from notFound too.
app.use(notFound)
app.use(errorHandler)

export default app
