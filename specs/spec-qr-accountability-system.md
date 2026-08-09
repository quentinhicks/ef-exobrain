> **Historical.** This is the original design, when Gates ran on a Cloudflare
> Worker with a D1 database and charged through Stripe. All three are gone: the
> system runs on the app's own host and database (2026-08-08), and the charge
> provider became Beeminder before that. For what actually runs, see
> [`../QR-accountability/RUNBOOK.md`](../QR-accountability/RUNBOOK.md).

# QR Accountability System — Implementation Status

Companion system to the productivity tracker. Self-imposed, location-bound
enforcement: location-bound QR/NFC scans, constant $10 stake, no escalation.
WIP=1 — only the Work QR node is being built. Morning/Night activate later
on their own logged merit, per original build sequence.

## Stack (decided, with rationale)

- **Compute**: Cloudflare Workers, free tier. Chosen over a Hetzner VPS
  (€5.49/mo at current 2026 pricing) because actual load — a handful of
  requests/day — is far under every free-tier limit (100K req/day,
  D1's 5M rows-read/day). Stateless by design: the `scheduled` handler
  re-derives "was today's window satisfied" fresh from D1 on every tick
  rather than trusting in-memory state carried from a prior run.
- **Storage**: D1 (SQLite-compatible), bound as `env.DB`. Schema below.
- **Scheduling**: Cron Trigger, fires every 5 minutes in UTC. Local-time
  conversion happens *inside* the handler via `Intl.DateTimeFormat` with a
  `LOCAL_TZ` env var — deliberately not encoded in the cron string, to
  avoid DST-driven maintenance twice a year.
- **Verification substrate**: `/scan/<token>` — a long random token per
  node, substrate-agnostic by design. Works identically whether the URL
  is reached via a printed QR code or an NFC tag's NDEF record. Swapping
  QR → NFC later is a physical-artifact change only; zero backend change.
- **Presence proof for Work QR specifically**: browser geolocation +
  server-side geofence check (haversine distance vs. `geofence_lat/lng/
  radius_m`). This works for Work QR because the office is a different
  building than home — GPS resolves "different building" easily. It does
  **not** work for Morning/Night (same residence) — GPS can't resolve
  rooms. Those nodes will need NFC specifically for the physical-tap
  requirement, not just for convenience.
- **Charging**: Stripe, off-session `PaymentIntent`s against a saved
  payment method. Card captured once via a Checkout Session in `setup`
  mode (script below). `Idempotency-Key` of `{node_id}-{date}` on every
  charge call, to prevent a retry from double-charging. Secret key lives
  only as a Workers Secret (`wrangler secret put STRIPE_SECRET_KEY`) —
  never in code, D1, or client-side JS.
- **Stripe account**: Individual/Sole Proprietor business type (SSN, no
  EIN/LLC needed). Business name = own legal name. Description: "Personal
  software development and automation tools." Category: Software.
- **Live-charging gate**: `LIVE_CHARGING` var in `wrangler.toml`, defaults
  to `"false"`. While false, misses log as `charge_status = 'would_fire'`
  with no money moved — lets the whole pipeline run for real before any
  dollar is at stake. Flipping it requires editing the var and redeploying
  — **deliberately not exposed as an in-app toggle anywhere**, including
  any future admin interface (see Open Items).

## D1 schema (already created and pushed to remote)

```sql
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  window_start TEXT NOT NULL,        -- 'HH:MM' local
  window_end TEXT NOT NULL,
  geofence_lat REAL,                 -- null = no geofence check
  geofence_lng REAL,
  geofence_radius_m INTEGER,
  requires_todo INTEGER DEFAULT 0,   -- 1 only for Work QR
  active INTEGER DEFAULT 1
);

CREATE TABLE scan_events (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  scanned_at TEXT NOT NULL,
  lat REAL,
  lng REAL,
  geofence_pass INTEGER,
  todo_submitted_at TEXT
);

CREATE TABLE charge_log (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  date TEXT NOT NULL,
  failure_reason TEXT,               -- 'absent' | 'present_no_task'
  charge_status TEXT,                -- 'would_fire' | 'succeeded' | 'declined' | 'failed'
  stripe_payment_intent_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(node_id, date)
);

CREATE TABLE billing_config (
  customer_id TEXT NOT NULL,
  payment_method_id TEXT NOT NULL
);
```

## Files already created — read these before changing anything

- `schema.sql` — schema above, already executed against the remote D1 DB.
- `qr-worker/wrangler.toml` — D1 binding (`DB`), cron trigger
  (`*/5 * * * *`), `LOCAL_TZ` and `LIVE_CHARGING` vars. `database_id`
  placeholder needs the real UUID from `wrangler d1 create`.
- `qr-worker/src/index.js` — the Worker. `fetch` handler: GET serves a
  page that requests geolocation (and a to-do textarea if
  `requires_todo`), POST logs the scan with the geofence check.
  `scheduled` handler: for each active node whose window has closed
  locally and hasn't been evaluated today, checks the last 24h of
  `scan_events` for a satisfying scan, determines `failure_reason`,
  calls Stripe only if `LIVE_CHARGING === "true"`, writes `charge_log`.
- `setup_card.py` — one-time local script (run on your machine, not
  deployed): creates a Stripe Customer, opens a Checkout Session in
  `setup` mode, retrieves the resulting `customer_id`/`payment_method_id`
  for you to insert into `billing_config`.

## Control surface (from the original spec — not yet implemented as code)

Asymmetric by design:
- **Tighten** (narrower window, smaller geofence radius, turning
  `requires_todo` on): immediate, no gate.
- **Loosen** (wider window, larger geofence, deactivating a node):
  24-hour delay.
- **Full disable**: requires a human conversation; human assesses from
  scan/log history, not self-report. No night-time disable path — fails
  closed if the human is unreachable.
- **Dirty disable** (direct DB/process edit): left technically
  unhardened on purpose. Integrity rests on routing every disable,
  clean or dirty, through the human conversation — an accepted single
  point of failure, validated over time via the disable-event log.
- Token secrecy is the same category of trust, one layer down: NFC and
  geofencing raise friction against autopilot bypass, not against a
  deliberate decision to defeat the system — that line is held by intent,
  same as the dirty-disable path.

## Pending action — Work QR node not yet inserted

Token already generated: `GjZWXNLukPCo2gzmNL9oHXxHyjDyo_UrfpExhpAAVkg`

```
wrangler d1 execute qr-accountability --remote --command "INSERT INTO nodes (label, token, window_start, window_end, geofence_lat, geofence_lng, geofence_radius_m, requires_todo) VALUES ('Work QR', 'GjZWXNLukPCo2gzmNL9oHXxHyjDyo_UrfpExhpAAVkg', '09:00', '09:30', <office_lat>, <office_lng>, 150, 1);"
```
`<office_lat>`/`<office_lng>` and the window times are placeholders —
confirm real values before running.

## Secrets set on the Worker

- `INTERNAL_SECRET` — used by Flask to authenticate `POST /internal/todo-submitted`
- `ADMIN_SECRET` — used by Flask to authenticate all `/admin/*` Worker routes
- `STRIPE_SECRET_KEY` — not yet set; run `wrangler secret put STRIPE_SECRET_KEY`
- `RESEND_API_KEY` — not yet set; sign up at resend.com, run `wrangler secret put RESEND_API_KEY`

### People CRM phone surface (`/people`) — added, STAGED, not yet deployed

The People CRM addendum (`spec-people-crm.md`) adds a passphrase-gated phone
page and internal sync routes to `index.js`. It introduces three new Worker
**secrets** (set via `wrangler secret put`, never committed to `wrangler.toml`):

- `PEOPLE_PASS_HASH` — SHA-256 hex of (`PEOPLE_SALT` + passphrase). The
  passphrase itself is never stored; only this hash is compared (constant-time).
- `PEOPLE_SALT` — a random string folded into the passphrase hash.
- `PEOPLE_COOKIE_SECRET` — HMAC-SHA256 key that signs the `people_sess` cookie
  (`<expiry-ms>.<hex HMAC(expiry)>`, HttpOnly/Secure/SameSite=Lax, 30-day life).

`INTERNAL_SECRET` (already set) also gates the new internal routes
`/internal/people-snapshot`, `/internal/people-capture` (GET+POST), and
`/internal/crm-outcome`.

Compute `PEOPLE_PASS_HASH` from a chosen salt + passphrase:

```
node -e "crypto.subtle.digest('SHA-256',new TextEncoder().encode(process.argv[1]+process.argv[2])).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))" "<PEOPLE_SALT>" "<passphrase>"
```

Then: `wrangler secret put PEOPLE_PASS_HASH` (paste the hex), and likewise
`wrangler secret put PEOPLE_SALT` / `wrangler secret put PEOPLE_COOKIE_SECRET`.
Generate the salt and cookie secret from any CSPRNG, e.g.
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

New D1 tables are created lazily (`ensurePeopleTables`): `people_snapshot`
(id=1 read blob), `people_capture` (id=1 phone-append blob), `crm_outcomes`
(date UNIQUE, satisfied — separate from the sleep-QR outcome), and
`people_auth` (id=1 global lockout: 10 fails → 1-hour lock).

## config.json keys needed in the productivity app

Add these to `config.json` in the project root:

```json
{
  "qr_worker_url": "https://<your-worker>.workers.dev",
  "qr_admin_secret": "<ADMIN_SECRET value>",
  "qr_internal_secret": "<INTERNAL_SECRET value>",
  "qr_todo_node_ids": [1]
}
```

`qr_todo_node_ids` should contain the `id` of every node with `requires_todo = 1`.
`SUMMARY_EMAIL_FROM` in `wrangler.toml` must be updated to a Resend-verified sender address.

## Immediate next steps, in order

1. `wrangler d1 create qr-accountability` → paste `database_id` into
   `wrangler.toml`. Set `LOCAL_TZ` to the real IANA timezone.
2. Run the node-insert command above with real coordinates.
3. `wrangler deploy`, then `wrangler secret put STRIPE_SECRET_KEY`.
4. Run `setup_card.py` once locally; insert the resulting
   `billing_config` row.
5. Generate a QR image from `{worker_url}/scan/<token>` and place it at
   the work location. Scan it once on purpose (confirm a `scan_events`
   row), then skip it once on purpose (confirm a `would_fire` row in
   `charge_log`) before touching `LIVE_CHARGING`.

## Open items, not yet decided or built

- **Admin API for the productivity app**: doesn't exist yet. Needs the
  tighten/loosen split above, not plain CRUD — a naive endpoint would let
  a toggle do instantly what the spec requires a 24h delay or a human
  conversation for. Flask should proxy to it with its own admin secret;
  the secret must never reach the pywebview frontend JS directly.
  `LIVE_CHARGING` must never be reachable through this interface.
- **Notifications**: Slack explicitly ruled out by the user. No
  replacement mechanism chosen yet for (a) "a charge just fired" or
  (b) "the Worker/cron silently stopped running."
- **Multi-day backfill**: not implemented. `scheduled` only evaluates
  *today's* window; an outage spanning multiple days does not
  retroactively backfill the missed days when service resumes.
- **Morning/Night nodes**: deferred. Will need NFC tags specifically
  (not QR), since GPS can't distinguish rooms within one residence —
  geofencing, which covers Work QR, doesn't generalize to these.
- **NFC migration**: NTAG213/215 tags, written via a free app ("NFC
  Tools"), with the same `/scan/<token>` URL already in use. No code
  change required when this happens.
