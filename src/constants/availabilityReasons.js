// Why a driver will not take a load.
//
// Its own file, with no imports, because both a pure module
// (driverChat.refusal.js) and a database service (availability.service.js)
// need it. Keeping the enum inside the service dragged db/pool.js -- and
// therefore DATABASE_URL and JWT_SECRET -- into a file that only builds
// sentences, and the refusal lines could not be exercised without a
// running database.
//
// Order is the order they are checked. A driver who has quit is gone
// whatever else is true; unpaid work outranks everything else, because
// being owed money is a decision the driver has made.
//
// The ten-hour break used to be here and is not any more: the stop
// planner carries owed rest into the run (the first block on the new log,
// at the origin) instead of the dispatch refusing it. What remains as a
// refusal is the state where the driver cannot drive AT ALL right now --
// the 11-hour clock at zero -- which the planner cannot plan around,
// because there is nothing to plan: the run simply starts with the full
// ten-hour reset, and dispatching a driver at zero is dispatching a
// person the law has parked.
export const REASONS = Object.freeze({
  QUIT: 'quit',
  UNPAID: 'unpaid',
  // The 11-hour driving clock at zero (49 CFR 395.3(a)(3)). Written by
  // syncDriverHos from the ELD log; NULL (log never covered the driver)
  // stays dispatchable.
  OUT_OF_HOURS: 'out-of-hours',
})

export const REASON_KEYS = Object.freeze(Object.values(REASONS))
