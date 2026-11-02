// A/B arms for chat:eval (`--arm B`): one arm is a set of CHAT_AB_<ARM>_*
// variables naming a base URL, key, model and optional provider pin. Pure --
// the script calls applyArm once, before any chat config is read.
//
// Errors name the MISSING VARIABLES only. A value (above all the key) is never
// put in a message.

import { groqReasoningParams, openRouterReasoningParams, providerFor } from '../src/constants/chatBudget.js'

// { arm: null } without the flag, { arm: 'B' } with a value, { error } when
// `--arm` has no value or the next token is another flag.
export function parseArm(args) {
  const eq = args.find((a) => a.startsWith('--arm='))?.slice('--arm='.length)
  const position = args.indexOf('--arm')
  if (eq === undefined && position === -1) return { arm: null }
  const raw = (eq ?? args[position + 1] ?? '').trim()
  if (raw === '' || raw.startsWith('--')) return { error: '--arm needs a value, e.g. --arm B' }
  const arm = raw.toUpperCase()
  if (!/^[A-Z0-9]+$/.test(arm)) return { error: `--arm value must be letters or digits: ${raw}` }
  return { arm }
}

// Copies the arm's variables over both chats' own variables in `env`.
// PROVIDER_ORDER is always overwritten ('' when the arm has none) so an arm
// never inherits another arm's, or the production, pin.
export function applyArm(env, arm) {
  const errors = []
  const present = (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  for (const suffix of ['BASE_URL', 'API_KEY', 'MODEL']) {
    const from = `CHAT_AB_${arm}_${suffix}`
    if (!present(from)) { errors.push(from); continue }
    env[`CHAT_BROKER_${suffix}`] = env[from]
    env[`CHAT_DRIVER_${suffix}`] = env[from]
  }
  const order = present(`CHAT_AB_${arm}_PROVIDER_ORDER`) ? env[`CHAT_AB_${arm}_PROVIDER_ORDER`] : ''
  env.CHAT_BROKER_PROVIDER_ORDER = order
  env.CHAT_DRIVER_PROVIDER_ORDER = order
  // providerOrderFor treats a blank own var as unset and falls through to the
  // shared one, so the shared pin must be replaced too or production's pin
  // would leak into an arm that has none.
  env.CHAT_PROVIDER_ORDER = order
  return { errors }
}

// With an arm only the measured model may answer: no fallback to another model.
export function armConfig(config, arm) {
  if (!arm) return config
  const { fallbackModel, ...rest } = config
  return rest
}

// What the request asks for, 'n/a' where the model takes no such field.
export function reasoningEffortOf(config) {
  const reasoning = openRouterReasoningParams(config.baseUrl, config.model, config.chat)?.reasoning
  if (!reasoning) return groqReasoningParams(config.baseUrl, config.model, config.chat).reasoning_effort ?? 'n/a'
  return reasoning.effort ?? (reasoning.enabled === false ? 'enabled:false' : 'n/a')
}

// The fields both eval records (broker and driver) carry about the arm.
export function armRecordFields(config, arm) {
  return { arm, provider: providerFor(config.baseUrl).id, providerOrder: config.providerOrder }
}
