// Taking a load back: the dispatch off a driver, and the load itself off the
// board when the agreement behind it is withdrawn.
//
// Light on purpose (repositories only, no dispatch.service import) so the
// broker chat can call it from inside its own transaction without pulling
// the whole dispatch engine in.

import { AppError } from '../../lib/errors.js'
import * as loadsRepo from './loads.repository.js'
import * as loadEventsRepo from '../loadEvents/loadEvents.repository.js'
import * as dutyEventsRepo from '../hos/dutyEvents.repository.js'

// Statuses of a load that is out on a run.
export const DISPATCHED_STATUSES = Object.freeze(['ontime', 'warn', 'crit'])

// Undo a dispatch inside the caller's transaction. The driver is released in
// the same transaction, or a cancel would leave them marked as running
// freight that is no longer theirs. Returns what was undone.
export async function undoDispatch(client, loadId) {
  // Read before the UPDATE: after it, the row's driver_id is already NULL
  // and the release below would have nobody to release.
  const driverId = await loadsRepo.getLoadDriver(client, loadId)
  const cancelled = await loadsRepo.cancelDispatch(client, loadId)
  if (!cancelled) {
    // Either it does not exist, or it is already delivered -- and a
    // delivered load has money against it, which is not something an
    // UPDATE gets to undo.
    const load = await loadsRepo.getLoadById(loadId, client)
    if (!load) throw new AppError('LOAD_NOT_FOUND')
    throw new AppError('LOAD_NOT_CANCELLABLE')
  }
  await loadsRepo.releaseDriver(client, { driverId })

  // Close any open road event with the cancel, in the same transaction.
  //
  // The loads row survives a cancel, so ON DELETE CASCADE never fires and
  // an open event was simply orphaned. claimArrivedLoads skips loads with
  // one, so the load could be re-dispatched, would never arrive, would
  // slide to 'crit', and nothing anywhere said why. Worse, the event was
  // still resolvable: a $1,450 tow could be charged against a truck that
  // was not on the road, which is precisely the thing the resolve path's
  // own comment promises cannot happen.
  const closed = await loadEventsRepo.closeEventsForLoad(client, loadId)

  // The duty log planned for this run: what has not happened yet is
  // removed, the status in progress ends now. The part already lived
  // stays -- those hours were really driven and still count.
  const duty = await dutyEventsRepo.trimForCancelledLoad(client, loadId)

  return { load: cancelled, eventsClosed: closed.length, dutyEventsRemoved: duty.removed }
}

// The agreement behind a booked load was withdrawn: the load is gone. A
// dispatched one is undone first; a delivered one is left alone (money has
// moved, that is an accounting question) with a warning.
export async function withdrawBookedLoad(client, { loadId, reason }) {
  const load = await loadsRepo.getLoadById(loadId, client)
  if (!load) return null
  if (load.deliveredAt || load.status === 'done') {
    console.warn(`withdrawBookedLoad: load ${loadId} is already delivered, left as is`)
    return null
  }
  if (DISPATCHED_STATUSES.includes(load.status)) await undoDispatch(client, loadId)
  return loadsRepo.cancelLoad(client, { loadId, reason })
}
