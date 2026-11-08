// Every SQL string the driver chat runs. scripts/sql-check.js PREPAREs
// each export, so a query added here is parsed against the real schema
// without anyone remembering to register it.

// One thread per dispatcher per driver, created on first open.
export const OPEN_CONVERSATION_SQL = `
  INSERT INTO driver_conversations (driver_id, user_id)
  VALUES ($1, $2)
  ON CONFLICT (driver_id, user_id) DO UPDATE SET updated_at = now()
  RETURNING id, driver_id AS "driverId", user_id AS "userId",
            created_at AS "createdAt", updated_at AS "updatedAt"`

export const GET_CONVERSATION_SQL = `
  SELECT c.id, c.driver_id AS "driverId", c.user_id AS "userId",
         c.created_at AS "createdAt", c.updated_at AS "updatedAt"
    FROM driver_conversations c
   WHERE c.id = $1 AND c.user_id = $2`

// Everything the driver knows about themselves, in one round trip: who
// they are, what truck they have, and the load they are on right now.
// Everything the person knows about their own day.
//
// The location, the hours and the ETA are here because of Telegram. In
// the app a dispatcher reads them off the tracking page; in a group chat
// they just type "where are you?" -- and a model that has not been told
// will answer anyway, which is the one thing this simulator must never
// do. These columns are already written by the tick (current_city /
// current_state by the trip walker, hos_remaining_min by syncDriverHos,
// eta_at by dispatch); nothing new is computed, it is only handed to the
// person whose day it is.
export const GET_DRIVER_CONTEXT_SQL = `
  SELECT d.id, d.name, d.cdl_class AS "cdlClass",
         d.bio,
         d.preferences,
         d.home_base_city AS "homeBaseCity", d.home_base_state AS "homeBaseState",
         d.duty_status AS "dutyStatus",
         d.current_city AS "currentCity", d.current_state AS "currentState",
         d.hos_remaining_min AS "hosRemainingMin", d.hours_today_min AS "hoursTodayMin",
         d.pay_model AS "payModel", d.pay_percent_bp AS "payPercentBp",
         d.pay_per_mile_cents AS "payPerMileCents",
         t.id AS "truckId",
         t.trailer_type AS "trailerType",
         t.trailer_length_ft AS "trailerLengthFt",
         t.fuel_gallons AS "fuelGallons", t.fuel_capacity_gal AS "fuelCapacityGal",
         l.id AS "loadId", l.origin_city AS "originCity", l.origin_state AS "originState",
         l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
         l.distance_mi AS "distanceMi", l.eta_at AS "etaAt", l.delivery_at AS "deliveryAt",
         l.dispatched_at AS "dispatchedAt",
         ev.event_type AS "openEventType", ev.place AS "openEventPlace"
    FROM drivers d
    LEFT JOIN trucks t ON t.driver_id = d.id
    LEFT JOIN LATERAL (
           SELECT x.id, x.origin_city, x.origin_state,
                  x.destination_city, x.destination_state, x.distance_mi,
                  x.eta_at, x.delivery_at, x.dispatched_at
             FROM loads x
            WHERE x.driver_id = d.id AND x.status <> 'done'
            ORDER BY x.dispatched_at DESC NULLS LAST
            LIMIT 1
         ) l ON true
    -- The road event still open on that load: the truck is stopped, and the
    -- driver knows it even when nobody has resolved it yet.
    LEFT JOIN LATERAL (
           SELECT e.event_type, e.place
             FROM load_events e
            WHERE e.load_id = l.id AND e.resolved_at IS NULL
            LIMIT 1
         ) ev ON true
   WHERE d.id = $1`

// Delivered messages only. A reply scheduled for the future has not been
// said yet, and showing it early would delete the entire point of the wait.
export const LIST_MESSAGES_SQL = `
  SELECT id, role, content, kind, created_at AS "createdAt"
    FROM driver_messages
   WHERE conversation_id = $1 AND deliver_at <= now()
   ORDER BY deliver_at ASC, created_at ASC, id ASC`

