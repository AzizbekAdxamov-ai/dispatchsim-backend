// HTTP handlers for /telegram. The bridge's own state, as the app's
// Settings panel needs to see it -- and never a token, in any response.

import config from '../../config.js'
import { AppError } from '../../lib/errors.js'
import { describeTelegram } from '../../constants/telegramMeta.js'
import * as repo from './telegram.repository.js'
import { query } from '../../db/pool.js'
import { randomBytes } from 'node:crypto'

// GET /telegram/status -- is the bridge on, and has THIS user linked a chat.
export async function status(req, res) {
  const described = describeTelegram(config)
  const link = await repo.getLinkByUser(req.user.id)
  let currentDriver = null
  if (link?.currentDriverId) {
    const row = (await query(`SELECT id, name FROM drivers WHERE id = $1`, [link.currentDriverId])).rows[0]
    currentDriver = row ?? null
  }
  res.json({
    enabled: described.ok,
    mode: described.ok ? described.mode : null,
    link: link
      ? {
        chatId: String(link.chatId),
        currentDriverId: link.currentDriverId,
        currentDriverName: currentDriver?.name ?? null,
        linkedAt: link.linkedAt,
      }
      : null,
  })
}

// POST /telegram/codes -- a fresh one-time code. Previous unused codes
// stay valid until they expire; issuing another is never an error (the
// user may have lost the first).
export async function createCode(req, res) {
  if (!config.telegramEnabled) {
    throw new AppError('TELEGRAM_DISABLED', 'Set TELEGRAM_BOT_TOKEN to use the bridge')
  }
  // 30-character alphabet, no 0/O/1/I lookalikes; six characters.
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length]
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
  const row = await repo.insertCode({ code, userId: req.user.id, expiresAt })
  res.status(201).json({ code: row.code, expiresAt: row.expiresAt })
}

// GET /telegram/codes -- the newest unused code for this user, with its
// expiry, so the panel can show it while it is still live.
export async function listCodes(req, res) {
  const { rows } = await query(
    `SELECT code, expires_at AS "expiresAt" FROM telegram_link_codes
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [req.user.id],
  )
  res.json({ code: rows[0]?.code ?? null, expiresAt: rows[0]?.expiresAt ?? null })
}

// DELETE /telegram/link -- forget this user's chat. The chat itself is
// told nothing; the next message it sends gets the not-linked notice.
export async function unlink(req, res) {
  const link = await repo.getLinkByUser(req.user.id)
  if (!link) throw new AppError('TELEGRAM_NOT_LINKED')
  await repo.deleteLink(link.chatId)
  res.json({ unlinked: true })
}
