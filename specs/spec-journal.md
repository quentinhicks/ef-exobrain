# Journal — spec addendum

**Extends:** `spec.md`. **Touches:** tracker.db schema, Flask routes, a new
sidebar tab, the weekly-review form, and the QR-accountability Worker
(`QR-accountability/`). **Posture:** additive. All CLAUDE.md architecture rules
and coding constraints apply. This supersedes the "No habit tracking" non-feature
line in spec.md — habit tracking is now in scope, in the narrow form below.

## Purpose / frame

A nightly journal, filled on the phone as part of the sleep-QR check-in, and
reviewed on the desktop as a spreadsheet-style dashboard. Two things per day plus
one habit per week:

- **Daily row** (keyed by date): `biggest bottleneck`, `active experiment`,
  `rating` (1–7). Bottleneck + experiment are written the night BEFORE (they land
  on the next day's row); the rating is given the night OF (it rates that day's
  active experiment).
- **Weekly habit**: one habit, set when the weekly review is filed; it runs from
  that week's start until the next review, and is rated every day as
  `Ehh` / `Good` / `Great`.

Blanks are always legal (same anti-guilt posture as the People CRM) — nothing is
required, nothing turns red.

## Where it lives

- **Fill surface = the sleep-QR scan page.** Scanning the sleep QR records the
  scan (accountability, unchanged), then hands off to `/journal` on the Worker —
  a passphrase-gated phone form. There is no desktop fill surface; entry is a
  phone ritual bound to the sleep scan.
- **Dashboard = a "Journal" sidebar tab** in the desktop app: a Tabulator grid
  (Date · Biggest bottleneck · Active experiment · Rating · Habit), newest first,
  with the current week's habit in a header. Cells are directly editable.

## Data model

### Local (storage.py owns all SQL)

```
- journal_day: date (PK), bottleneck, active_experiment,
    rating (1–7, nullable), habit_mark (ehh|good|great, nullable), updated_at
- habit_week: week_start_date (PK), habit, created_at
```

`habit in force on a date` = the most recent `habit_week` with
`week_start_date <= date`. The desktop mirror is kept in sync with the Worker by
last-write-wins on `updated_at`.

### Worker D1 (lazy-migrated, `ensureJournalTables`)

```
- journal_entry: date (PK), bottleneck, active_experiment, rating, habit_mark, updated_at
- journal_config: id=1, node_id, habit, habit_week_start, updated_at   (app-pushed)
```

## Flow

1. **Weekly review** (desktop) gains a "Habit for the coming week" field. Filing
   the review writes `habit_week` for that week_start_date and pushes the current
   habit + sleep node id to the Worker (`/internal/journal-config`).
2. **Sleep-QR scan** (phone): the scan POST records the scan; because the scanned
   node matches `journal_config.node_id`, the page redirects to `/journal?from=scan`.
3. **`/journal`** (phone, passphrase-gated — reuses the People passphrase +
   session cookie + lockout, one shared "phone passphrase"):
   - Rate today (1–7) + mark today's habit (Ehh/Good/Great), with today's
     experiment shown as context.
   - Set tomorrow's bottleneck + active experiment.
   - Save writes `journal_entry`: today's row takes rating + habit_mark (leaving
     last night's bottleneck/experiment intact); tomorrow's row takes the
     bottleneck + experiment.
4. **Desktop Journal tab** pulls `journal_entry` rows on open
   (`POST /api/journal/sync` → `/internal/journal-entries`), merges LWW into
   `journal_day`, and renders. Cell edits PATCH locally and push back to the Worker.

## API sketch (app.py stays thin)

```
GET   /api/journal            -> { days, habit, habits }
POST  /api/journal/sync       -> pull+merge from Worker, then { days, habit, habits }
PATCH /api/journal/<date>     -> upsert one cell, push to Worker
POST  /api/weekly-reviews     -> (existing) + optional `habit` -> habit_week + config push
```

Worker: `/internal/journal-config` (POST), `/internal/journal-entries` (GET/POST),
`/journal` (GET/POST). Internal routes gated on the existing `qr_internal_secret`
pattern; all sync no-ops without config.json. `/journal` requires the People
passphrase secrets (`PEOPLE_PASS_HASH` / `PEOPLE_SALT` / `PEOPLE_COOKIE_SECRET`).

## Guardrails

- All fields nullable; nothing required; no overdue/red states.
- The rating CHECK (1–7) and habit_mark CHECK (ehh/good/great) are DB-level
  backstops; app.py validates before writing.
- Scan accountability is untouched — the journal is a redirect AFTER the scan
  POST completes, never a gate on it.
- The scan→journal redirect only fires when `qr_sleep_node_id` is set (the same
  setting that drives the timeline wake/sleep clip); the app pushes it on launch.