export const ADD_MESSAGE_SQL = `
  INSERT INTO driver_messages (conversation_id, role, content, deliver_at, kind)
  VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
  RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`

// A second question sent while the driver is still typing replaces the
// pending answer in the SAME slot rather than stacking a second one behind
// it. Without this, three impatient messages produce three replies that
// arrive in a row, which is not how anyone texts.
//
// kind = 'text' ONLY. This thread has two other writers -- road-event
// reports from the tick and refusals from dispatch -- and this statement
// deletes every row it matches while inserting exactly one. Without the
// kind filter, a dispatcher who typed anything while a blizzard report was
// still on its way destroyed it: the event stayed on the load page and the
// alert board, so nothing looked broken, and the driver simply appeared
// never to have mentioned it. Things that HAPPENED are not replaceable by
// a generated reply.
export const REPLACE_PENDING_REPLY_SQL = `
  WITH pending AS (
    SELECT id, deliver_at FROM driver_messages
     WHERE conversation_id = $1 AND role = 'driver'
       AND kind = 'text' AND deliver_at > now()
  ),
  slot AS (SELECT min(deliver_at) AS deliver_at FROM pending),
  del AS (DELETE FROM driver_messages WHERE id IN (SELECT id FROM pending))
  INSERT INTO driver_messages (conversation_id, role, content, deliver_at, kind)
  SELECT $1, 'driver', $2, slot.deliver_at, 'text'
    FROM slot WHERE slot.deliver_at IS NOT NULL
  RETURNING id, role, content, kind, created_at AS "createdAt", deliver_at AS "deliverAt"`

export const HAS_PENDING_REPLY_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM driver_messages
     WHERE conversation_id = $1 AND role = 'driver' AND deliver_at > now()
  ) AS pending`

// Lock the conversation before writing a reply into it.
//
// The model call sits between reading the thread and writing the answer,
// so the window is seconds wide. Two sends in that window -- a double
// click, two tabs -- both found no pending reply and both fell through to
// a plain insert, stacking two answers: exactly what
// REPLACE_PENDING_REPLY_SQL exists to prevent. Taking this row lock first
// serialises them, so the second send sees the first one's pending reply
// and replaces it.
export const LOCK_CONVERSATION_SQL = `
  SELECT id FROM driver_conversations WHERE id = $1 FOR UPDATE`

// The dispatcher's own daily turn count, across every driver.
// The per-chat daily counter that used to live here is gone. It counted
// this chat's messages against this chat's cap, and the broker chat had
// its own copy doing the same for itself -- two counts of one key's
// budget. src/modules/chat/chatBudget.sql.js counts both at once.

// The thread list: every driver, whether or not a conversation exists yet,
// so opening the page shows the roster rather than an empty screen.
export const LIST_THREADS_SQL = `
  SELECT d.id AS "driverId", d.name AS "driverName", d.duty_status AS "dutyStatus",
         c.id AS "conversationId",
         last.content AS "lastContent", last.role AS "lastRole",
         last.deliver_at AS "lastAt"
    FROM drivers d
    LEFT JOIN driver_conversations c ON c.driver_id = d.id AND c.user_id = $1
    LEFT JOIN LATERAL (
           SELECT m.content, m.role, m.deliver_at
             FROM driver_messages m
            WHERE m.conversation_id = c.id AND m.deliver_at <= now()
            ORDER BY m.deliver_at DESC, m.created_at DESC, m.id DESC
            LIMIT 1
         ) last ON true
   ORDER BY last.deliver_at DESC NULLS LAST, d.name`

// Every conversation that already exists with one driver.
//
// The tick has no user: nothing about a blizzard on I-80 belongs to one
// dispatcher. So a road event is reported into whichever threads are
// already open with that driver, and into none if nobody has ever messaged
// them -- the event still reaches the load page and the alert board. The
// alternative, creating a conversation for every user on the system, would
// manufacture threads nobody started.
export const CONVERSATIONS_FOR_DRIVER_SQL = `
  SELECT id, user_id AS "userId" FROM driver_conversations WHERE driver_id = $1`
