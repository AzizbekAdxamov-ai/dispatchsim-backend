# DispatchSim API

Backend REST API for DispatchSim — authentication and user accounts backed
by PostgreSQL. Each account can hold **multiple** work-area roles
(dispatcher / HR / finance / fleet-manager) granted by an administrator or
an invite code, and works in exactly one of them — its `activeRole` — at a
time.

## Requirements

- Node.js 20+
- PostgreSQL 13+

## Installation

```bash
npm install express pg bcryptjs jsonwebtoken zod cors express-rate-limit dotenv
npm install --save-dev prisma
```

## Configure your environment

Copy the example env file and fill it in — never commit the real values:

```bash
cp .env.example .env
```

Generate a JWT signing secret (at least 32 characters):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Paste the output into `JWT_SECRET` in `.env`. Set `DATABASE_URL` to point at
your own PostgreSQL instance and password — `.env` is git-ignored and must
never contain a real secret committed to version control.

| Variable          | Required | Default                        | Notes                                   |
|-------------------|----------|---------------------------------|------------------------------------------|
| `DATABASE_URL`    | yes      | —                                | PostgreSQL connection string             |
| `JWT_SECRET`      | yes      | —                                | Min 32 chars. Keep this secret.          |
| `JWT_EXPIRES_IN`  | no       | `24h`                            | e.g. `1h`, `7d`                          |
| `PORT`            | no       | `4000`                           | Positive integer                         |
| `CORS_ORIGIN`     | no       | `http://localhost:5173`          | Allowed frontend origin                  |
| `NODE_ENV`        | no       | `development`                    | `production` hides error `details`       |
| `DEFAULT_ROLE`    | no       | *(blank → new accounts start with no roles)* | One of the four role keys, or blank. Grants that ONE role automatically at registration (as a starting **role in the granted set**, not a raw column write) when the signup did not use an invite code. An invite code's own roles always take priority over this when both apply. |

## Create the database

Using the provided `docker-compose.yml` (starts PostgreSQL only):

```bash
POSTGRES_PASSWORD=your-local-dev-password docker compose up -d
```

Or point `DATABASE_URL` in `.env` at any PostgreSQL 13+ instance you already
have running — the database itself (e.g. `dispatchsim`) must exist before
running migrations.

## Run migrations

```bash
npm run migrate
```

Applies every `*.sql` file under `src/db/migrations/` that hasn't already
been recorded in the `schema_migrations` table, in filename order.

## Run the server

```bash
npm run dev    # auto-restarts on file changes (node --watch)
npm start      # plain run, for production
```

On success:

```
DispatchSim API → http://localhost:4000
```

## First administrator

Registration never grants admin access — `POST /auth/register` always
creates an ordinary account (see Endpoints below). To create the first
administrator, register a normal account through the app, then run:

```bash
npm run grant:admin -- someone@example.com
```

This is a one-off bootstrap step. After the first administrator exists,
every other admin is granted through the app itself:
`PATCH /admin/users/:id` with `{ "isAdmin": true }`, done by an existing
administrator.

## The multi-role model

- **`roles`** — the set of work areas an account is allowed to use. Always
  an array (`[]` when none). Granted by an administrator
  (`PATCH /admin/users/:id`, `POST /admin/users/bulk-roles`) or by
  redeeming an invite code at registration. A student never grants a role
  to themselves.
- **`activeRole`** — which single granted role the account is currently
  working in. `null` only when `roles` is empty (no work area open yet —
  the account is "pending"). A student switches their own `activeRole`
  among their granted roles with `PATCH /auth/active-role`, but can never
  set it to a role they don't have — that request is rejected with
  `403 ROLE_NOT_GRANTED`, enforced both in application code and by the
  database itself (a deferrable `users_active_role_fk` composite foreign
  key against `user_roles`, added in migration 003 — see that file's
  comments for why it's impossible to bypass, even from a bug elsewhere in
  this codebase).
- **`isAdmin`** — a separate permission, independent of `roles`. Unchanged
  from before the multi-role model.

The JWT issued at login/register carries only the user id (`sub`) — no role
data at all. Every request re-reads roles/activeRole/isAdmin fresh from the
database, so a role grant, a role switch, or an admin promotion/demotion
all take effect on the very next request, never requiring the user to log
in again.

