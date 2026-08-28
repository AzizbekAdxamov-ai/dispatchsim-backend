// Business logic for the loads read endpoints. Combines loads.repository.js
// with the shared progress/timeline math (lib/loadTimeline.js) — no SQL
// lives here, only shaping.

import * as loadsRepo from './loads.repository.js'
import { AppError } from '../../lib/errors.js'
import { computeProgress, computeTimeline } from '../../lib/loadTimeline.js'

export async function listLoads({ status, equipmentType, search, page, limit }) {
  const offset = (page - 1) * limit

  const [loads, counts] = await Promise.all([
    loadsRepo.listLoads({ status, equipmentType, search, limit, offset }),
    loadsRepo.countLoadStatuses({ equipmentType, search }),
  ])

  return { loads, meta: { total: counts.all, page, limit, counts } }
}

export async function getLoadById(id) {
  const load = await loadsRepo.getLoadById(id)
  if (!load) {
    throw new AppError('LOAD_NOT_FOUND')
  }

  return {
    ...load,
    progress: computeProgress(load),
    timeline: computeTimeline(load),
  }
}
