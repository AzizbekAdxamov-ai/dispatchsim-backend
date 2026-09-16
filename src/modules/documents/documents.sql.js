// Reads for the document generators.
//
// Every SQL string here is exported so scripts/sql-check.js parses it
// against the live schema -- the same registration the other .sql.js
// modules use. One query: the load row with the parties the paperwork
// names, read through the lateral-join shape loads.repository.js already
// uses so the document's driver/truck block matches what the screens show.

// The load row paperwork hangs off. Dispatched/delivered timestamps are
// the guards the service checks: BOL needs dispatched_at, POD needs
// delivered_at -- both NULL-able, so the document is refused upstream
// rather than rendering 'Invalid Date'.
export const LOAD_FOR_DOCUMENT = `
  SELECT l.id, l.origin_city AS "originCity", l.origin_state AS "originState",
         l.destination_city AS "destinationCity", l.destination_state AS "destinationState",
         l.broker, l.commodity, l.weight_lbs AS "weightLbs",
         l.equipment_type AS "equipmentType", l.equipment_length_ft AS "equipmentLengthFt",
         l.distance_mi AS "distanceMi", l.pickup_at AS "pickupAt",
         l.delivery_at AS "deliveryAt", l.dispatched_at AS "dispatchedAt",
         l.delivered_at AS "deliveredAt", l.payment_terms AS "paymentTerms",
         d.id AS "driverId", d.name AS "driverName", d.cdl_number AS "driverCdlNumber",
         l.truck_id AS "truckId"
    FROM loads l
    LEFT JOIN drivers d ON d.id = l.driver_id
   WHERE l.id = $1`
