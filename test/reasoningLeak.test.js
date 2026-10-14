// The reasoning-leak check shared by the broker and driver chats. Pure.
// Each test names the mutation it kills.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leaksReasoning } from '../src/lib/reasoningLeak.js'
import { asciiPunct } from '../src/lib/plainText.js'
import { leaksReasoning as brokerLeaks } from '../src/modules/brokerChat/brokerChat.prompt.js'
import { leaksReasoning as driverLeaks } from '../src/modules/driverChat/driverChat.prompt.js'

// The EB02 broker reply, verbatim (reports/eval, run 2026-10-14-08-46-58).
const EB02_NEMOTRON = "What they're asking about isn't on the sheet. A broker who's moved flatbed before would say the posted rate covers linehaul and fuel together -- there's no separate RPM figure. I'd say something like: \"The rate I posted is all-in. Linehaul and fuel together.\" That answers once, and if they push I can add it's the total they see. But I shouldn't volunteer numbers that aren't clearly there. Since they asked, I'll give the direct answer from what's posted. I'll keep it brief and see if they come back on something about the pickup window or equipment.The rate I posted is all-in. Linehaul and fuel together. That's the number they see."

// Kills: a leak check anchored only to the start of the reply (EB02 Nemotron, 2026-10-14)
test('reasoning that follows the opening sentence is a leak', () => {
  assert.equal(leaksReasoning(EB02_NEMOTRON, { roleWord: 'carrier' }), true)
  assert.equal(brokerLeaks(EB02_NEMOTRON), true)
  assert.equal(driverLeaks("Fine. I'd say something like: yeah, rolling."), true)
})

// Kills: a mid-reply pattern that also flags ordinary broker talk
test('ordinary broker and driver talk is not a leak', () => {
  for (const t of [
    "The shipper's asking for a 2 PM appointment.",
    "It's $3.88 a mile, all-in.",
    'I need to get fuel before I roll',
    'We need a reefer for this one, 34 degrees.',
    'A driver with a hazmat card can take it.',
  ]) {
    assert.equal(brokerLeaks(t), false, t)
    assert.equal(driverLeaks(t), false, t)
  }
})

// Kills: the role word swapped or dropped (broker spotting only "the driver is ...", driver only "the carrier is ...")
test('each chat knows its own other side by name', () => {
  assert.equal(brokerLeaks('The carrier is asking about fuel and I should answer'), true)
  assert.equal(driverLeaks('The driver is asking about fuel and I should answer'), true)
  assert.equal(driverLeaks('The carrier is asking about fuel and I should answer'), false)
})

// Kills: matching before normalizing (a curly apostrophe hides the tell)
test('a curly apostrophe does not hide a tell', () => {
  assert.equal(leaksReasoning('Sure. I’ll keep it brief.', { roleWord: 'carrier' }), true)
  assert.equal(leaksReasoning('What they’re asking is simple.', { roleWord: 'carrier' }), true)
})

// Kills: asciiPunct leaving one of the folded characters, or changing plain text
test('asciiPunct folds the typographic characters and leaves plain text alone', () => {
  assert.equal(asciiPunct('all‑in—yes ‘a’ “b” c​d…'), 'all-in-yes \'a\' "b" cd...')
  assert.equal(asciiPunct('‐‑‒–—―−'), '-------')
  assert.equal(asciiPunct('‛′'), "''")
  assert.equal(asciiPunct('    '), '    ')
  assert.equal(asciiPunct('﻿x'), 'x')
  assert.equal(asciiPunct("Plain text, it's $3,820 -- fine."), "Plain text, it's $3,820 -- fine.")
})