## Invite codes

An administrator can generate a link (`POST /admin/invites`) that grants a
fixed set of roles to whoever registers through it, without that admin
having to touch each account individually afterward. A code looks like
`DISPATCH-2026-A-K7M2QX4B`: an optional, admin-chosen, human-readable
prefix, and an 8-character block that the server always generates
(~39 bits of entropy, drawn from an alphabet that excludes characters easily
confused with one another when copied by hand — see `src/lib/inviteCode.js`).
The prefix is intentionally guessable; the random block is the only part
that provides real unpredictability, and an admin never controls it.

An invite code can **never** grant admin access — there is no field or code
path anywhere that connects `invite_codes` to `is_admin`. It only ever
grants entries in `roles`.

`roles`, once set at creation, and the `code` itself are permanent — a
distributed link's roles can't be changed retroactively. To change what a
cohort gets, deactivate the old code (`PATCH /admin/invites/:id` with
`{ "isActive": false }`) and create a new one.

There is no "preview a code" endpoint — a code is only ever checked at
`POST /auth/register`, behind that route's rate limiter, so there is no way
to probe whether a guessed code is valid without actually attempting (and
consuming an attempt against) a real registration.

## Endpoints

| Method | Path                    | Auth                  | Body / Query                                                          | Success response |
|--------|-------------------------|------------------------|--------------------------------------------------------------------------|-------------------|
| GET    | `/health`               | none                   | —                                                                          | `200 { ok: true }` |
| POST   | `/auth/register`        | none (rate-limited)    | `{ name, company, email, password, invite? }`                             | `201 { token, user }` |
| POST   | `/auth/login`           | none (rate-limited)    | `{ email, password }`                                                      | `200 { token, user }` |
| GET    | `/auth/me`              | Bearer token            | —                                                                            | `200` user |
| PATCH  | `/auth/active-role`     | Bearer token            | `{ activeRole }`                                                            | `200` user |
| GET    | `/admin/users`          | Bearer token, admin     | query: `filter, search, page, limit`                                       | `200 { users: [...], meta }` |
| PATCH  | `/admin/users/:id`      | Bearer token, admin     | `{ roles?, isAdmin? }` (at least one required)                             | `200` user |
| POST   | `/admin/users/bulk-roles` | Bearer token, admin   | `{ userIds: [1..200], mode?: 'add'\|'replace', roles: [1..4] }`            | `200 { results, summary }` |
| GET    | `/admin/invites`        | Bearer token, admin     | query: `filter, page, limit`                                               | `200 { invites, meta }` |
| POST   | `/admin/invites`        | Bearer token, admin     | `{ label?, prefix?, roles: [1..4], expiresAt?, maxUses? }`                 | `201` invite |
| PATCH  | `/admin/invites/:id`    | Bearer token, admin     | `{ isActive?, expiresAt?, maxUses?, label? }` (at least one required)      | `200` invite |

`token` is a JWT — send it back on subsequent requests as
`Authorization: Bearer <token>`. It carries only the user id; see "The
multi-role model" above.

`user` in register/login/me/active-role/admin responses has the shape:

```json
{
  "id": "uuid",
  "name": "...",
  "email": "...",
  "company": "...",
  "roles": ["dispatcher", "finance"],
  "activeRole": "finance",
  "isAdmin": false
}
```

(never the password hash). `roles` is always an array (`[]` when none);
`activeRole` is `null` only when `roles` is empty.

`GET /admin/users` query params: `filter` is one of `all` (default),
`pending` (no roles granted yet), or `admins`; `search` matches name,
email, or company (case-insensitive, partial match); `page` (default 1) and
`limit` (default 25, max 100) paginate the result. `meta.pendingCount` is
the total count of accounts with no roles granted, regardless of the
current filter/search, for a "pending" badge in the UI.

