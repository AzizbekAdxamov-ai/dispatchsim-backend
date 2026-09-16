// Bill of lading -- the paperwork a shipper signs when freight goes ON the
// truck. One page from the load row: parties, freight description, pickup
// window, terms. No signature capture; the printed lines are what a
// dispatcher would carry.
//
// Regenerated on every request, never cached -- same rule as the rate
// confirmation, so the document can never disagree with the database.

import {
  startDocument, formatDateTime, formatWeight, formatMiles,
} from './pdfShared.js'

/**
 * Generate a bill of lading PDF for a dispatched load.
 *
 * @param {Object} data - load + parties
 * @param {Object} data.load - { id, originCity, originState, destinationCity,
 *   destinationState, distanceMi, weightLbs, commodity, equipmentType,
 *   equipmentLengthFt, pickupAt, deliveryAt, paymentTerms, broker }
 * @param {Object|null} data.driver - { name, cdlNumber, truckId }
 * @param {Object} data.carrier - { name } (the company the student runs)
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generateBol({ load, driver, carrier }) {
  const { doc, promise, helpers, M, RIGHT } = startDocument({
    title: 'BILL OF LADING',
    docId: load.id,
    dateStr: load.pickupAt,
  })
    let y = 135

    // --- Parties: shipper (origin) / consignee (destination) / carrier ---
    const colW = (RIGHT - M - 20) / 3
    const colY = y
    helpers.field('Shipper', `${load.originCity}, ${load.originState}`, M, colY, { width: colW })
    helpers.field('Consignee', `${load.destinationCity}, ${load.destinationState}`, M + colW + 10, colY, { width: colW })
    helpers.field('Carrier', carrier?.name ?? '—', M + 2 * (colW + 10), colY, { width: colW })

    y += 40

    // --- Freight description ---
    y = helpers.rule(y + 12)
    y = helpers.sectionLabel('FREIGHT', M, y + 14)

    y = helpers.line(`${load.commodity || '—'}  ·  ${formatWeight(load.weightLbs)}`, M, y)
    y = helpers.line(`${load.equipmentType} ${load.equipmentLengthFt ?? 53} ft  ·  ${formatMiles(load.distanceMi)}`, M, y)

    y = helpers.rule(y + 12)

    // --- Pickup / delivery windows ---
    y = helpers.sectionLabel('PICKUP & DELIVERY', M, y + 14)
    y = helpers.field('Pickup', formatDateTime(load.pickupAt), M, y, { width: (RIGHT - M - 20) / 2 })
    helpers.field('Delivery window', formatDateTime(load.deliveryAt), M + (RIGHT - M - 20) / 2 + 20, y - 26, { width: (RIGHT - M - 20) / 2 })

    y = helpers.rule(y + 12)

    // --- Driver on the run ---
    y = helpers.sectionLabel('DRIVER', M, y + 14)
    y = helpers.line(driver ? `${driver.name}  ·  CDL ${driver.cdlNumber ?? '—'}` : 'Not yet assigned', M, y)
    if (driver?.truckId) y = helpers.line(`Truck ${driver.truckId}`, M, y)

    y = helpers.rule(y + 12)

    // --- Terms ---
    y = helpers.line(`Payment terms  ${load.paymentTerms ?? 'net30'}   ·   Broker  ${load.broker}`, M, y + 14)

    helpers.footer()
    doc.end()
    return promise
}
