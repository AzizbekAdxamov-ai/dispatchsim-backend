// Every SQL string the alerts module runs, in one place.
//
// Not a style choice. scripts/sql-check.js imports this module and PREPAREs
// EVERY export it finds, so a query added here is parsed against the real
// schema without anyone remembering to register it. The alternative -- SQL
// inline in the repository, copied by hand into the checker -- is how a
// checker ends up passing while the thing it claims to check has drifted.
//
// The one interpolation below is a constant, never user input.

import { REAL_SEC_PER_SIM_DAY } from '../../constants/simClock.js'

// Past the promise, or heading past it. status is maintained by the
// tick's markLate, which compares eta_at against promised_eta_at -- the
// same compressed clock, which is the whole reason lateness can happen.
export const LATE_LOADS_SQL = `SELECT id AS "loadId", broker, rate_usd AS "rateUsd", status,
            origin_city AS "originCity", origin_state AS "originState",
            destination_city AS "destinationCity", destination_state AS "destinationState",
            promised_eta_at AS "promisedEtaAt", eta_at AS "etaAt"
       FROM loads
      WHERE delivered_at IS NULL AND status IN ('warn', 'crit')
      ORDER BY promised_eta_at`

// Booked, not dispatched. loads_pending_clean guarantees 'neutral' means
// no driver and no truck, so the status alone is the entire condition.
export const UNASSIGNED_LOADS_SQL = `SELECT id AS "loadId", broker, rate_usd AS "rateUsd", booked_at AS "bookedAt",
            origin_city AS "originCity", origin_state AS "originState",
            destination_city AS "destinationCity", destination_state AS "destinationState"
       FROM loads
      WHERE status = 'neutral'
      ORDER BY booked_at`

// Delivered, invoiced, past due, unpaid. daysPastDue counts SIMULATED
// days -- the unit invoice_due_at was set in. Counting real calendar days
// here is what pinned this number at 0 for every invoice ever written.
export const OVERDUE_INVOICES_SQL = `SELECT id AS "loadId", broker, payment_terms AS "paymentTerms",
            (rate_usd + coalesce((
              SELECT sum((a->>'amountUsd')::int) FROM jsonb_array_elements(accessorials) a
            ), 0))::int AS "amountUsd",
            GREATEST(0, floor(
              EXTRACT(EPOCH FROM (now() - invoice_due_at)) / ${REAL_SEC_PER_SIM_DAY}
            ))::int AS "daysPastDue"
       FROM loads
      WHERE delivered_at IS NOT NULL
        AND invoice_paid_at IS NULL
        AND invoice_due_at IS NOT NULL
        AND invoice_due_at < now()
      ORDER BY invoice_due_at`

// Drivers with no unfinished load. The LEFT JOIN is what separates the
// two facts the catalog keeps apart: no load, versus no truck to pull it.
export const IDLE_DRIVERS_SQL = `SELECT d.id AS "driverId", d.name AS "driverName", d.duty_status AS "dutyStatus",
            t.id AS "truckId",
            coalesce(d.current_location, d.home_base_city || ', ' || d.home_base_state) AS "locationLabel"
       FROM drivers d
       LEFT JOIN trucks t ON t.driver_id = d.id
      WHERE NOT EXISTS (
              SELECT 1 FROM loads l WHERE l.driver_id = d.id AND l.status <> 'done'
            )
      ORDER BY d.name`

// A broker has spoken and nobody has answered. deliver_at gates it: a
// reply scheduled for the future has not been said yet.
export const BROKER_REPLIES_SQL = `SELECT c.id AS "conversationId", p.broker,
            p.origin_city AS "originCity", p.origin_state AS "originState",
            p.destination_city AS "destinationCity", p.destination_state AS "destinationState",
            last.id AS "lastMessageId", last.created_at AS "lastMessageAt"
       FROM broker_conversations c
       JOIN load_postings p ON p.id = c.posting_id
       JOIN LATERAL (
              SELECT m.id, m.role, m.created_at
                FROM broker_messages m
               WHERE m.conversation_id = c.id AND m.deliver_at <= now()
               ORDER BY m.deliver_at DESC, m.created_at DESC, m.id DESC
               LIMIT 1
            ) last ON true
      WHERE c.user_id = $1
        AND c.status = 'open'
        AND last.role = 'broker'
      ORDER BY last.created_at DESC`

