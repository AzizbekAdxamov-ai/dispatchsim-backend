// Central catalog of application error codes. Every AppError thrown anywhere
// in the app must reference one of these keys, so error responses stay
// consistent in shape and in the exact message text sent to clients.

export const ERROR_CODES = {
  VALIDATION_ERROR:    { status: 400, message: 'Request body is invalid' },
  INVALID_CREDENTIALS: { status: 401, message: 'Email or password is incorrect' },
  UNAUTHORIZED:        { status: 401, message: 'Authentication required' },
  TOKEN_EXPIRED:       { status: 401, message: 'Session has expired' },
  EMAIL_TAKEN:         { status: 409, message: 'This email is already registered' },
  USER_NOT_FOUND:      { status: 404, message: 'User not found' },
  RATE_LIMITED:        { status: 429, message: 'Too many attempts, try again later' },
  ROUTE_NOT_FOUND:     { status: 404, message: 'Route not found' },
  INTERNAL_ERROR:      { status: 500, message: 'Something went wrong' },
  // Authenticated, but not an administrator — trying to reach /admin/*.
  FORBIDDEN:           { status: 403, message: 'You do not have access to this area' },
  // Would drop the last remaining admin, leaving the system with nobody
  // able to grant admin access to anyone (including themselves).
  LAST_ADMIN:          { status: 409, message: 'At least one administrator must remain' },
  // An admin tried to change their own `isAdmin` flag through the admin
  // endpoint — always rejected, so removing/granting admin access always
  // requires a second, independent administrator.
  SELF_ADMIN_CHANGE:   { status: 409, message: 'You cannot change your own administrator access' },
  // PATCH /auth/active-role targeted a role the caller does not currently
  // have granted (an admin never granted it, or just revoked it). Guarded
  // at two independent layers — see users.repository.js's setActiveRole
  // and the users_active_role_fk composite FK in migration 003.
  ROLE_NOT_GRANTED:    { status: 403, message: 'You do not have access to that workspace' },
  // The invite code on POST /auth/register was missing, malformed, expired,
  // fully used, or deactivated — these are deliberately not distinguished
  // from one another in the response (see Qaror B in the plan), so the
  // error itself never becomes a probe for which of those states a code is
  // in.
  INVITE_INVALID:      { status: 400, message: 'This invite code is invalid or has expired' },
  // PATCH /admin/invites/:id targeted an id that doesn't exist.
  INVITE_NOT_FOUND:    { status: 404, message: 'Invite code not found' },
  // Random code generation collided with an existing code on every attempt
  // (astronomically unlikely at ~39 bits of entropy — see lib/inviteCode.js
  // — but handled rather than surfaced as a raw 500).
  INVITE_CODE_TAKEN:   { status: 409, message: 'Could not generate a unique invite code, try again' },
  // GET /loads/:id, /drivers/:id, /fleet/trucks/:id targeted an id that
  // doesn't exist. Read-only lookups added alongside migrations 005-009.
  LOAD_NOT_FOUND:    { status: 404, message: 'Load not found' },
  DRIVER_NOT_FOUND:  { status: 404, message: 'Driver not found' },
  TRUCK_NOT_FOUND:   { status: 404, message: 'Truck not found' },
  POSTING_NOT_FOUND: { status: 404, message: 'Posting not found' },

  CONVERSATION_NOT_FOUND: { status: 404, message: 'Conversation not found' },
  BROKER_UNAVAILABLE:     { status: 409, message: 'This posting has no broker on file' },
  CHAT_DAILY_LIMIT:       { status: 429, message: 'Daily message limit reached, try again tomorrow' },
  CHAT_UNAVAILABLE:       { status: 503, message: 'The broker cannot be reached right now' },
  RATE_OUT_OF_BAND:       { status: 400, message: 'That rate is outside the allowed range for this distance' },
  POSTING_TAKEN:     { status: 409, message: 'This posting has already been booked' },
  POSTING_EXPIRED:   { status: 410, message: 'This posting has expired' },
  DRIVER_HAS_ACTIVE_LOAD: { status: 409, message: 'Driver already has an active load' },
  LOAD_ID_UNAVAILABLE:    { status: 409, message: 'Load ID unavailable, try again' },
  DRIVER_NOT_AVAILABLE:   { status: 409, message: 'No available driver for this load' },
  APPLICANT_NOT_FOUND:    { status: 404, message: 'Applicant not found' },
  APPLICANT_EXPIRED:      { status: 410, message: 'This applicant is no longer available' },
  APPLICANT_ALREADY_HIRED:{ status: 409, message: 'This applicant has already been hired' },
  DRIVER_EMAIL_TAKEN:     { status: 409, message: 'A driver with this email already exists' },
  UNKNOWN_CITY:           { status: 400, message: 'City not found in the system' },
  LISTING_NOT_FOUND:      { status: 404, message: 'Truck listing not found' },
  LISTING_ALREADY_BOUGHT: { status: 409, message: 'This listing has already been purchased' },
  LISTING_EXPIRED:        { status: 410, message: 'This listing has expired' },
  TRUCK_HAS_DRIVER:       { status: 409, message: 'This truck already has a driver assigned' },
  DRIVER_HAS_TRUCK:       { status: 409, message: 'This driver already has a truck assigned' },
  NOT_AGREED_YET:         { status: 409, message: 'No agreement on file — agree on a rate first' },
  ALREADY_BOOKED:         { status: 409, message: 'This rate confirmation has already been accepted' },
  RATE_CON_NOT_ARRIVED:   { status: 409, message: 'The broker has not sent the rate confirmation yet' },
  BROKER_NOT_FOUND:       { status: 404, message: 'No carrier record found for that MC number' },
}

export class AppError extends Error {
  constructor(code, details) {
    const entry = ERROR_CODES[code]
    if (!entry) {
      throw new Error(`Unknown AppError code: ${code}`)
    }
    super(entry.message)
    this.name = 'AppError'
    this.code = code
    this.status = entry.status
    this.details = details
  }
}
