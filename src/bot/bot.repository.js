// Every read the bot does that is not already someone else's. Thin on
// purpose: the SQL is in bot.sql.js so sql-check.js can parse it, and
// anything about a CONVERSATION is asked through driverChat's repository
// instead of being asked a second way here.

import { pool } from '../db/pool.js'
import * as sql from './bot.sql.js'

export async function dispatcherByEmail(email) {
  const { rows } = await pool.query(sql.DISPATCHER_BY_EMAIL_SQL, [email])
  return rows[0] ?? null
}

export async function driversByName(name) {
  const { rows } = await pool.query(sql.DRIVERS_BY_NAME_SQL, [name])
  return rows
}

export async function driverById(driverId) {
  const { rows } = await pool.query(sql.DRIVER_BY_ID_SQL, [driverId])
  return rows[0] ?? null
}

export async function driversList() {
  const { rows } = await pool.query(sql.DRIVERS_LIST_SQL)
  return rows
}

// `through` is the [deliver_at, id] watermark, or null on a cold start.
export async function dueDriverMessages({ userId, through, limit }) {
  const { rows } = await pool.query(sql.DUE_DRIVER_MESSAGES_SQL, [
    through?.[0] ?? null,
    through?.[1] ?? null,
    userId,
    limit,
  ])
  return rows
}
