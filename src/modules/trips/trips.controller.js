import * as service from './trips.service.js'
import { planTripSchema } from './trips.schemas.js'

// POST /trips/plan
export async function plan(req, res) {
  const { waypoints, truck } = planTripSchema.parse(req.body)
  res.status(200).json(await service.planTrip({ waypoints, truck }))
}
