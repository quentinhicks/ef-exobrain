#!/usr/bin/env bash
# Pull code from GitHub and restart the service when the CODE changed.
# Driven by productivity-update.timer; safe to run by hand.
#
# The server makes its OWN commits (logs/ on every logs sync, backups/ once a
# day) and pushes them, so this script shares a repo with a live writer. Two
# consequences shape it: the working tree is often dirty with data writes, and
# a data commit coming back around from GitHub must NOT restart Flask, or
# every phone log edit bounces the app.
set -uo pipefail

APP_DIR="${APP_DIR:-$HOME/productivity-app}"
cd "$APP_DIR" || exit 0

# app.py's _git_push_paths runs git in this same repo. Git's own index.lock
# would make one of us fail; the lock keeps us from being the one that does,
# and a skipped run just waits for the next timer tick.
exec 9>"$HOME/.qpa-update.lock"
flock -n 9 || exit 0

OLD=$(git rev-parse HEAD)
git fetch --quiet origin main || exit 0
[ "$OLD" = "$(git rev-parse origin/main)" ] && exit 0

# --autostash because the tree usually carries uncommitted logs/ or backups/
# writes. If the rebase still can't land, leave the tree exactly as it was and
# let the next tick retry rather than resolving anything unattended.
if ! git pull --rebase --autostash --quiet origin main; then
  git rebase --abort 2>/dev/null
  echo "qpa-update: rebase failed, tree left alone" >&2
  exit 1
fi

NEW=$(git rev-parse HEAD)
if git diff --name-only "$OLD" "$NEW" -- '*.py' static templates deploy | grep -q .; then
  echo "qpa-update: code changed ${OLD:0:7}..${NEW:0:7} — restarting"
  sudo -n systemctl restart productivity
else
  echo "qpa-update: data-only change ${OLD:0:7}..${NEW:0:7} — no restart"
fi
