// Business logic for invite codes: generating a unique code, listing/
// filtering for the admin console, and patching the mutable fields.
// Controllers call into this module; this module is the only place that
// combines lib/inviteCode.js's generator with the invites repository.

import * as invitesRepo from './invites.repository.js'
import { generateCode } from '../../lib/inviteCode.js'
import { AppError } from '../../lib/errors.js'

// One retry on a generation collision: at ~39 bits of entropy in the
// random block, a collision is astronomically unlikely on the very first
// try, so a single retry is a pragmatic ceiling rather than a real defense
// — if it collides twice in a row something is more likely wrong with the
// alphabet/length than with luck, and INVITE_CODE_TAKEN surfaces that
// instead of retrying forever.
const MAX_GENERATION_ATTEMPTS = 2

function isCodeCollision(err) {
  return err?.code === '23505' && err?.constraint === 'invite_codes_code_key'
}

export async function createInvite({ label, prefix, roles, expiresAt, maxUses, createdBy }) {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateCode(prefix)
    try {
      // eslint-disable-next-line no-await-in-loop
      return await invitesRepo.create({ code, label, roles, expiresAt, maxUses, createdBy })
    } catch (err) {
      if (!isCodeCollision(err)) {
        throw err
      }
      // fall through and try again with a freshly generated code
    }
  }
  throw new AppError('INVITE_CODE_TAKEN')
}

export async function listInvites({ filter, page, limit }) {
  const offset = (page - 1) * limit
  const [invites, total] = await Promise.all([
    invitesRepo.list({ filter, limit, offset }),
    invitesRepo.count({ filter }),
  ])
  return { invites, meta: { total, page, limit } }
}

// `roles` and `code` are not accepted here (see admin.schemas.js's
// inviteUpdateSchema, which never defines those fields in the first
// place) — a code is already distributed as a link once created, and
// changing what roles it grants after the fact would silently change what
// everyone who already has that link is entitled to, and would break the
// audit trail on user_roles.invite_code_id (a role granted "because of"
// this code would retroactively look like it came from a different set of
// roles than it actually did). Changing the roles a cohort should get
// means deactivating this code and creating a new one, not mutating this
// row in place.
export async function updateInvite(id, patch) {
  const updated = await invitesRepo.update(id, patch)
  if (!updated) {
    throw new AppError('INVITE_NOT_FOUND')
  }
  return updated
}
