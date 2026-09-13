// SQL for driver availability. sql-check PREPAREs every export here.

import { REAL_SEC_PER_SIM_DAY } from '../../constants/simClock.js'

// How long since this driver's last load delivered, in SIMULATED hours.
//
// Simulated, because 49 CFR 395.3's ten hours are ten hours of a driver's
// life, and the driver lives on the compressed calendar along with the
// invoices and the interest. Counting real hours here would make the rest
// break twelve real hours long -- the same 720x mistake that made lateness
// impossible, in a place where it would look like the app was simply
// refusing to dispatch.
//
// NULL when they have never delivered anything. That is a driver who has
// not worked yet, not one who needs rest, and the CASE keeps those apart:
// GREATEST/coalesce would flatten them into the same number.
export const HOURS_SINCE_LAST_DELIVERY_SQL = `
  SELECT d.id AS "driverId",
         CASE WHEN max(l.delivered_at) IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (now() - max(l.delivered_at)))
                   / ${REAL_SEC_PER_SIM_DAY} * 24
         END AS "simHoursSinceDelivery",
         max(l.delivered_at) AS "lastDeliveredAt"
    FROM drivers d
    LEFT JOIN loads l ON l.driver_id = d.id AND l.delivered_at IS NOT NULL
   WHERE d.id = $1
   GROUP BY d.id`