// A rate agreed and the paper still sitting there. Until it is accepted
// the load is not booked and the capacity is still on the market.
export const UNACCEPTED_RATE_CONS_SQL = `SELECT c.id AS "conversationId", p.broker,
            c.rate_con_rate_usd AS "rateUsd", c.updated_at AS "agreedAt"
       FROM broker_conversations c
       JOIN load_postings p ON p.id = c.posting_id
      WHERE c.user_id = $1
        AND c.status = 'agreed'
        AND c.rate_con_rate_usd IS NOT NULL
      ORDER BY c.updated_at`

// Leaving soon, measured against the row's OWN lifetime rather than a
// number of minutes. Lifetimes come from Little's Law and move whenever
// the drip is retuned; a hardcoded '15 minutes left' would quietly become
// wrong the day poolTarget changed, and nothing would say so.
export const EXPIRING_APPLICANTS_SQL = `SELECT id AS "applicantId", full_name AS "name", years_experience AS "yearsExperience",
            home_base_city AS "homeBaseCity", home_base_state AS "homeBaseState",
            posted_at AS "postedAt", expires_at AS "expiresAt"
       FROM driver_applicants
      WHERE status = 'open'
        AND expires_at > now()
        AND (expires_at - now()) <= (expires_at - posted_at) * $1::float8
      ORDER BY expires_at`

// The same rule for trucks on the market.
export const EXPIRING_LISTINGS_SQL = `SELECT id AS "listingId", make, model, year, price_usd AS "priceUsd",
            seller, posted_at AS "postedAt", expires_at AS "expiresAt"
       FROM truck_listings
      WHERE status = 'open'
        AND expires_at > now()
        AND (expires_at - now()) <= (expires_at - posted_at) * $1::float8
      ORDER BY expires_at`

// Everything this person has acknowledged. Tens of rows, filtered in
// memory -- a join per family would be more machinery than the problem.
export const LIST_ACKS_SQL = `SELECT alert_key AS "alertKey", fingerprint FROM alert_acks WHERE user_id = $1`

// Acknowledging twice replaces the fingerprint rather than adding a row,
// so this table stays the size of the board, not of the history.
export const ACK_SQL = `INSERT INTO alert_acks (user_id, alert_key, fingerprint)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, alert_key)
       DO UPDATE SET fingerprint = EXCLUDED.fingerprint, acked_at = now()
     RETURNING alert_key AS "alertKey", fingerprint, acked_at AS "ackedAt"`

// Take it back.
export const UNACK_SQL = `DELETE FROM alert_acks WHERE user_id = $1 AND alert_key = $2 RETURNING alert_key AS "alertKey"`


// Drivers on the road whose 11-hour driving clock is inside its last hour
// (49 CFR 395.3(a)(3) -- the number the alert counts down to). The load
// comes along because the alert points at the run that is about to stop:
// drivers.hos_remaining_min is written by the tick's syncDriverHos (037).
// The threshold is a placeholder bound ($2), not typed into the string --
// the constant lives in alerts.catalog.js.
export const HOS_LOW_DRIVERS_SQL = `
  SELECT d.id AS "driverId", d.name AS "driverName",
         d.hos_remaining_min AS "hosRemainingMin",
         l.id AS "loadId", l.rate_usd AS "rateUsd"
    FROM drivers d
    -- 'ontime'/'warn'/'crit' are the dispatched, undelivered statuses
    -- (007's loads_status_valid). This read 'in-transit' -- a value the
    -- CHECK does not allow -- so the alert could never fire;
    -- test/loadStatusLiterals.test.js now pins every l.status literal.
    JOIN loads l ON l.driver_id = d.id AND l.status IN ('ontime', 'warn', 'crit')
   WHERE d.duty_status <> 'off'
     AND d.hos_remaining_min IS NOT NULL
     AND d.hos_remaining_min <= $1::int
   ORDER BY d.hos_remaining_min`
