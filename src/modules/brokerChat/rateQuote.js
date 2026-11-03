// Money is stored once as TOTAL. Itemization is a quote basis, never an
// additional charge to be added again by booking, invoices or the ledger.
export const ALL_IN = 'all-in'
export const SPLIT_RATE = 'linehaul-plus-fuel'
export const money = (n) => `$${Number(n).toLocaleString('en-US')}`

export function rateQuote(source = {}, total = source.rateUsd) {
  const basis = source.rateBasis ?? ALL_IN
  const fuel = source.fuelSurchargeUsd ?? 0
  if (![ALL_IN, SPLIT_RATE].includes(basis) || !Number.isInteger(total) || total < 0
    || !Number.isInteger(fuel) || fuel < 0 || fuel > total || (basis === ALL_IN && fuel !== 0)
    || (basis === SPLIT_RATE && (fuel === 0 || fuel === total))) throw new TypeError('Invalid rate quote')
  return { rateUsd: total, rateBasis: basis, fuelSurchargeUsd: fuel, linehaulUsd: basis === SPLIT_RATE ? total - fuel : null }
}

export function quoteText(source, total = source.rateUsd) {
  const quote = rateQuote(source, total)
  return quote.rateBasis === SPLIT_RATE
    ? `${money(quote.linehaulUsd)} linehaul plus ${money(quote.fuelSurchargeUsd)} fuel (${money(quote.rateUsd)} total)`
    : `${money(quote.rateUsd)} all-in`
}

export function paperQuote(data) {
  const total = data.rateConRateUsd ?? data.agreedRateUsd
  return rateQuote({ rateBasis: data.rateConBasis ?? ALL_IN, fuelSurchargeUsd: data.rateConFuelSurchargeUsd ?? 0 }, total)
}
