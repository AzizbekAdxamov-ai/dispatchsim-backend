// HTTP for /carrier. The company's own letterhead: read by everyone,
// changed by an administrator.
import { AppError } from '../../lib/errors.js'
import * as repo from './carrier.repository.js'
import { updateCarrierSchema } from './carrier.schemas.js'

export async function getCarrier(_req, res) {
  const carrier = await repo.getCarrier()
  // 048 seeds the row, so a missing one means a database that has not
  // been migrated -- said plainly rather than answered with an empty
  // object the UI would render as a company with no name.
  if (!carrier) throw new AppError('CARRIER_NOT_SET')
  res.status(200).json(carrier)
}

export async function updateCarrier(req, res) {
  const patch = updateCarrierSchema.parse(req.body)
  const carrier = await repo.updateCarrier(patch)
  if (!carrier) throw new AppError('CARRIER_NOT_SET')
  res.status(200).json(carrier)
}
