// One-time password an administrator hands to a user after a reset. Drawn
// from the same unambiguous alphabet as invite codes so it can be read out
// or typed without I/1/O/0 mix-ups.

import { randomBlock } from './inviteCode.js'
import { TEMP_PASSWORD_LENGTH } from '../constants/password.js'

export function generateTemporaryPassword() {
  return randomBlock(TEMP_PASSWORD_LENGTH)
}
