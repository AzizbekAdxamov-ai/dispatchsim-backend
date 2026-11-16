// Route wiring for /finance/*. Mounted at /finance in app.js. Gated to the
// `finance` role, same reasoning as fleet.routes.js.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as financeController from './finance.controller.js'

const router = Router()

router.use(requireAuth, requireRole('finance'))

router.get('/overview', financeController.getOverview)
router.get('/invoices', financeController.listInvoices)
router.get('/invoices/:id', financeController.getInvoice)
router.post('/invoices/:id/send', financeController.sendInvoice)
router.post('/invoices/:id/remind', financeController.remindInvoice)
router.get('/settlements', financeController.listSettlements)
router.get('/expenses', financeController.listExpenses)

export default router
