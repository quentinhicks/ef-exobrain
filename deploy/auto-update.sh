#!/usr/bin/env bash
# Pull code from GitHub and restart the service when the CODE changed.
# Driven by productivity-update.timer; safe to run by hand.
#
# The repo holds ONLY code (2026-08-08): data lives in PT_DATA_DIR, outside
# the tree, and nothing in app.py runs git. So the working tree is always
# clean here and this script is the repo's only writer — which is why the
# lock and the autostash below are now belt-and-braces rather than load-
# bearing. They used to be essential: the server committed logs/ on every
# sync and backups/ daily, into this same checkout.
set -uo pipefail

# The CODE dir. Data lives one level up (PT_DATA_DIR), outside the repo.
APP_DIR="${APP_DIR:-$HOME/qpa/ef-exobrain}"
cd "$APP_DIR" || exit 0

# Guards against two timer ticks overlapping on a slow fetch. A skipped run
# just waits for the next tick.
exec 9>"$HOME/.qpa-update.lock"
flock -n 9 || exit 0

OLD=$(git rev-parse HEAD)
git fetch --quiet origin main || exit 0
[ "$OLD" = "$(git rev-parse origin/main)" ] && exit 0

# --autostash is kept for the hand-edited-on-the-VM case. If the rebase still
# cannot land, leave the tree exactly as it was and let the next tick retry
# rather than resolving anything unattended.
if ! git pull --rebase --autostash --quiet origin main; then
  git rebase --abort 2>/dev/null
  echo "qpa-update: rebase failed, tree left alone" >&2
  exit 1
fi

NEW=$(git rev-parse HEAD)
if git diff --name-only "$OLD" "$NEW" -- '*.py' static templates deploy | grep -q .; then
  echo "qpa-update: code changed ${OLD:0:7}..${NEW:0:7} — restarting"
  # BOTH SERVICES. qpa-scan is a separate long-lived process running its own
  # copy of qr_scan_server.py, and for a long time nothing here restarted it:
  # every fix to the PUBLIC scan and tap routes reached the VM's disk and none
  # of them reached the running process, silently, until someone bounced it by
  # hand. It was found the first time a change there was supposed to be
  # visible in the app (the tap log, 2026-08-25) and simply was not.
  #
  # productivity FIRST, and not only for taste: it is the process that runs
  # storage.init_db(), so a schema the new scan-server code expects exists
  # before that code starts serving. qpa-scan never migrates anything — it is
  # internet-facing, and running migrations there is surface nobody needs.
  sudo -n systemctl restart productivity
  sudo -n systemctl restart qpa-scan
else
  # Docs/spec-only commits reach the VM too; no reason to bounce Flask.
  echo "qpa-update: no code change ${OLD:0:7}..${NEW:0:7} — no restart"
fi
