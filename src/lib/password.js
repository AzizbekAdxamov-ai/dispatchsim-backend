// Password hashing helpers, backed by bcrypt (cost factor 12).

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'

const SALT_ROUNDS = 12

export async function hash(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

export async function verify(plain, hashValue) {
  return bcrypt.compare(plain, hashValue)
}

// DUMMY_HASH is used to run a bcrypt comparison even when no matching user
// exists (e.g. unknown email at login), so that the response time for
// "user not found" and "wrong password" is indistinguishable — this
// prevents an attacker from using response timing to enumerate valid
// emails. It is generated fresh from a random string at module load time
// rather than hardcoded, so it never matches any real password.
export const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS)