`PATCH /admin/users/:id` body accepts `roles` (the account's complete new
role set — replacement, not add/remove — omit to leave unchanged) and/or
`isAdmin` (boolean, omit to leave unchanged) — at least one must be
present. `activeRole` is not accepted here; if the edit removes the
account's current `activeRole`, the server recomputes it automatically
(the first still-granted role in `ROLE_KEYS` order, or `null` if the new
set is empty). An admin cannot change their own `isAdmin` flag through this
endpoint (`SELF_ADMIN_CHANGE`), and the last remaining admin cannot be
demoted (`LAST_ADMIN`).

`POST /admin/users/bulk-roles` applies `roles` to every id in `userIds`:
`mode: "add"` (default) grants them on top of whatever each account already
has; `mode: "replace"` sets each account's role set to exactly `roles`.
Each id is processed in its own transaction, so one failing id (e.g.
already deleted) does not affect the others. The response reports every id
individually:

```json
{
  "results": [
    { "id": "...", "status": "updated", "user": { "...": "..." } },
    { "id": "...", "status": "skipped", "code": "USER_NOT_FOUND" }
  ],
  "summary": { "requested": 12, "updated": 11, "skipped": 1 }
}
```

This endpoint never accepts or changes `isAdmin` — see "Invite codes" /
Qaror D notes in the migration comments for why that keeps a bulk action
selecting yourself harmless by construction.

`POST /auth/register` accepts an optional `invite` code. When present, it
must redeem successfully (active, not expired, under its use limit) or the
whole registration fails with `400 INVITE_INVALID` and **no account is
created** — never a silent "registered but unassigned" account. A
successful redemption grants exactly that code's `roles` (ignoring
`DEFAULT_ROLE` entirely); with no `invite`, a new account gets
`DEFAULT_ROLE`'s single role if configured, or no roles at all.

`PATCH /auth/active-role` body: `{ "activeRole": "<role key>" }`
(not nullable — a student can switch between granted roles but can't
un-assign themselves back to "pending"). Rejects with `403
ROLE_NOT_GRANTED` if the caller doesn't currently have that role granted.

`GET /admin/invites` query params: `filter` is one of `all` (default),
`active`, or `inactive`; `page`/`limit` paginate the same way as
`/admin/users`.

`POST /admin/invites` creates a new code and returns it with the plaintext
`code` included (invite codes are not secrets in the password sense — see
"Invite codes" above) — the response is the only place the full code is
ever returned; it is not re-derivable afterward. `roles` must have 1-4
entries. `expiresAt` (ISO timestamp) and `maxUses` (positive integer) are
both optional (no expiry / no use cap when omitted).

`PATCH /admin/invites/:id` updates `isActive`, `expiresAt`, `maxUses`,
and/or `label` — at least one required. `roles` and `code` can never be
changed after creation.

## Error codes

Every error response has the shape `{ error: { code, message } }` (plus a
`details` array in non-production environments for validation errors).

| Code                 | HTTP status | Message                                                |
|----------------------|-------------|---------------------------------------------------------|
| `VALIDATION_ERROR`   | 400         | Request body is invalid                                 |
| `INVALID_CREDENTIALS`| 401         | Email or password is incorrect                          |
| `UNAUTHORIZED`       | 401         | Authentication required                                  |
| `TOKEN_EXPIRED`      | 401         | Session has expired                                       |
| `FORBIDDEN`          | 403         | You do not have access to this area                        |
| `ROLE_NOT_GRANTED`   | 403         | You do not have access to that workspace                    |
| `EMAIL_TAKEN`        | 409         | This email is already registered                             |
| `LAST_ADMIN`         | 409         | At least one administrator must remain                        |
| `SELF_ADMIN_CHANGE`  | 409         | You cannot change your own administrator access                |
| `INVITE_INVALID`     | 400         | This invite code is invalid or has expired                      |
| `INVITE_NOT_FOUND`   | 404         | Invite code not found                                             |
| `INVITE_CODE_TAKEN`  | 409         | Could not generate a unique invite code, try again                 |
| `USER_NOT_FOUND`     | 404         | User not found                                                       |
| `LOAD_NOT_FOUND`     | 404         | Load not found                                                        |
| `DRIVER_NOT_FOUND`   | 404         | Driver not found                                                       |
| `TRUCK_NOT_FOUND`    | 404         | Truck not found                                                         |
| `RATE_LIMITED`       | 429         | Too many attempts, try again later                                    |
| `ROUTE_NOT_FOUND`    | 404         | Route not found                                                         |
| `INTERNAL_ERROR`     | 500         | Something went wrong                                                     |

