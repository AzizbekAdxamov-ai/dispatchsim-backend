// Password length rules shared by register, change-password and the
// admin temporary password.

export const PASSWORD_MIN_LENGTH = 8
// bcrypt's own input limit: bytes beyond this are ignored by the algorithm.
export const PASSWORD_MAX_LENGTH = 72
export const TEMP_PASSWORD_LENGTH = 12
