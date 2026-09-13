// Route wiring for /payroll. Mounted at /payroll in app.js.
import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './payroll.controller.js'

const router = Router()

// Every role, like /cash. A dispatcher who cannot see that three drivers
// are owed two weeks of pay will keep assigning loads to people who are
// about to stop taking them.
router.use(requireAuth, requireRole())

router.get('/settlements', controller.listSettlements)
router.get('/owed', controller.listOwed)

// Paying is finance work, and it is the only money-moving POST in the app
// that was left on the blanket requireRole(). Every other one carries its
// own gate -- loads dispatch is 'dispatcher', truck purchase is
// 'fleet-manager', hiring is 'hr'. The reads above stay open to everyone
// on purpose: a dispatcher who cannot see that three drivers are owed two
// weeks of pay will keep assigning loads to people who are about to stop
// taking them. Seeing it is everyone's business; spending the money is
// not.
router.post('/run', requireRole('finance'), controller.run)

export default router
