// What a photo means, decided before anything is fetched or sent.
//
// Pure functions only: the poll loop parses Telegram's update into facts,
// the vision switch decides what happens, and the honest wording for a
// model that cannot see lives here too -- one place, so the honesty is
// not scattered across conditionals.

// (collectPhotos used to live here: it folded an album's updates into
// one photo list. Parsing what Telegram sent belongs to ./parse.js, and
// it moved there with its tests. This module keeps the decisions that
// need to know about the model.)

// The decision. CHAT_DRIVER_VISION=off -> the model must NOT be handed a
// picture it cannot look at: pretending to have seen it is the one lie
// this switch exists to prevent. The caption still travels as text.
export function photoDecision({ enabled, photoCount }) {
  if (photoCount <= 0) return { photo: false, textOnly: true }
  return enabled
    ? { photo: true, textOnly: false }
    : { photo: false, textOnly: true, blind: true }
}

// (buildUserContent used to live here and built the content-parts shape a
// second time. driverChat.prompt.js's buildMessages already builds it, on
// the path that actually runs, and two copies of one wire format is how
// they drift. Removed 2026-09-28 -- the shape has one owner.)

// What the app thread records for an incoming photo turn. Brackets, so
// the thread shows the fact without pretending to render the image.
export function incomingRecordText({ caption, blind }) {
  const body = caption || '(photo)'
  // Both branches used to return the same string, which made `blind` a
  // parameter that decided nothing and a test that could not tell the
  // two cases apart. The thread is the dispatcher's own record: when the
  // model could not look at the picture, the record says so.
  return blind ? `[photo, not seen] ${body}` : `[photo] ${body}`
}

// What the bot says in the group when vision is off: the truth, once,
// without theatre. The caption is still forwarded to the driver.
export function BLIND_PHOTO_NOTICE() {
  return 'Photo received, but the current model cannot look at pictures. The text part was delivered as-is.'
}
