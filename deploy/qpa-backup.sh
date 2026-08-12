#!/usr/bin/env bash
# Encrypted offsite backup of the data plane: the database, the logs and
# config.json. restic encrypts client-side, so the remote (Oracle Object
# Storage over its S3-compatible API) only ever holds ciphertext.
#
# Config lives in ~/.config/qpa/backup.env — the repository URL, the S3
# credentials and the path to the encryption password. That file is the only
# machine-specific part; this script is the same everywhere.
#
# LOSING ~/.config/qpa/restic-password MAKES EVERY BACKUP UNREADABLE. It is
# escrowed in a password manager, not only here.
set -uo pipefail

# The DATA dir (PT_DATA_DIR), not the repo — tracker.db, logs/ and
# config.json live here and the code lives in APP_DIR/ef-exobrain.
APP_DIR="${APP_DIR:-$HOME/qpa}"
STAGE="${STAGE:-$HOME/.qpa-backup-stage}"
ESCAPE_DIR="${ESCAPE_DIR:-$HOME/qpa-escape}"
ESCAPE_KEEP="${ESCAPE_KEEP:-7}"
STATUS_FILE="${STATUS_FILE:-$HOME/.config/qpa/last-backup.json}"
ENV_FILE="${ENV_FILE:-$HOME/.config/qpa/backup.env}"

