// Data access for the documents module. The SQL lives in documents.sql.js
// (registered with sql-check); this file runs it and shapes rows.
//
// Exports a mutable-methods object rather than individual bindings so the
// service-level guard tests can substitute getLoadForDocument without
// import interception: ES module namespaces are read-only, and the service
// reads the function off this object at call time.

import { query } from '../../db/pool.js'
import { LOAD_FOR_DOCUMENT, CARRIER_FOR_USER } from './documents.sql.js'

export const documentsRepository = {
  // One load row with the parties the paperwork names. Returns null for an
  // unknown id; the service turns that into LOAD_NOT_FOUND.
  async getLoadForDocument(loadId) {
    const result = await query(LOAD_FOR_DOCUMENT, [loadId])
    return result.rows[0] ?? null
  },

  // The requesting user's company/name, for the carrier block on BOLs and
  // invoices. Returns null for no id (no auth reached this call) as well
  // as for an id with no matching row -- the service treats both the same.
  async getCarrier(userId) {
    if (!userId) return null
    const result = await query(CARRIER_FOR_USER, [userId])
    return result.rows[0] ?? null
  },
}
