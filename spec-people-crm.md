# People CRM — spec addendum

**Extends:** `spec.md`. **Touches:** tracker.db schema, Flask routes, a new
sidebar tab, the QR-accountability Worker (`QR-accountability/`).
**Posture:** additive. All CLAUDE.md architecture rules and coding
constraints apply. One sanctioned stack addition: Tabulator 6.x (pinned) via
CDN for the grid — same precedent as ical.js; update CLAUDE.md's stack list.

## Purpose / frame

A networking CRM: a curated spreadsheet of people, made viable by
externalization — the nightly fill is bound to the sleep QR and time-capped,
so upkeep can't sprawl and can't be skipped silently. Design follows the
personal-CRM failure literature: the retention mechanic is per-person cadence
producing a small due-list; the killer is upkeep guilt, so blanks are legal,
overdue never turns red, and nothing accumulates as a backlog.

- **Is:** ~15–150 curated relationships, manually entered, starting EMPTY.
- **Is not:** a contact archive (no mass import in v1), no auto-enrichment
  (scraped data going stale destroys trust — Clay's documented failure).

## Data model (new tables, storage.py owns all SQL)

```
- person: id, name, company, location, email, linkedin, birthday,
    how_we_met, next_action (one free-text line — the anti-snooze field),
    notes, cadence (none|weekly|monthly|quarterly|biannual, default none),
    next_due_override (date, nullable; set by skip-cycle, cleared by any new
    interaction), archived (0/1), created_at
- interaction: id, person_id, date, note (one-liner), source (desktop|phone),
    created_at            # append-only; last_contact = MAX(date) per person
- bucket: id, name, active (0/1)          # user-defined interest groups
- person_bucket: person_id, bucket_id     # multi-select
- crm_night: date UNIQUE, satisfied_at, kind (entries|nothing)
```

`last_contact` is always computed, never stored. `next_due =
next_due_override ?? (last_contact + cadence interval)`; people with
cadence=none never appear due.

## Nightly ritual & enforcement (the externalization)

- Scanning the **sleep QR opens a 30-minute fill window** (window = scan time
  + 30 min). The Worker knows the scan time; the app learns it by polling the
  Worker in the evening (existing outcomes-fetch pattern).
- **Desktop (primary):** the People tab is READ-ONLY outside the window
  (browse/search/filter always work). Inside the window, a "start nightly
  fill" button begins the session: a visible countdown from 10:00, a
  session composer (person autocomplete → dated one-liner, repeat; mini
  new-person form: name + buckets + optional fields), and a
  "nothing tonight" button. At 0:00 the session hard-locks: everything
  saves, editing disables until the next window. One session per night.
- **Phone (fallback/away):** the Worker page (below) can add entries or tap
  "no new entries today" — same satisfaction rules.
- **Satisfied** = ≥1 new interaction OR new person OR explicit
  "nothing tonight", from either surface, inside the window. Writes
  crm_night; app pushes the event to the Worker (pattern:
  `/internal/todo-submitted`).
- **Worker records a separate `crm` outcome per date** (satisfied/missed at
  window close). The sleep QR's own outcome is untouched — the scan is what
  OPENS the window, it is never gated on the fill.

## Phone surface (Worker page, e.g. /people)

- **Auth:** passphrase → HMAC-signed long-lived cookie. Constant-time
  compare; passphrase stored only as a hash Worker-side; global
  attempt-lockout counter in KV (~10 failures total → 1 hour lock; being
  locked out of the cloud mirror is acceptable — local data unaffected).
  A leaked URL alone yields nothing. (A short PIN does NOT survive online
  brute force on a Worker; the passphrase is load-bearing.)
- **After auth:** due-list (names + next_action), name autocomplete,
  per-person history view (read past notes to recontextualize — this read
  access is a core feature, not a convenience), add-entry form, minimal
  new-person form, "no new entries today" button.
- **Sync:** app PUSHES a people+interactions snapshot to Worker KV on change
  / session end (pattern: `/internal/todo-content`); phone APPENDS to a
  capture blob; app pulls + merges on open/sync (pattern:
  `/internal/inbox-content`). Phone is read + append only — structural edits
  (rename, buckets, delete, cadence) are desktop-only, so conflicts are
  impossible by construction. Plaintext at rest in KV matches the existing
  /todo baseline; client-side encryption is future hardening, out of v1.

## Desktop UI (People tab)

- New sidebar tab "People". Grid: Tabulator 6.x (pin the version — 6.x had
  edit/range keyboard-nav conflicts since fixed), dark-theme via CSS-var
  overrides, fixed-height container.
- Columns: name, buckets (chips + dropdown editor), company, location, email,
  linkedin, birthday, how_we_met, cadence, last_contact (computed, sortable),
  next_action. Row click → detail panel: notes + full dated interaction log.
- Due strip on top: max 5 people with next_due ≤ today, each with
  next_action shown and a one-tap **"skip this cycle"** (sets
  next_due_override += one cadence interval; no red anywhere, no overdue
  counts — anti-guilt-aquarium).
- Bucket manager (create/rename/retire) inside the tab.
- Read-only state and the 10:00 countdown must be visually obvious.

## API sketch (app.py stays thin)

```
GET/POST/PATCH /api/people, POST /api/people/<id>/interactions,
GET/POST /api/buckets, POST /api/people/night   (entries|nothing)
GET /api/people/window    (window open? seconds left — from Worker scan poll)
```
Worker: snapshot push route, capture blob read/write, `crm` outcome
recording, /people page + passphrase auth. All internal routes gated on the
existing qr_internal_secret pattern; all sync no-ops without config.json.

## Build sequence

1. **A — local core:** schema, storage fns, Flask routes, People tab grid +
   buckets + interaction log + due strip. No enforcement yet (always
   editable) so the surface is testable.
2. **B — ritual:** window polling, read-only-outside-window, session mode +
   10-min hard lock, crm_night, "nothing tonight".
3. **C — cloud:** Worker snapshot/capture/outcome routes, phone page,
   passphrase gate + lockout, app-side sync threads.
4. **Later (not v1):** client-side encryption, CSV import, NOW-panel
   surfacing of the window, birthday reminders.

## Guardrails

- Starts empty; no bulk import path in v1.
- Blank fields are always legal; only `name` is required.
- Cadence is per-person and optional; skip-cycle is one tap and silent.
- The 10-minute cap is HARD (save + lock, no snooze). Editing outside the
  window is impossible on desktop, structural edits impossible on phone.
- Phone page never exposes an edit/delete path for existing notes.
- Verify per repo convention: headless Flask + Playwright drives (see
  .claude/skills/verify/SKILL.md); worktree + seeded throwaway db if the app
  is running.
