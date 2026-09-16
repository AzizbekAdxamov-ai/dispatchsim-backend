// Data access for the documents module. The SQL lives in documents.sql.js
// (registered with sql-check); this file runs it and shapes rows.
//
// Exports a mutable-methods object rather than individual bindings so the
// service-level guard tests can substitute getLoadForDocument without
// import interception: ES module namespaces are read-only, and the service
// reads the function off this object at call time.

import { query } from '../../db/pool.js'
import { LOAD_FOR_DOCUMENT } from './documents.sql.js'

export const documentsRepository = {
  // One load row with the parties the paperwork names. Returns null for an
  // unknown id; the service turns that into LOAD_NOT_FOUND.
  async getLoadForDocument(loadId) {
    const result = await query(LOAD_FOR_DOCUMENT, [loadId])
    return result.rows[0] ?? null
  },
}
