# ef-exobrain

A single-user GTD system: a phone-sized task manager, a day timeline, an
always-on-top "what am I doing right now" panel, and a location-verified
accountability layer running on Cloudflare Workers.

Flask + SQLite + vanilla JS. No framework, no build step.

> **Status:** this is a public mirror of a personal project that has been in
> daily use since mid-2026. Personal data (logs, journals, the database) lives
> only in the private repo.

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.json     # every key is optional
python app.py
```

`tracker.db` is created on first run. Every external integration (Google
Calendar, Sheets, the QR worker) fails soft when unconfigured, so the app boots
and runs with an empty `config.json`.

## Launch modes

| Mode | Command | What runs |
|---|---|---|
| Local all-in-one | `python app.py` | Flask + SQLite + desktop windows |
| Server | `PT_HEADLESS=1 python app.py` | Flask on `0.0.0.0:5000`, no windows |
| Client | `PT_SERVER=http://<host>:5000 python app.py` | Desktop windows pointed at a remote server |

The deployed shape is a small always-on VM running the server, with laptops and
a phone as clients over a private network. See [`deploy/ORACLE.md`](deploy/ORACLE.md).

## Architecture

```
app.py          Flask routes only — thin, no business logic
storage.py      ALL SQL. No SQL exists anywhere else.
aggregator.py   external fetches only (iCal, Google Sheets)
static/app.js   all state, rendering and fetching for the main window
static/panel.js the same, for the "NOW" panel — touches no app.js state
static/sw.js    service worker: offline reads of the current day
QR-accountability/  Cloudflare Worker: scan windows, geofencing, judgment
```

Those boundaries are enforced by convention and held to strictly — the
separation is the reason a codebase this size stays workable without a
framework.

## Design notes

The interesting parts are less about the stack than the constraints:

- **One inventory, three lenses.** Every task row carries clarification
  (*what is it*), structure (*where does it belong*), and state (*is it
  available*). Three surfaces read that one table, and each owns exactly one
  write class. The rule that keeps them from collapsing into each other: the
  surface you glance at ~30×/day may never write *position*.

- **Friction belongs at the boundary.** A 3-second decision costs ~10 min/week
  on a surface visited 210×/week, and 3 seconds on one visited weekly — about
  200×. So the weekly surface is allowed to be dense and the daily one is not.
  That ratio is the test applied to every new control.

- **Every data-changing action ships with its inverse.** A handler that mutates
  without registering an undo is considered unfinished. Deletes snapshot their
  row, children, and scheduling placements, and restore re-inserts the
  *original* ids so that references survive.

- **Offline is reads-only, on purpose.** The service worker is network-first and
  never intercepts mutations, so a write with no connection fails loudly rather
  than appearing to succeed. Two-way sync was considered and rejected.

- **Counts are never silently truncated.** A hidden item is always counted
  somewhere visible, because trust in the numbers is multiplicative across
  hundreds of glances a week.

## Layout

- `spec.md` and the `spec-*.md` files — feature specs
- `DEVLOG.md` — build log
- `deploy/` — VM deployment (systemd units, setup script, auto-update timer)
- `inbox-hotkey/` — global capture hotkeys (AutoHotkey on Windows, Hammerspoon on macOS)
- `QR-accountability/` — the Cloudflare Worker and its spec
