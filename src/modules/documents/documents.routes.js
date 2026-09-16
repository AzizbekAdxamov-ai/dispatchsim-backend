// Route wiring for /documents. Mounted at /documents in app.js.
//
// Reads, open to every granted role: paperwork is evidence, and the roles
// all have a reason to open it -- dispatch carries the BOL, finance chases
// the invoice, everyone reads the POD when a broker claims a shortage.

import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireRole } from '../../middleware/requireRole.js'
import * as controller from './documents.controller.js'

const router = Router()

router.use(requireAuth, requireRole())

router.get('/loads/:loadId/bol.pdf', controller.bolPdf)
router.get('/loads/:loadId/pod.pdf', controller.podPdf)
router.get('/invoices/:invoiceId/invoice.pdf', controller.invoicePdf)

export default router
