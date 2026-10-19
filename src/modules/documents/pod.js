// Proof of delivery -- the paperwork the receiver signs when freight comes
// OFF the truck. Only exists for a DELIVERED load: before that there is
// nothing to prove. Delivered at is the fact this document certifies.
//
// Regenerated on every request, never cached.

import {
  startDocument, formatDateTime, formatWeight, formatMiles,
} from './pdfShared.js'

/**
 * Generate a proof of delivery PDF for a delivered load.
 *
 * @param {Object} data
 * @param {Object} data.load - { id, originCity, originState, destinationCity,
 *   destinationState, distanceMi, weightLbs, commodity, deliveredAt, broker }
 * @param {Object|null} data.driver - { name, truckId }
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generatePod({ load, driver }) {
  const { doc, promise, helpers, M, RIGHT } = startDocument({
    title: 'PROOF OF DELIVERY',
    docId: load.id,
    dateStr: load.deliveredAt,
  })
    let y = 135

    // --- Parties ---
    const colW = (RIGHT - M - 20) / 2
    const colY = y
    helpers.field('Shipped from', `${load.originCity}, ${load.originState}`, M, colY, { width: colW })
    helpers.field('Delivered to', `${load.destinationCity}, ${load.destinationState}`, M + colW + 20, colY, { width: colW })

    y += 40

    // --- Delivery facts ---
    y = helpers.rule(y + 12)
    y = helpers.sectionLabel('DELIVERY', M, y + 14)

    const halfW = (RIGHT - M - 20) / 2
    y = helpers.field('Delivered at', formatDateTime(load.deliveredAt), M, y, { width: halfW })
    helpers.field('Received by', 'Receiver — unsigned sample copy', M + halfW + 20, y - 26, { width: halfW })

    y = helpers.rule(y + 12)

    // --- Freight as received ---
    y = helpers.sectionLabel('FREIGHT RECEIVED', M, y + 14)
    y = helpers.line(`${load.commodity || '—'}  ·  ${formatWeight(load.weightLbs)}`, M, y)
    y = helpers.line(`${formatMiles(load.distanceMi)} lane  ·  Broker  ${load.broker}`, M, y)

    y = helpers.rule(y + 12)

    // --- Driver who brought it in ---
    y = helpers.line(`Delivered by  ${driver ? driver.name : '—'}${driver?.truckId ? `  ·  Truck ${driver.truckId}` : ''}`, M, y + 14)

    // The receiver's signature block: a real POD is only real once someone
    // signs it. The blank line is the honest rendering -- no forged name.
    y = helpers.line('Received in good order by:', M, y + 20)
    y = helpers.line('X ______________________________', M, y + 22)

    helpers.footer()
    doc.end()
    return promise
}
