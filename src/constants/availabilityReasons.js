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
// whatever else is true; unpaid work outranks a rest break, because being
// owed money is a decision the driver has made and a break is only time
// passing.
export const REASONS = Object.freeze({
  QUIT: 'quit',
  UNPAID: 'unpaid',
  RESTING: 'resting',
  // The 11-hour driving clock at zero (49 CFR 395.3(a)(3)). Checked after
  // RESTING: both answer "can this person run right now", and the ten-hour
  // break is the longer fact. Possible only since syncDriverHos began
  // writing drivers.hos_remaining_min -- the availability header's own rule
  // about reasons built on columns nothing writes.
  OUT_OF_HOURS: 'out-of-hours',
})

export const REASON_KEYS = Object.freeze(Object.values(REASONS))
