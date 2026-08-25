# Deploying to an Oracle Always Free VM (behind Tailscale)

The backend moves to an always-on VM; the phone and laptops become clients.
Nothing is exposed to the public internet — every device talks over the
tailnet. The VM's tracker.db is the single source of truth (the Drive-synced
laptop copies retire, and with them the never-run-both-machines rule).

## Launch modes (app.py)

| Mode | Command | What runs |
|---|---|---|
| Local all-in-one | `python app.py` | Flask + db + windows + hotkeys (unchanged — but a SEPARATE db, so not an offline fallback; see Known limits) |
| Server | `PT_HEADLESS=1 python app.py` | Flask on 0.0.0.0:5000 only — no windows, no hotkeys, no pywebview needed |
| Client | `PT_SERVER=http://<vm>:5000 python app.py` | The two windows pointed at the VM + the hotkey bridge on 127.0.0.1:5000 — no local Flask or db |

The client bridge keeps every global hotkey working unchanged: panel marks
(⌃⌥S/X/M) are handled against the local windows, and inbox capture/view
(⌃⌥I/O via inbox_cli.py) is proxied to the VM.

## One-time setup

### 1. Accounts (~30 min)
- Oracle Cloud: sign up at oracle.com/cloud/free (card required for identity,
  not charged). The home region is PERMANENT for Always Free — pick a nearby
  one with capacity. Optionally upgrade to Pay-As-You-Go afterwards (still $0
  within free limits) to be exempt from idle-instance reclamation.
- Tailscale: free personal account; install the app on the iPhone and Mac.

### 2. VM (~20 min)
- Compute → Create Instance: Ubuntu 24.04, shape VM.Standard.E2.1.Micro
  (plenty; or A1.Flex at 1 OCPU / 6 GB — stay well under the free cap, Oracle
  halved it once already). Add your SSH public key. Note the public IP.
