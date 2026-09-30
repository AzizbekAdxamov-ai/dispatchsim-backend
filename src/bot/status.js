// /status -- the driver, as the dispatch system knows them right now.
//
// Straight from the database, with no model in between: free, instant,
// and the answer to "is this bot really connected to our data?" in the
// chat itself. It is also the check on the model. The driver is handed
// the same fields in the same words (driverChat.prompt.js's
// situationLines, through the same fuelPercent and minutesLate), so if
// what the driver SAYS and what /status SHOWS disagree, the driver made
// something up -- and that is visible to the person talking to them.
//
// Facts, not verdicts. "2h 30m past the appointment" is two timestamps
// subtracted; "running late, call the receiver" would be a judgement,
// and judging is the student's job, not the screen's.

import { clockTime, hoursMinutes } from '../constants/appClock.js'
import { fuelPercent, minutesLate } from '../modules/driverChat/driverChat.prompt.js'

const DUTY = Object.freeze({
  driving: 'driving',
  'on-duty': 'on duty, not driving',
  resting: 'in the sleeper, on a 10-hour break',
  off: 'off duty',
})

export function statusText({ driver, load, now = new Date() }) {
  const lines = []

  lines.push(driver.truckId ? `${driver.name} · ${driver.truckId}` : driver.name)

  const where = driver.currentCity && driver.currentState ? ` — ${driver.currentCity}, ${driver.currentState}` : ''
  lines.push(`${DUTY[driver.dutyStatus] ?? 'off duty'}${where}`)

  // Each line only when the fact exists. An unknown shown as "0" is a
  // number someone will act on, and nothing on screen says it is a guess.
  const left = hoursMinutes(driver.hosRemainingMin)
  if (left) lines.push(`Driving time left today: ${left}`)

  const fuel = fuelPercent(driver)
  if (fuel != null) lines.push(`Fuel: about ${fuel}%`)

  if (load) {
    lines.push('')
    lines.push(`Load ${load.id}: ${load.originCity}, ${load.originState} → ${load.destinationCity}, ${load.destinationState}`)
    if (load.etaAt) {
      const late = minutesLate(load)
      lines.push(`ETA ${clockTime(load.etaAt)}${late != null ? ` — ${hoursMinutes(late)} past the appointment` : ''}`)
    }
  } else {
    lines.push('')
    lines.push('No load assigned.')
  }

  // The zone the times above are in. Every clock in this program is the
  // company's (appClock.js), and a time with no zone is half a fact.
  lines.push('')
  lines.push(`As of ${clockTime(now.toISOString())} Central`)

  return lines.join('\n')
}
