# Executive function exobrain

Software that provides freedom through giving you control of the future. NOTE: Built for personal use, but open source for inspiration.

## What's the problem?

> Lacking self-control robs you of free will
>
> — Russell Barkley, expert on Adult ADHD

ADHD is commonly understood as a deficit of executive function, which is one's ability to plan, focus, and self-regulate. From 1997 to 2016, the prevalence of ADHD (Attention-Deficit Hyperactivity Disorder) has increased from 6.1% to 10.2% according to [national population surveys](https://pmc.ncbi.nlm.nih.gov/articles/PMC9616454/). The reasons for this increase is unclear, but the fact is that increasing numbers of people have trouble self-regulating: a fact which almost certainly is related to the amount of time tech companies spend optimizing addicting social media algorithms.

We need to develop systems that allow us to be able to regain control over systems that take our attention away from us.

## What's the solution?

> Humankind cannot gain anything without first giving something in return. To obtain, something of equal value must be lost. That is Alchemy's first law of Equivalent Exchange
>
> — Alphonse Elric, protagonist of Fullmetal Alchemist: Brotherhood

The ef-exobrain software is a piece of personal management software (similar to to-do lists, calendars, etc.) that takes a radical view towards treating executive dysfunction: instead of treating it as our responsibility to internally self-regulate in a world that unfairly increasingly demands our attention, we should be able to fight back by making our obligations as clear as possible at every point in time.

The main principle of this software: everything that one needs to know should be accessible on one view, accessible from any platform. On the main view, we have the following sections:

