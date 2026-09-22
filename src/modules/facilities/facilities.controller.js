// HTTP layer for /facilities. No SQL, no business logic -- see
// facilities.service.js. The route already sits behind requireAuth +
// requireRole() (facilities.routes.js).

import { listQuerySchema } from './facilities.schemas.js'
import { SPACING_MI } from '../../../scripts/seed/facilities.js'
import * as facilitiesService from './facilities.service.js'

// GET /facilities?kinds=fuel,truck_stop&near=lat,lon&radiusMi=
//
// `near` present -> a radius search around that point (radiusMi defaults
// to SPACING_MI when omitted: the same distance the generator itself
// treats as "one stop's worth of road", not a second guessed default).
// `near` absent -> every known facility, kind-filtered if `kinds` was
// given.
export async function list(req, res) {
  const { kinds, near, radiusMi } = listQuerySchema.parse(req.query)

  if (near) {
    const rows = await facilitiesService.listNear(near, radiusMi ?? SPACING_MI, kinds)
    return res.status(200).json({ facilities: rows })
  }

  const rows = await facilitiesService.listAll(kinds)
  res.status(200).json({ facilities: rows })
}
