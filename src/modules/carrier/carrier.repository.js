// Data access for the carrier's single row.
import { query } from '../../db/pool.js'
import * as SQL from './carrier.sql.js'

async function run(client, text, values) {
  return client ? client.query(text, values) : query(text, values)
}

export async function getCarrier(client = null) {
  const result = await run(client, SQL.GET_CARRIER_SQL, [])
  return result.rows[0] ?? null
}

export async function updateCarrier(patch, client = null) {
  const result = await run(client, SQL.UPDATE_CARRIER_SQL, [
    patch.name ?? null,
    patch.mcNumber ?? null,
    patch.dotNumber ?? null,
    patch.phone ?? null,
    patch.addressLine ?? null,
    patch.city ?? null,
    patch.state ?? null,
    patch.postalCode ?? null,
  ])
  return result.rows[0] ?? null
}

// The one line a document or a prompt puts under the company's name.
// Here rather than in three formatters, so the address reads the same on
// the rate confirmation, on the invoice and in whatever comes next.
export function addressLine(carrier) {
  if (!carrier) return ''
  return `${carrier.addressLine}, ${carrier.city}, ${carrier.state} ${carrier.postalCode}`
}