* **Calendar:** For all timed related tasks and activities. Three different types of calendar data types:
  * **Events**: Specific scheduled events of time on a given day. Created from the events from a Google Calendar API.
  * **Blocks**: Larger recurring blocks of time scheduled out on a weekly basis. Can overlap with events, but these are mainly for time blocking purposes.
  * **Gates**: Location gated endpoints which verifies your location at a specific point in time.
    * Integrate [NFC tags](https://www.neural-revolution.com/post/adhd-brain-hacks-nfc-tags) to serve a unique URL specified by the app to verify you are exactly where the tag is
    * Can be connected to commitment contract software such as [Beeminder](https://www.beeminder.com/overview) to provide an accountability mechanism
* **Next actions list:** A lists of next actions, sorted by a context menu
  * **Context menu:** Specify what specific context you're in (On PC, work/personal, length of task) in a few clicks and then you can see the
  * **Action items:** These are specific, physical tasks which you can add context tags to. There is more on this, which I will touch on later.
* **Capture:** There is a capture bar at the bottom of the screen for any thought that you feel like you need to write down without getting distracted on your current task.

There are more many more features not mentioned here, but they enhance these key components as opposed to adding to it.

In addition, your instance of the app can be accessible on all platforms via web URL.

This is a productivity workflow largely derived from Getting Things Done by David Allen. Read a summary about it in [GTD in 15 minutes - A Pragmatic Guide to Getting Things Done](https://hamberg.no/gtd). This system takes mostly from Allen's workflow, but we incorporate his emphasis on flexibility with the ability for users to determine their own level of self-imposed structuring:

* By introducing user configurable gates and monetary enforced deadlines, we acknowledge that external stakes are an important aspect of self-regulation.
* By introducing user configurable time blocking, we emphasize that the ability to structure ones time in weekly time blocks allows the user to portion their time appropriately.

## How is this done?

One always-on host, three systemd units, two network surfaces.

| Component | Stack | Role |
|---|---|---|
| Application | Python 3.12, Flask, SQLite | JSON API, all business logic and data |
| Scan endpoint | Python 3.12, Flask | Serves the Gate URLs and records scans |
| Gate judge | Python 3.12, systemd timer | Evaluates each Gate window when it closes |
| Host | Oracle Cloud VM (Always Free) | Runs all three under systemd |
| Network | Tailscale — private tailnet, plus Funnel for scans | Transport and access control |

**Application.** Flask serves JSON plus two static HTML shells; all rendering and state is vanilla JavaScript with no framework and no build step. One SQLite file holds everything, including Gate config and outcomes. The VM's copy is the single source of truth — every device is a client of the same instance. Run it three ways: `python app.py` (all-in-one), `PT_HEADLESS=1` (server), `PT_SERVER=<host>` (desktop client against a remote server).

A service worker caches the shell and API responses network-first, so the day stays readable offline. Writes are not queued — an offline write fails visibly rather than appearing to succeed.

**Gates.** A Gate is a URL behind an NFC tag. Scanning it opens a page that captures your location and posts it; the judge later decides whether the window was satisfied. Judgment is presence-only: a satisfying scan inside the window, geofence-passing where a geofence is set.

Weakening a Gate is **rate-limited by design**, which is the mechanism that makes it an accountability device rather than a preference. Tightening a window applies immediately; *loosening* one — a later start, an earlier end, a wider geofence, a dropped weekday — waits 24 hours, by which time the window you were trying to dodge has already passed. A day's Gate locks entirely once its deadline is within 24 hours, including the removal of an override that made that day harder.

**Network, and why the split matters.** The application has **no login screen** — tailnet membership *is* the access control. That makes it critical that the public scan surface cannot reach it, so the scan endpoint is a **separate process on a separate port**, not a path on the same server:

- The application is reachable only inside a [Tailscale](https://tailscale.com) tailnet. `tailscale serve` provides TLS on port 443, which the service worker requires in order to register.
- The scan endpoint binds `127.0.0.1` and is published on port **8443** by Tailscale Funnel, which terminates TLS. It defines two routes and cannot serve an application route at all.
- **No port is opened on the host.** There is no change to the OCI security list and none to local iptables, whose INPUT chain still ends in `REJECT`; the VM has zero public listeners. Nothing needs a registered domain or a certificate of its own.

Port separation is deliberate over path filtering: a path rule in front of an unauthenticated API is one typo away from publishing everything, whereas a separate process has no such route to mis-serve.

**Stakes.** Gate outcomes are recorded and drive the ✓/✗ on the day view. The monetary path — [Beeminder](https://www.beeminder.com/overview) charges on a failed Gate — is implemented but **currently disabled**, and re-enabling it is a deliberate staged protocol rather than a config flag. See [`QR-accountability/RE-ENABLE.md`](QR-accountability/RE-ENABLE.md) for why.

Setup is documented in [`deploy/ORACLE.md`](deploy/ORACLE.md); the Gate system's exposure model and operational notes are in [`QR-accountability/RUNBOOK.md`](QR-accountability/RUNBOOK.md).

## Running it yourself

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.json     # every key is optional
python app.py
```

`tracker.db` is created on first run. Every external integration (Google Calendar, Sheets, Gates) fails soft when unconfigured, so the app boots and runs against an empty config.

Code and data are separate: the repository holds no data, and `PT_DATA_DIR` points at the directory that does.

## Layout

```
app.py            Flask routes only — thin, no business logic
storage.py        ALL SQL. No SQL exists anywhere else.
aggregator.py     external fetches only (iCal, Google Sheets)
qr_judge.py       Gate window resolution, judgment, and the 24h gates
qr_scan_server.py the public scan endpoint — two routes, its own process
static/app.js     all state, rendering and fetching for the main window
static/panel.js   the same, for the always-on-top "NOW" panel
static/sw.js      service worker: offline reads of the current day
deploy/           systemd units, VM setup, encrypted backups
```

Those boundaries are held to strictly — the separation is the reason a codebase this size stays workable without a framework.

## Design notes

The interesting parts are less about the stack than the constraints:

- **One inventory, three lenses.** Every task row carries clarification (*what is it*), structure (*where does it belong*), and state (*is it available*). Three surfaces read that one table, and each owns exactly one write class. The rule that keeps them from collapsing into each other: the surface you glance at ~30×/day may never write *position*.

- **Friction belongs at the boundary.** A 3-second decision costs ~10 min/week on a surface visited 210×/week, and 3 seconds on one visited weekly — about 200×. So the weekly surface is allowed to be dense and the daily one is not. That ratio is the test applied to every new control.

- **Every data-changing action ships with its inverse.** A handler that mutates without registering an undo is considered unfinished. Deletes snapshot their row, children, and scheduling placements, and restore re-inserts the *original* ids so references survive.

- **Counts are never silently truncated.** A hidden item is always counted somewhere visible, because trust in the numbers is multiplicative across hundreds of glances a week.

- **Durability is not version control.** Data lives outside the repository and is backed up by [restic](https://restic.net) — encrypted client-side, offsite, versioned — alongside a plain `gpg`-encrypted tarball that restores with `gpg -d | tar xz`. Logs are markdown and the database is SQLite, so a recovered archive stays readable with a text editor even without this software. See [`deploy/BACKUPS.md`](deploy/BACKUPS.md).
