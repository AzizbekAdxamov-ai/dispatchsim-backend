// Why each thing on the map is still on it -- the rules behind
// `npm run map:leftovers`, pure so a test can hold them.
//
// The map draws two kinds of thing (tracking.repository.js):
//   - every load that is dispatched and not delivered (IN_TRANSIT_BOARD_SQL),
//   - every truck with no undelivered load whose driver has a position
//     (IDLE_TRUCKS_SQL).
// A load leaves the map only when the ops tick delivers it, and the tick
// skips a load with an unresolved road event (claimArrivedLoads) -- by
// design: a truck on the shoulder does not arrive. So a test load whose
// breakdown nobody answered stays drawn for ever, and so does a fixture
// a test once committed (see check-test-leaks.js for how that happened).

// What the test suite writes. Every value here is copied from a test
// fixture, not guessed:
//   test/helpers/dispatchFixture.js  'Check Fixture Broker', FX-nnnn-TX, @fixture.test
//   test/loadEventsUncertified.test.js 'UE Fixture Broker'
//   test/preTripFlow.test.js          'PTI Test Broker'
//   test/driverlessTruck.test.js      ZZ-0001-TX
export const FIXTURE_BROKERS = Object.freeze(['Check Fixture Broker', 'UE Fixture Broker', 'PTI Test Broker'])
export const FIXTURE_TRUCK = /^(FX-\d{4}-TX|ZZ-0001-TX)$/
export const FIXTURE_EMAIL = /@fixture\.test$/

export function isFixture({ broker = null, truckId = null, driverEmail = null } = {}) {
  return FIXTURE_BROKERS.includes(broker)
    || (truckId != null && FIXTURE_TRUCK.test(truckId))
    || (driverEmail != null && FIXTURE_EMAIL.test(driverEmail))
}

// One load on the map: why it is there. In order -- a fixture is a
// fixture whatever else is true of it.
//   fixture   written by a test; never real
//   stuck     a road event nobody answered; the tick will not deliver it
//   overdue   ETA passed with nothing blocking it -- the tick delivers it
//             within 30 s while the backend runs; still here means the
//             backend (npm start) is not running
//   running   on its way; it belongs on the map
export function classifyLoad(row, now = new Date()) {
  if (isFixture(row)) return 'fixture'
  if (row.openEventAt != null) return 'stuck'
  if (row.etaAt != null && new Date(row.etaAt) <= now) return 'overdue'
  return 'running'
}

export function hoursSince(iso, now = new Date()) {
  return Math.round((now.getTime() - new Date(iso).getTime()) / 36e5)
}

// "--cancel 104882,104883" -> ['104882', '104883']. Ids only, never "all":
// a cancel is done to loads somebody looked at.
export function cancelIds(argv) {
  const i = argv.indexOf('--cancel')
  if (i === -1) return []
  const raw = argv[i + 1] ?? ''
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^\d{1,12}$/.test(s)))]
}
