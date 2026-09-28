// What a photo means, decided before anything is fetched or sent.
//
// Pure functions only: the poll loop parses Telegram's update into facts,
// the vision switch decides what happens, and the honest wording for a
// model that cannot see lives here too -- one place, so the honesty is
// not scattered across conditionals.

// Telegram sends an album as SEVERAL updates sharing one media_group_id,
// each carrying one photo. The caption rides the first (usually). This
// folds those updates into one photo-list fact -- pure, so the grouping
// rule is testable without any update arriving.
//
// Returns { photos, caption } -- photos is never null, caption null when
// no update carried one.
export function collectPhotos(updates) {
  const photos = []
  let caption = null
  for (const update of updates) {
    const message = update.message ?? null
    const sizes = message?.photo
    if (Array.isArray(sizes) && sizes.length > 0) {
      // The largest size is the useful one; file_id is what getFile takes.
      const best = sizes[sizes.length - 1]
      photos.push({ fileId: best.file_id, width: best.width, height: best.height })
    }
    if (caption === null && typeof message?.caption === 'string' && message.caption.trim() !== '') {
      caption = message.caption.trim()
    }
  }
  return { photos, caption }
}

// The decision. CHAT_DRIVER_VISION=off -> the model must NOT be handed a
// picture it cannot look at: pretending to have seen it is the one lie
// this switch exists to prevent. The caption still travels as text.
export function photoDecision({ enabled, photoCount }) {
  if (photoCount <= 0) return { photo: false, textOnly: true }
  return enabled
    ? { photo: true, textOnly: false }
    : { photo: false, textOnly: true, blind: true }
}

// The content the model receives. A single string is the old shape; with
// a photo the OpenAI-compatible content-parts shape is used -- aiClient's
// requestCompletion passes `messages` through untouched, so this rides
// the existing client without changing it.
export function buildUserContent({ text, dataUrl }) {
  if (!dataUrl) return text
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]
}

// What the app thread records for an incoming photo turn. Brackets, so
// the thread shows the fact without pretending to render the image.
export function incomingRecordText({ caption, blind }) {
  const body = caption || '(photo)'
  return blind
    ? `[photo] ${body}`
    : `[photo] ${body}`
}

// What the bot says in the group when vision is off: the truth, once,
// without theatre. The caption is still forwarded to the driver.
export function BLIND_PHOTO_NOTICE() {
  return 'Photo received, but the current model cannot look at pictures. The text part was delivered as-is.'
}
