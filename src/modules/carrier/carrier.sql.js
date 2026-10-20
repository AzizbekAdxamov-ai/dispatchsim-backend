// The carrier's own identity (048). One row, read everywhere the company
// has to name itself: the rate confirmation, the invoice, and the two
// chat prompts -- a broker knows who they are talking to, and a driver
// knows whose truck they are in.
//
// scripts/sql-check.js PREPAREs every export here against the real
// schema, so a renamed column fails in a command instead of on a piece of
// paper a student is trying to read.

export const GET_CARRIER_SQL = `
  SELECT name, mc_number AS "mcNumber", dot_number AS "dotNumber",
         phone, email, address_line AS "addressLine", city, state,
         postal_code AS "postalCode", updated_at AS "updatedAt"
    FROM carrier
   WHERE id = true`

// Editing is an admin act and goes through the same single row: there is
// no second carrier to create by accident, because the primary key says
// so. COALESCE, so a form that sends three fields does not blank the
// other five.
export const UPDATE_CARRIER_SQL = `
  UPDATE carrier
     SET name         = coalesce($1, name),
         mc_number    = coalesce($2, mc_number),
         dot_number   = coalesce($3, dot_number),
         phone        = coalesce($4, phone),
         address_line = coalesce($5, address_line),
         city         = coalesce($6, city),
         state        = coalesce($7, state),
         postal_code  = coalesce($8, postal_code),
         email        = CASE WHEN $9::boolean THEN $10::text ELSE email END,
         updated_at   = now()
   WHERE id = true
  RETURNING name, mc_number AS "mcNumber", dot_number AS "dotNumber",
            phone, email, address_line AS "addressLine", city, state,
            postal_code AS "postalCode", updated_at AS "updatedAt"`
