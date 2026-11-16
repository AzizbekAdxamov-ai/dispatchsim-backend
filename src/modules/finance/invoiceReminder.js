// The line posted to the broker thread when the dispatcher chases an overdue
// invoice. Plain follow-up: no dollar amount, no rate talk, no threat of
// cancelling -- the broker's reply logic is not involved, this is only a record
// of the chase in the thread.

export function reminderText({ invoiceId, loadId, daysPastDue }) {
  const unit = daysPastDue === 1 ? 'day' : 'days'
  return (
    `Following up on invoice ${invoiceId} for load #${loadId} — it is now ` +
    `${daysPastDue} ${unit} past due. Can you confirm when payment is scheduled?`
  )
}
