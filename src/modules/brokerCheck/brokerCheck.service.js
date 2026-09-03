// Broker credit check.
//
// In the field a dispatcher runs the MC number past a credit service
// before they commit to a load. The rating is not printed on the board
// (see loadBoard.repository BROKER_COLUMNS) precisely so that this step
// has to be taken on purpose. A dispatcher who skips it books blind and
// meets the consequence in finance when a net60 receivable ages.
//
// A miss is a real answer, not an error at the product level: an MC
// number with no carrier record behind it is worth knowing about, and it
// gets journalled like any other lookup.
import * as repo from './brokerCheck.repository.js'

export async function checkMc({ userId, mcNumber }) {
  const broker = await repo.findBrokerByMc(mcNumber)
  const check = await repo.recordCheck({ userId, mcNumber, broker })

  return {
    found: broker !== null,
    check,
    broker: broker && {
      id: broker.id,
      name: broker.name,
      contactName: broker.contactName,
      mcNumber: broker.mcNumber,
      creditRating: broker.creditRating,
      daysToPay: broker.daysToPay,
    },
  }
}

export async function listChecks({ userId }) {
  return { checks: await repo.listChecks(userId) }
}