- `ssh ubuntu@<public-ip>`
- `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
  → approve the login URL. Note the tailnet name (`tailscale status`).
- Do NOT open port 5000 in the OCI security list — Tailscale is the only door.

### 3. Repo access
- The server only READS the repo, so a public clone over HTTPS needs nothing.
- For a private repo: `ssh-keygen -t ed25519` on the VM and add the pubkey as a
  READ-ONLY deploy key. Write access is no longer needed — since 2026-08-08 the
  server makes no commits (backups go to Object Storage via restic).

### 4. Deploy
```
scp deploy/server-setup.sh ubuntu@<vm>:
ssh ubuntu@<vm> 'bash server-setup.sh git@github.com:<you>/ef-exobrain.git'
```

### 4b. Timezone (or events shift)
The server computes the engage day in ITS local time. server-setup.sh sets
America/Los_Angeles (override with QPA_TZ=… when running it); confirm with
`timedatectl` after any rebuild.

### 5. Migrate the data (over the tailnet, from the Mac)
```
scp tracker.db config.json ubuntu@<vm-tailscale-name>:productivity-app/
ssh ubuntu@<vm> 'sudo systemctl restart productivity'
```
After this, stop running local all-in-one mode on the laptops for real work —
the VM owns the db now. (Local mode still works for offline emergencies; just
know it's a separate database from that moment.)

### 5b. HTTPS on the tailnet (required for offline on the phone)
The service worker that makes the app work offline can only register in a
SECURE CONTEXT. `http://<name>:5000` is not one (only https and localhost
are), so over plain http the whole offline layer is a silent no-op. Tailscale
issues a real Let's Encrypt cert for the MagicDNS name, with nothing exposed
publicly — `serve` is tailnet-only (`funnel` is the public one; don't):

```
tailscale serve --bg http://127.0.0.1:5000     # on the VM
```

First run prints a `login.tailscale.com/f/serve?node=…` link and BLOCKS until
you click it (Serve is off by default per-tailnet) — that is not a hang. The
first https request then takes ~15s while the cert is provisioned, and is fast
after. Confirm with `tailscale serve status` and
`curl https://<name>.<tailnet>.ts.net/`. Port 5000 keeps working alongside it,
so the laptop's PT_SERVER clients need no change.

### 6. Point the devices
- iPhone: Tailscale app connected → Safari → `https://<vm-tailscale-name>.<tailnet>.ts.net`
  → share → Add to Home Screen. Use the **https** URL, not `:5000`, or you get
  no offline mode. Installing also matters beyond convenience: Safari evicts
  script-writable storage (service worker + caches) after 7 unused days for
  ordinary sites, and Home Screen web apps are exempt.
- Mac: `PT_SERVER=http://<vm-tailscale-name>:5000 ~/venvs/qpa/bin/python app.py`
- Windows: same, `set PT_SERVER=... && pythonw app.py` (update the shortcut).

### 6b. Siri voice capture (iPhone Shortcut — no app code)

"Hey Siri, add to inbox" → dictate → lands in the inbox. The tailnet is the
auth boundary (serve is tailnet-only), so this is just a POST to the existing
endpoint — no token, no new route; do NOT add one (see CLAUDE.md's future
direction: no auth until explicitly scoped).

Shortcuts app → + → name the shortcut **Add to inbox** (the name IS the Siri
phrase) → actions:

1. **Dictate Text**
2. **Get Contents of URL** —
   URL `https://<vm-tailscale-name>.<tailnet>.ts.net/api/inbox`, Method POST,
   Request Body JSON with ONE field: key `content`, value = the Dictated Text
   variable. (The key is `content`, not `text` — anything else 500s.)
3. *(optional)* **Show Notification** with the URL result, as the receipt.

First run asks to allow running while locked and to allow the network call —
allow both. Needs the Tailscale VPN up on the phone (same requirement as the
Home Screen app itself); if the toggle keeps getting dropped, turn on the
Tailscale app's on-demand/always-on VPN setting. A capture made this way shows
up in the Clarify count like any other; there is deliberately NO offline
queue here (mutations fail loudly, per the Offline section's tier-1 rule).

## Code updates — automatic
`productivity-update.timer` runs `deploy/auto-update.sh` every 5 minutes: it
fetches origin/main, rebases (`--autostash`, because the tree usually carries
uncommitted logs/ or backups/ writes), and restarts the service ONLY when a
tracked code path changed (`*.py`, `static`, `templates`, `deploy`). A `git
push` from a laptop is therefore live on the VM within ~5 min with nothing to
run by hand.

The path test still matters, but only to avoid bouncing Flask for a docs- or
spec-only commit. It used to matter far more: the server itself committed
`logs/` on every sync and `backups/` daily, and those came back around through
GitHub, so without the test a phone log edit restarted the app.

**It restarts BOTH services**, `productivity` then `qpa-scan`. For a long time
it restarted only the first, and `qr_scan_server.py` is a separate long-lived
process — so every fix to the PUBLIC scan and tap routes landed on the VM's
disk and never reached the running process until someone bounced it by hand.
Nothing said so; it was found the day a scan-server change was supposed to
show up in the app and did not. Order matters: `productivity` is what runs
`storage.init_db()`, so a schema the new scan-server code expects exists
before that code serves a request.

The timer runs as `ubuntu` and holds exactly two sudo rights, from
`/etc/sudoers.d/qpa-update`: `systemctl restart productivity` and
`systemctl restart qpa-scan`. An existing VM needs that file updated by hand
once — `deploy/server-setup.sh` writes both lines for a fresh one.

```
systemctl list-timers productivity-update.timer   # when it next fires
journalctl -u productivity-update -n 20           # what it did
sudo systemctl start productivity-update          # force a check now
```

A rebase that can't land aborts and leaves the tree untouched, retrying on the
next tick — conflicts are never resolved unattended. If it stays stuck,
`journalctl -u productivity-update` says so; fix it by hand over SSH.

## Verify
- `systemctl status productivity` green; `sudo reboot` → the phone loads again
  without touching anything (systemd + tailscaled come back on their own).
- `systemctl list-timers qpa-backup.timer` shows the next run, and
  `restic snapshots` lists them — that is what makes the VM disposable
  (reclaimed instance = re-run steps 2–5, `restic restore latest`, nothing
  lost). Verify with a real restore, not just a snapshot listing.

## Known limits
- Phone needs the Tailscale app connected (it's a VPN profile; iOS keeps it
  up on demand) — but NOT for an offline load: the service worker answers the
  navigation before DNS is consulted.
- Offline is READ-only (see CLAUDE.md's Offline section). Writes with no
  network fail rather than queue; a write outbox is unbuilt tier 2.
- The laptop in client mode has no offline mode at all: `base = PT_SERVER`, so
  both windows load their HTML off the VM and there is nothing to fall back to.
  The candidate fix is to pull a tracker.db snapshot while online and let the
  existing local Flask serve it read-only — the client bridge is already a
  proxy on the port the windows could load from (it needs do_PATCH/do_DELETE,
  which it lacks today). Unbuilt.
- The Engage QR layer still talks to the Cloudflare Worker exactly as before
  (config.json rode along to the VM).
- /api/panel/saved nudges are lost in client mode (the panel posts to the VM,
  which has no window) — the day view catches up on the next interaction.
