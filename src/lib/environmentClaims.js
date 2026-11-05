import { asciiPunct } from './plainText.js'
import { claimClauses } from './claimClauses.js'

// Neither chat has a weather/traffic feed. Uncertainty elsewhere in an
// answer cannot authorize a local observation or forecast in another clause.
export function inventsEnvironment(reply) {
  return claimClauses(reply).some((clause) => {
    if (clause.trim().endsWith('?')) return false
    const condition = /\b(?:rain(?:ing|y)?|drizzl\w*|snow(?:ing|y)?|sunny|cloudy|storm\w*|windy|icy|fog(?:gy)?|clear (?:day|skies|sky)|traffic(?:'s| is)?\s+(?:(?:usually|generally|pretty|very|fairly|quite)\s+)?(?:light|heavy|smooth|clear)|weather(?:'s| is)?\s+(?:clear|good|bad|fine))\b/i.exec(clause)
    if (!condition) return false
    const before = clause.slice(0, condition.index)
    if (/\b(?:don'?t know|do not know|no idea|not sure|can'?t tell|cannot confirm)\s+(?:if|whether)\s+(?:it(?:'s| is)\s+)?$/i.test(before)) return false
    if (/\b(?:like|enjoy|prefer|hate)\b/i.test(before) || /^\s*(?:if|unless|when)\b/i.test(clause)) return false
    return true
  })
}

export const NO_ENVIRONMENT_LINE = "I don't have verified weather or traffic information to give you."
