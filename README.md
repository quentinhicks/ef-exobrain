# Executive function exobrain

Software that provides freedom through giving you control of the future. NOTE: Built for personal use, but open source for inspiration.

## What's the problem?

> Lacking self-control robs you of free will
>
> — Russell Barkley, expert on Adult ADHD

ADHD is commonly understood as a deficit of executive function, which is one's ability to plan, focus, and self-regulate. From 1997 to 2016, the prevalence of ADHD (Attention-Deficit Hyperactivity Disorder) has increased from 6.1% to 10.2% according to [national population surveys](https://pmc.ncbi.nlm.nih.gov/articles/PMC9616454/). The reasons for this increase is unclear, but the fact is that increasing numbers of people have trouble self-regulating: a fact which almost certainly is related to the amount of time tech companies spend optimizing addicting social media algorithms. **We need to develop systems that allow us to be able to regain control over systems that take our attention away from us.**

## What's the solution?

> Humankind cannot gain anything without first giving something in return. To obtain, something of equal value must be lost. That is Alchemy's first law of Equivalent Exchange
> — Alphonse Elric, protagonist of Fullmetal Alchemist: Brotherhood

The ef-exobrain software is a piece of personal management software (similar to to-do lists, calendars, etc.) that takes a radical view towards treating executive dysfunction: instead of treating it as our responsibility to internally self-regulate in a world that unfairly increasingly demands our attention, we should be able to fight back by making our obligations _as clear as possible at every point in time_.

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

There are more many more features not mentioned here, but they enhance these key components as opposed to adding to it. In addition, your instance of the app can be accessible on all platforms via web URL.

This is a productivity workflow largely derived from Getting Things Done by David Allen. Read a summary about it in [GTD in 15 minutes - A Pragmatic Guide to Getting Things Done](https://hamberg.no/gtd). This system takes mostly from Allen's workflow, but we incorporate his emphasis on flexibility with the ability for users to determine their own level of self-imposed structuring:
* By introducing user configurable gates and monetary enforced deadlines, we acknowledge that external stakes are an important aspect of self-regulation.
* By introducing user configurable time blocking, we emphasize that the ability to structure ones time in weekly time blocks allows the user to portion their time appropriately.

## How is this done?

One always-on host, three systemd units, two network surfaces.

| Component | Stack | Role |
|---|---|---|
| Application | Python 3.12, Flask, SQLite | JSON API, business logic, data |
| Scan endpoint | Python 3.12, Flask | Serves Gate URLs, records scans |
| Gate judge | Python 3.12, systemd timer | Evaluates Gate windows at close |
| Host | Oracle Cloud VM (Always Free) | Runs all three under systemd |
| Network | Tailscale tailnet, plus Funnel for scans | Transport, access control |

### Application

Flask serves JSON, plus two static HTML shells: the main window and an always-on-top "NOW" panel. All rendering, state and fetching is vanilla JavaScript — no framework, no build step. `app.py` contains routes only; all SQL is in `storage.py`; external fetches (iCal, Google Sheets) are in `aggregator.py`.

One SQLite file holds everything, including Gate configuration and outcomes. The VM's copy is the single source of truth; every device is a client of the same instance.

Three launch modes:

| Mode | Command |
|---|---|
| All-in-one | `python app.py` |
| Server | `PT_HEADLESS=1 python app.py` |
| Desktop client against a remote server | `PT_SERVER=http://<host>:5000 python app.py` |

`PT_DATA_DIR` sets the working directory the app reads and writes data in — `config.json`, `tracker.db`, `logs/`, `backups/`. Unset, it is the current directory. The repository holds no data.

A service worker caches the app shell and `GET /api/*` responses network-first, falling back to cache only when a fetch fails. Mutations are not intercepted and not queued. Registration requires a secure context, which `tailscale serve` provides.

Data is backed up every 6 hours by restic to S3-compatible object storage, encrypted client-side, with a `gpg`-encrypted tarball of the database, logs and config written alongside it.

### Gates

A Gate is a record holding a label, an opaque token, a daily window (`window_start`, `window_end`, and an offset flag for windows closing after midnight), an optional geofence (latitude, longitude, radius), the weekdays it applies on, and optional per-weekday window overrides.

Scanning an NFC tag opens `GET /scan/<token>`, which returns a page that requests the browser's location and posts it to the same URL. The endpoint computes the haversine distance to the geofence centre, records a scan row with a pass/fail flag, and returns the outcome as text. Timestamps are stored in UTC.

The judge runs every 5 minutes. For each active Gate it evaluates yesterday's and today's windows, skipping weekdays the Gate does not apply on and windows that have not closed. Window times resolve as: date override, then per-weekday window, then Gate defaults. A window is satisfied by any scan inside it that passes the geofence, where one is set. Unsatisfied windows are recorded as failures; satisfied windows are not recorded, and are recomputed from scan rows on read.

Configuration changes are applied on two schedules. Tightening applies immediately. Loosening is queued and applied 24 hours later: a later start, an earlier end, a wider geofence radius, a dropped weekday, a reduced end-offset, or any weekday whose effective window loosens. Deactivating a Gate is queued with the same delay; reactivating cancels a queued deactivation but does not revive a Gate that has already gone inactive, and an active Gate cannot be deleted. A given day is locked once its deadline is within 24 hours: overrides for that day cannot be created, modified or removed.

### Network

The application listens on port 5000. The host's iptables INPUT chain accepts the `tailscale0` interface, loopback, established connections and port 22, and rejects everything else, so the application is reachable only from inside the tailnet. `tailscale serve` provides TLS on port 443 of the tailnet address.

The scan endpoint listens on `127.0.0.1:5001` and is published on port 8443 by Tailscale Funnel, which terminates TLS. It serves `GET`/`POST /scan/<token>` and `GET /health`; every other path returns 404. It runs as a separate process and unit from the application, under `ProtectSystem=strict`, `ProtectHome=read-only`, and a single writable path.

No port is opened in the OCI security list or in local iptables. The host has no public listener; the only public ingress is Tailscale's, on 8443.

The application has no authentication. Tailnet membership is the access control. A scan is unauthenticated; the token in the Gate URL is the credential.

### Stakes

Gate outcomes drive the pass/fail marking on the day view. The monetary path — a [Beeminder](https://www.beeminder.com/overview) charge on a failed Gate — is implemented but disabled, and is not reachable from the current judge.

Setup: [`deploy/ORACLE.md`](deploy/ORACLE.md). Gate operations: [`QR-accountability/RUNBOOK.md`](QR-accountability/RUNBOOK.md). Backups: [`deploy/BACKUPS.md`](deploy/BACKUPS.md).
