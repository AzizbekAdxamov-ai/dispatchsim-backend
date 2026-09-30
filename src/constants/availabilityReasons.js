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
// No hours-of-service reason lives here. Two have been tried and both
// came back out: the ten-hour break, and the 11-hour driving clock at
// zero. The argument for the second one was that the planner "cannot
// plan around" a driver at zero -- but it can, and does: the run starts
// with the full ten-hour reset at the origin and the legal arrival moves
// out by ten hours (stopPlan.test.js, "a driver who just ran 11 hours").
// Refusing here would have been the ten-hour block wearing a different
// clock.
//
// What is left are the two facts the planner genuinely cannot absorb: a
// driver who has quit, and a driver who is owed money and has stopped
// working. Neither is a scheduling problem.
export const REASONS = Object.freeze({
  QUIT: 'quit',
  UNPAID: 'unpaid',
})

export const REASON_KEYS = Object.freeze(Object.values(REASONS))
