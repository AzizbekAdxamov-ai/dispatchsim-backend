import * as service from './payroll.service.js'

// GET /payroll/settlements — every settlement, with what is owed and what
// payroll would move right now.
export async function listSettlements(req, res) {
  res.status(200).json(await service.listSettlements())
}

// GET /payroll/owed — per driver: how much, how overdue, and what that
// means for whether they will take the next load.
export async function listOwed(req, res) {
  res.status(200).json({ drivers: await service.listOwed() })
}

// POST /payroll/run — pay everything that is due.
//
// Not idempotent by request, and it does not need to be: the settlements
// themselves are. Running it twice pays nothing the second time because
// paid_at is already set and cash_ledger_once_per_ref refuses a duplicate.
export async function run(req, res) {
  res.status(200).json(await service.runPayroll({ userId: req.auth.userId }))
}
