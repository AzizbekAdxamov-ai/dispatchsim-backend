// Catch-all for requests that matched no route. Must be mounted last, after
// all real routes.

import { AppError } from '../lib/errors.js'

export function notFound(req, res, next) {
  next(new AppError('ROUTE_NOT_FOUND'))
}