## Dispatch, fleet & finance (read-only)

Migrations `005`-`009` add five tables — `drivers`, `trucks`, `loads`,
`maintenance_records`, `truck_daily_metrics` — and the API layer above them
is **read-only** in this phase: every route below is a `GET`. Writing to
these tables (assigning a driver, changing a load's status, ...) needs HOS/
conflict rules that belong with the human-role work coming next, so it is
deliberately out of scope here — see each migration file's own header
comment for the schema reasoning (RAW values only, no UI labels, no
computed columns; `numeric` is never used, see Qaror Q2 below).

### `requireRole`

Unlike `/admin/*` (gated by the separate `isAdmin` permission via
`requireAdmin`), these routes are gated by `requireRole(...keys)`
(`src/middleware/requireRole.js`) against the caller's **granted role
set** (`roles`), never `activeRole` — the same thing `ProtectedRoute`
checks on the frontend, so a request can never fail from the user simply
having a different workspace open at the moment. `requireRole()` with no
arguments means "any granted role is enough" (used by `/loads`, `/drivers`,
`/stats/dashboard` — every role's home page reads from these); `requireRole
('fleet-manager')` / `requireRole('finance')` restrict to that one role
specifically, matching the two areas the frontend itself gates
(`/fleet/*`, `/finance/*`). Like `requireAdmin`, it re-reads roles fresh
from the database on every request — a grant or revoke by an admin takes
effect on the very next request, not on next login.

### Endpoints

| Method | Path                      | Auth                              | Query                                          | Success response |
|--------|---------------------------|-------------------------------------|--------------------------------------------------|-------------------|
| GET    | `/loads`                  | any granted role                    | `status?, equipmentType?, search?, page?, limit?` | `200 { loads, meta: { total, page, limit, counts } }` |
| GET    | `/loads/:id`               | any granted role                    | —                                                 | `200` load + `progress`, `timeline[]`, `driver`, `truck` |
| GET    | `/drivers`                 | any granted role                    | `limit?` (unused by the frontend today)            | `200 { drivers, meta: { counts } }` |
| GET    | `/drivers/:id`              | any granted role                    | —                                                 | `200` driver + `truck`, `currentLoad`, `recentLoads[]` |
| GET    | `/stats/dashboard`          | any granted role                    | —                                                 | `200 { stats, onTimeTrend, utilizationTrend }` |
| GET    | `/fleet/trucks`              | `fleet-manager`                     | `limit?`                                          | `200 { trucks, meta: { counts, avgFuelPct } }` |
| GET    | `/fleet/trucks/:id`           | `fleet-manager`                     | —                                                 | `200` truck + `metrics`, `costBreakdown[]`, `fuelTrend[]`, `distanceTrend[]` |
| GET    | `/fleet/maintenance`          | `fleet-manager`                     | `limit?`                                          | `200 { records, meta: { counts, monthCostUsd } }` |
| GET    | `/finance/overview`            | `finance`                           | —                                                 | `200` KPIs + `agingBuckets[]`, `cashFlowTrend[]`, `loadProfitability[]`, `assumptions` |
| GET    | `/finance/invoices`             | `finance`                           | `status?, search?, page?, limit?`                  | `200 { invoices, meta: { total, page, limit, counts } }` |
| GET    | `/finance/invoices/:id`          | `finance`                           | —                                                 | `200` invoice + `load` |
| GET    | `/finance/settlements`            | `finance`                           | —                                                 | `200 { settlements, periodStart, periodEnd }` |
| GET    | `/finance/expenses`                | `finance`                           | —                                                 | `200 { expenses, meta: { byCategory, totalUsd } }` |

### Pagination

Only `/loads` and `/finance/invoices` paginate (`page` default 1, `limit`
default 25, max 100 — same defaults as `/admin/users`), because both list
~200 rows. `meta.counts` on both is computed against the *same*
`search`/`equipmentType` (or invoices' `search`) filter as the list itself,
but **not** the `status` tab filter — so every tab in the UI's tab strip
can show an accurate badge for the current search, not just whichever tab
is open. It's a single `COUNT(*) FILTER (WHERE ...)` query, not one round
trip per tab.

`/drivers`, `/fleet/trucks`, and `/fleet/maintenance` are **not**
paginated — at ~30/~15/~50 rows they're one screenful each and the
frontend has no pagination UI for them. `limit` is still accepted (default
100/100/200, max 200) purely as a forward-compatible ceiling.

### RAW values, not display strings

Every timestamp is `timestamptz` (ISO 8601 on the wire); every distance/
weight/rate is a plain integer (`distance_mi`, `weight_lbs`, `rate_usd`);
ratings that look fractional in the UI are fixed-point integers
(`safety_rating` 0-100, `broker_rating_x10` = rating × 10). Formatting
(`'282 mi'`, `'$1,850'`, `'Aug 19, 08:00'`) is entirely the frontend's job
(`frontend/src/utils/format.js`) — this API never sends a pre-formatted
string. `equipmentType` is always a key (`'dry-van'`), never a label,
mirroring `roles`. No response ever includes a computed color
(`costBreakdown[].color` etc.) — CLAUDE.md's "hardcoded rang yoʻq" rule
applies to the API too, not just CSS.

### Why no `numeric` columns anywhere

`node-pg` returns a `numeric`/`decimal` column as a **string**
(`'1850.00'`), which silently breaks `.toLocaleString()` and similar
frontend math instead of throwing. So money that must round-trip exactly
(`rate_usd`, `cost_usd`, ...) is stored as a whole-dollar `integer`, and
every *fractional* dollar figure (driver pay, fuel cost, margins, invoice
amounts) is computed in JavaScript with `Math.round(n * 100) / 100`
(`src/lib/money.js`) at read time, never stored. `COUNT(*)`/`SUM(...)`
results are always cast with `::int` for the same reason (`bigint` also
comes back as a string).

## Browsing the database

For local development, [Prisma](https://www.prisma.io/) is wired in purely
as a database *browser* — a GUI to look at rows, nothing more:

```bash
npm run db:pull     # introspects the live DB into prisma/schema.prisma
npm run db:studio   # opens Prisma Studio in your browser
```

`npm run db:pull` regenerates `prisma/schema.prisma` from whatever the
database currently looks like — that file is marked generated and should
never be hand-edited or trusted as documentation; the real schema always
lives in `src/db/migrations/*.sql`.

⚠️ **Never run `prisma migrate` or `prisma db push`.** This project's schema
is owned entirely by the hand-written SQL files in `src/db/migrations/`,
applied with `npm run migrate`. Letting Prisma write or push schema changes
would create a second, competing source of truth and could drift the
database out of sync with what the migrations describe. Prisma here is
read-only tooling (`db pull` + `studio`), and Prisma Studio itself should
only ever be run against your local database, never pointed at a shared or
production one.

## Recovery: no administrators left

This shouldn't be reachable through the API — `PATCH /admin/users/:id`
refuses to demote the last remaining admin (`LAST_ADMIN`). But if an
environment somehow ends up with zero admins (e.g. a row deleted directly
in the database, outside the app), recover by running the bootstrap script
again against an existing account:

```bash
npm run grant:admin -- someone@example.com
```

This talks to the database directly, bypassing the API and its
last-admin guard, which is exactly why it's a local CLI script rather than
an endpoint.

## Folder structure

```
backend/
├── docker-compose.yml        # local PostgreSQL only
├── .env.example
├── package.json
├── prisma/
│   └── schema.prisma         # generated by `npm run db:pull`, for Studio only
├── scripts/
│   └── grant-admin.js        # CLI: grant admin access by email
└── src/
    ├── app.js                # Express app: middleware + routes
    ├── server.js             # entry point: listen() + graceful shutdown
    ├── config.js              # env loading/validation
    ├── constants/
    │   └── roles.js           # ROLE_KEYS + pickActiveRole — single source of truth for roles
    ├── db/
    │   ├── pool.js             # pg Pool + query() + withTransaction()
    │   ├── migrate.js          # migration runner
    │   └── migrations/
    │       ├── 001_init_users.sql
    │       ├── 002_admin_access.sql
    │       ├── 003_user_roles.sql     # user_roles table, role → active_role rename, composite FK
    │       ├── 004_invite_codes.sql   # invite_codes table
    │       ├── 005_drivers.sql        # drivers table
    │       ├── 006_trucks.sql         # trucks table (FK drivers)
    │       ├── 007_loads.sql          # loads table (FK drivers, trucks)
    │       ├── 008_maintenance_records.sql  # maintenance_records table (FK trucks)
    │       └── 009_truck_daily_metrics.sql  # truck_daily_metrics table (FK trucks)
    ├── lib/
    │   ├── errors.js           # ERROR_CODES + AppError
    │   ├── password.js         # bcrypt hash/verify + DUMMY_HASH
    │   ├── token.js             # JWT sign/verify (payload carries only the user id)
    │   ├── inviteCode.js        # random invite-code block generator
    │   ├── money.js              # money(n): fractional-dollar rounding, never stored
    │   └── loadTimeline.js       # computeProgress/computeTimeline, shared by loads + drivers
    ├── middleware/
    │   ├── requireAuth.js
    │   ├── requireAdmin.js      # gates /admin/* — reads is_admin fresh from DB
    │   ├── requireRole.js       # gates /loads, /drivers, /stats, /fleet, /finance by granted roles
    │   ├── rateLimit.js         # authLimiter, registerLimiter
    │   ├── notFound.js
    │   └── errorHandler.js
    └── modules/
        ├── auth/
        │   ├── auth.schemas.js         # zod: registerSchema, loginSchema, activeRoleSchema
        │   ├── users.repository.js     # only file with SQL for `users`
        │   ├── userRoles.repository.js # only file with SQL for `user_roles`
        │   ├── auth.service.js         # register/login/me/setActiveRole business logic
        │   ├── auth.controller.js      # HTTP handlers
        │   └── auth.routes.js          # POST /register, /login, GET /me, PATCH /active-role
        ├── admin/
        │   ├── admin.schemas.js        # zod: user + bulk + invite schemas
        │   ├── admin.service.js        # list/update-access/bulk-assign business logic
        │   ├── invites.repository.js   # only file with SQL for `invite_codes`
        │   ├── invites.service.js      # invite generation/listing/patching business logic
        │   ├── admin.controller.js     # HTTP handlers (users + invites)
        │   └── admin.routes.js         # GET/PATCH /users, POST /users/bulk-roles, /invites routes
        ├── loads/
        │   ├── loads.repository.js     # only file with SQL for `loads`
        │   ├── loads.schemas.js
        │   ├── loads.service.js        # + progress/timeline via lib/loadTimeline.js
        │   ├── loads.controller.js
        │   └── loads.routes.js         # GET /, GET /:id
        ├── drivers/
        │   ├── drivers.repository.js   # only file with SQL for `drivers`
        │   ├── drivers.schemas.js
        │   ├── drivers.service.js
        │   ├── drivers.controller.js
        │   └── drivers.routes.js       # GET /, GET /:id
        ├── fleet/
        │   ├── trucks.repository.js       # only file with SQL for `trucks`
        │   ├── maintenance.repository.js  # only file with SQL for `maintenance_records`
        │   ├── metrics.repository.js      # only file with SQL for `truck_daily_metrics`
        │   ├── fleet.schemas.js
        │   ├── fleet.service.js
        │   ├── fleet.controller.js
        │   └── fleet.routes.js         # GET /trucks, /trucks/:id, /maintenance
        ├── finance/
        │   ├── finance.constants.js    # FUEL_PRICE_PER_GAL, AVG_MPG, FIXED_COST_PER_MILE, ...
        │   ├── finance.repository.js   # aggregate-only SQL over loads/drivers/trucks/maintenance_records — see its header comment
        │   ├── finance.schemas.js
        │   ├── finance.service.js      # all fractional-money math (lib/money.js)
        │   ├── finance.controller.js
        │   └── finance.routes.js       # GET /overview, /invoices, /invoices/:id, /settlements, /expenses
        └── stats/
            ├── stats.service.js        # composes loads/drivers/fleet-metrics repos, no SQL of its own
            ├── stats.controller.js
            └── stats.routes.js         # GET /dashboard
```
