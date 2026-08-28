// Vercel serverless entrypoint. Vercel's Node runtime treats any exported
// (req, res) handler in api/ as a function — an Express app satisfies that
// signature directly, so no adapter is needed. server.js's app.listen()
// path is for local/traditional hosting only and is never imported here.

import app from '../src/app.js'

export default app
