// The shape of a line the group sees. Pure: string in, string out.
//
// The bot speaks AS the driver, in a group where several drivers answer,
// so every outgoing message is prefixed with who said it. The dispatcher
// reading the group should never have to ask "which driver was that" --
// and the reply-routing depends on the same pairing being unambiguous.

// The truck column is the plate (trucks.id IS the plate), so the prefix
// reads like the side of the trailer: "Marcus Hale · TRK-104". A driver
// between trucks has no plate; the line then carries the name alone,
// which is still unambiguous -- a missing truck is never rendered as
// the string "undefined".
export function formatDriverMessage({ driverName, truckId, content }) {
  const who = truckId ? `${driverName} · ${truckId}` : driverName
  return `${who}\n${content}`
}