[ -f "$ENV_FILE" ] || { echo "qpa-backup: no $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
PASSFILE="${RESTIC_PASSWORD_FILE:-$HOME/.config/qpa/restic-password}"

write_status() {  # $1 = ok|fail, $2 = note
  mkdir -p "$(dirname "$STATUS_FILE")"
  printf '{"result":"%s","at":"%s","epoch":%s,"note":"%s"}\n' \
    "$1" "$(date -Is)" "$(date +%s)" "$2" > "$STATUS_FILE"
}

fail_out() {
  write_status fail "$1"
  echo "qpa-backup: FAILED — $1" >&2
  # Signal the dead-man's switch explicitly so silence and failure are
  # distinguishable: a missed ping means the host is gone, a /fail ping means
  # the host is alive and the backup is broken.
  [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}/fail" -o /dev/null 2>/dev/null
  exit 1
}

# The app writes to tracker.db continuously, and a plain file copy of a live
# SQLite database can land mid-transaction and restore corrupt. sqlite3's
# online backup API takes a consistent snapshot instead — the same call
# storage.backup_db() uses.
mkdir -p "$STAGE"
chmod 700 "$STAGE"
python3 - "$APP_DIR/tracker.db" "$STAGE/tracker.db" <<'PY' || fail_out "sqlite snapshot failed"
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dest = sqlite3.connect(sys.argv[2])
src.backup(dest)
dest.close(); src.close()
PY

TARGETS=("$STAGE/tracker.db")
[ -d "$APP_DIR/logs" ] && TARGETS+=("$APP_DIR/logs")
# daybook/ is the plain-text history — one markdown file per day, written by
# daybook.py. It is the copy that stays readable when neither restic nor this
# app is around, so it is backed up like the logs are.
[ -d "$APP_DIR/daybook" ] && TARGETS+=("$APP_DIR/daybook")
[ -f "$APP_DIR/config.json" ] && TARGETS+=("$APP_DIR/config.json")

# ── The escape hatch ────────────────────────────────────────────────────────
# restic protects against losing the data. This protects against losing
# RESTIC — a corrupt repo, a broken upgrade, or simply not having restic on
# whatever machine you are holding when you need your journals back.
#
# Plain tar.gz, GnuPG symmetric AES256, same passphrase as the repo so there is
# still only ONE secret to escrow. Recoverable with tools that predate this app
# by decades and will outlive it:  gpg -d x.tar.gz.gpg | tar xz
# Deliberately daily, not per-run: it is a fallback, not the primary.
TODAY=$(date +%F)
ARCHIVE="$ESCAPE_DIR/qpa-$TODAY.tar.gz.gpg"
if [ ! -f "$ARCHIVE" ]; then
  mkdir -p "$ESCAPE_DIR"; chmod 700 "$ESCAPE_DIR"
  ESCAPE_PATHS=(logs config.json)
  [ -d "$APP_DIR/daybook" ] && ESCAPE_PATHS+=(daybook)
  tar czf "$STAGE/escape.tar.gz" \
      -C "$STAGE" tracker.db \
      -C "$APP_DIR" "${ESCAPE_PATHS[@]}" 2>/dev/null
  gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
      --pinentry-mode loopback --passphrase-file "$PASSFILE" \
      -o "$ARCHIVE" "$STAGE/escape.tar.gz" || fail_out "gpg archive failed"
  rm -f "$STAGE/escape.tar.gz"
  chmod 600 "$ARCHIVE"
  ls -1t "$ESCAPE_DIR"/qpa-*.tar.gz.gpg 2>/dev/null | tail -n +$((ESCAPE_KEEP+1)) | xargs -r rm -f
fi
# Restore instructions sit in PLAINTEXT beside the archives on purpose: the one
# moment you need them is the moment you cannot read anything encrypted.
cat > "$ESCAPE_DIR/RESTORE.txt" <<'TXT'
These are encrypted snapshots of the productivity app's data:
tracker.db (SQLite), logs/ and daybook/ (markdown), config.json.

daybook/ is the one you can read with no tools at all: one file per day,
YYYY/YYYY-MM-DD.md, holding that day's data in plain text.

To restore anywhere, with no restic and no app:

    gpg -d qpa-YYYY-MM-DD.tar.gz.gpg | tar xz

The passphrase is the same one that unlocks the restic repository — the
one escrowed in a password manager. Losing it loses these too.

Markdown opens in any editor. tracker.db opens with: sqlite3 tracker.db
TXT
TARGETS+=("$ESCAPE_DIR")

restic backup --tag qpa --host qpa-server "${TARGETS[@]}" || fail_out "restic backup failed"

# Keep the staging copy out of the way between runs; it is a full second copy
# of the database and it is already in the snapshot.
rm -f "$STAGE/tracker.db"

fail=0
# Retention. Daily granularity for two weeks is what an "I broke something
# yesterday" restore needs; the monthlies are for "when did this text change?".
# --keep-last preserves the intra-day snapshots the 6-hourly timer makes;
# without it --keep-daily would prune all but the last of each day and the
# effective RPO for a log edit would silently fall back to 24h.
# --group-by host,tags (NOT the default host,paths): retention must not depend
# on the path list. Adding qpa-escape to the targets forked the default
# grouping in two, so each group silently kept its own 8/14/8/12 and every
# future change to what gets backed up would fragment it again.
restic forget --tag qpa --group-by host,tags \
  --keep-last 8 --keep-daily 14 --keep-weekly 8 --keep-monthly 12 \
  --prune || { echo "qpa-backup: forget/prune FAILED" >&2; fail=1; }

# Cheap structural check every run; the full --read-data check is far too slow
# to run daily against object storage.
restic check --with-cache >/dev/null || { echo "qpa-backup: check FAILED" >&2; fail=1; }

# A retention or verify failure must not report success. This script's output
# is the only thing watching the backups, so "ok" has to mean every step ran —
# otherwise pruning could silently stop and the repo grows without bound, or
# corruption goes unreported, while the log still reads fine.
[ $fail -eq 0 ] || fail_out "retention or verification failed"

write_status ok "$(ls -1 "$ESCAPE_DIR"/qpa-*.tar.gz.gpg 2>/dev/null | wc -l) escape archives"

# Dead-man's switch. Backups fail silently by nature — the failure is the
# ABSENCE of something. Only an outside observer can notice silence, so a
# successful run pings one; if the pings stop, it alerts. No URL set = no-op.
[ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" -o /dev/null 2>/dev/null

echo "qpa-backup: ok $(date -Is)"
