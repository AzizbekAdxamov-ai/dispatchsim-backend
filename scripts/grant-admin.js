// One-off CLI script to grant admin access to an existing user by email.
// Run this once, by hand, to create the very first administrator — after
// that, admins can promote other users through PATCH /admin/users/:id.
//
// Usage:
//   npm run grant:admin -- someone@example.com
//
// This script does NOT write its own SQL — it goes through
// users.repository.js like every other part of the app, per the rule at
// the top of that file.

import * as usersRepo from '../src/modules/auth/users.repository.js'
import { pool } from '../src/db/pool.js'

async function main() {
  const rawEmail = process.argv[2]

  if (!rawEmail || rawEmail.trim() === '') {
    console.error('Usage: npm run grant:admin -- <email>')
    // No DB connection has been opened yet at this point, so there is
    // nothing to close — set the exit code and return without entering
    // the try/finally below.
    process.exitCode = 1
    return
  }

  const email = rawEmail.trim().toLowerCase()

  try {
    const updated = await usersRepo.setAdminByEmail(email)
    if (!updated) {
      console.error('No user with that email. Register through the app first.')
      // process.exitCode (not process.exit()) so the `finally` below still
      // runs and closes the pool before the process actually exits.
      process.exitCode = 1
      return
    }
    console.log(`admin access granted: ${updated.email}`)
  } finally {
    await pool.end()
  }
}

main()
