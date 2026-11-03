import { asciiPunct } from './plainText.js'

// Assertions are scoped locally: a refusal or uncertainty in one clause
// cannot excuse a later promise. Keep numeric commas and duration sums.
export function claimClauses(value) {
  return asciiPunct(String(value ?? ''))
    .replace(/,\s*(?=no matter who|(?:that(?: is|'s)?|it is)\s+(?:okay|ok|fine|good|works)\b)/gi, ' ')
    .split(/(?<=[.!?;])\s+|,(?!\d)|\b(?:but|however|yet|though)\b|\band\s+(?=(?:i|we|my|your|the|it|traffic|weather|yes|go ahead|put|ship|send|use)\b)/i)
}
