# AI seed generator

Generates `src/db/seeds/001_demo_data.sql` -- realistic drivers, trucks,
loads, maintenance records and daily truck telemetry for the tables added
in migrations 005-009. It never touches `users`, `user_roles` or
`invite_codes`: those hold real accounts (yours included), and must
survive re-seeding.

## Quick start

Try it with no setup and no API key:

```
npm run generate:seed -- --dry-run --seed 42
```

This runs the full pipeline (validate -> build -> render -> write) against
a small built-in fixture instead of calling an AI provider, and writes
`src/db/seeds/001_demo_data.sql`. Good for checking the pipeline still
works after a change to any of the `scripts/seed/*.js` files.

For the real thing, put a key in `backend/.env` (copy the block from
`.env.example`):

```
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=<your key>
AI_MODEL=llama-3.3-70b-versatile
AI_MAX_RPM=25
```

Then:

```
npm run generate:seed -- --seed 7
```

Load the result into your database with:

```
npm run seed
```

`npm run seed` runs every `*.sql` file in `src/db/seeds/` (currently just
the one) inside a single transaction, and refuses outright when
`NODE_ENV=production`.

## Which providers work

Any OpenAI-compatible `chat/completions` endpoint. Known to work:

- **Groq** -- `https://api.groq.com/openai/v1`, free keys at console.groq.com
- **OpenRouter** -- `https://openrouter.ai/api/v1`, keys at openrouter.ai/keys
- **Together AI** -- `https://api.together.xyz/v1`
- **Gemini's OpenAI-compat endpoint** -- `https://generativelanguage.googleapis.com/v1beta/openai`
- **A local Ollama** -- `http://localhost:11434/v1` (`AI_API_KEY` can be any
  non-empty string; Ollama doesn't check it)

Nothing in `scripts/seed/` is provider-specific -- swap `AI_BASE_URL` /
`AI_MODEL` and it should just work.

## `--dry-run` and `--seed`

- `--dry-run`: skips the AI provider entirely and runs a small built-in
  fixture through the same validate/build/render/write pipeline a real
  run uses. No network access, no API key needed.
- `--seed <n>`: seeds the deterministic PRNG that drives every random
  choice in the build stage (ids, timestamps, statuses, dollar amounts,
  everything). The same `--seed` against the same accepted AI items
  (or the same `--dry-run` fixture) always produces byte-identical SQL --
  useful for reviewing a diff, or for confirming nothing broke after a
  change (`md5sum` two runs and compare).

Without `--dry-run` and without `AI_API_KEY` set, the generator prints a
short message explaining what's missing and exits non-zero -- it makes no
network request and writes no file.

## Where output lands

- `src/db/seeds/001_demo_data.sql` -- only written when the run passes
  every check below. This is a generated file: re-run the generator
  instead of hand-editing it, any manual change is lost on the next run.
- `scripts/seed-report.json` -- written instead, when the run does NOT
  pass. Contains what was requested vs. accepted per category and why
  (unknown city, rate out of band, banned word, a relational-integrity
  failure from the build stage, etc).

A run either produces a seed file or a report, never a partial version of
the seed file -- there's no such thing as "a mostly-good seed" here.

## What "not good enough" means, and what to do about it

The generator only writes the seed file when ALL of these hold:

1. Every category's accepted count is within 90-110% of what was
   requested (drivers 30, trucks 15, loads 200, maintenance ~45 -- plus
   the 6 fixed anchor loads and 5 fixed anchor drivers, which never count
   against this and are never dropped).
2. Zero banned words anywhere in the rendered SQL.
3. Every foreign key in the generated rows resolves, every id/email/CDL
   number/plate is unique, no driver has two active loads at once, no
   truck has two drivers -- enforced by the build stage itself, which
   throws before anything is rendered if any of this is violated.

If the run fails: open `scripts/seed-report.json` first -- it names which
category (or which relational-integrity rule) failed and why. Common
fixes:

- **A category is short (e.g. "loads: 172/200 accepted, 86%")** -- usually
  the AI provider drifted off the closed lists (an invented city, broker,
  or equipment type). Try a different/larger model, or just re-run --
  batches are independent, so a re-run's accepted count can vary.
- **A banned word made it into the SQL** -- almost always came in through
  free text (a load's `commodity`, a driver's `notes`... wait, only
  maintenance notes and load commodity are free text at all). Re-run;
  `validate.js`'s sweep already dropped the offending item before it ever
  reached the build stage, so this should be rare.
- **A relational-integrity error from the build stage** -- this is a bug
  in `scripts/seed/build.js`, not something a re-run fixes. It means the
  build stage's own assignment logic produced something the database
  schema would reject outright (a dangling FK, a duplicate id, two active
  loads on one driver). File it as a bug against `build.js`.

`npm run generate:seed -- --dry-run --seed 42` is the fastest way to
confirm the pipeline itself (as opposed to the AI provider's output) is
healthy -- the fixture is small and hand-checked, so it should always
pass every gate above.
