# Backups — encrypted, offsite, versioned

Git is not a backup layer. Since 2026-08-08 `logs/` and `backups/` are
untracked; durability is restic's job.

## What runs

`qpa-backup.timer` → `~/qpa-backup.sh`, every 6h on the VM, `Persistent=true`
so a VM that was off catches up on boot.

Each run takes a **consistent** SQLite snapshot first (`sqlite3`'s online
backup API, the same call `storage.backup_db()` uses — a plain file copy of a
live database can restore corrupt), then backs up that snapshot plus `logs/`,
`daybook/` and `config.json`.

`daybook/` is the LEGIBLE copy: `daybook.py` writes one markdown file per day
(`daybook/YYYY/YYYY-MM-DD.md`) holding that day's data plus the standing state it
sat in, rendered from the schema at write time. The database backups restore the
app; the daybook survives the app. Written on every start of the process that
takes the snapshot, so the two travel together.

| | |
|---|---|
| Repository | `s3:…<namespace>.compat.objectstorage.<region>.oraclecloud.com/<bucket>` |
| Encryption | restic, client-side — Oracle only ever stores ciphertext |
| Password | `~/.config/qpa/restic-password` (0600) **and a password manager** |
| Config | `~/.config/qpa/backup.env` (0600) — repo URL + S3 keys + region |
| Retention | `--keep-last 8 --keep-daily 14 --keep-weekly 8 --keep-monthly 12`, `--group-by host,tags` |
| Bucket | versioning ON, previous versions expire after 30 days |

`AWS_DEFAULT_REGION` is load-bearing: Oracle rejects the S3 default of
`us-east-1` with a confusing "secret key could not be found".

`--group-by host,tags` is deliberate. restic's default groups by *paths*, so
changing what gets backed up silently forks retention into two groups that each
keep a full policy's worth. Grouping on the tag makes the path list irrelevant.

## The escape hatch — recovering without restic

restic protects against losing the data. `~/qpa-escape/` protects against
losing **restic**: a daily `tar.gz` of the db + logs + daybook + config, GnuPG symmetric
AES256, same passphrase as the repo (one secret to escrow, not two). It is
included in the restic snapshot, so it is offsite too.

```bash
gpg -d qpa-YYYY-MM-DD.tar.gz.gpg | tar xz
```

That is the whole procedure, on any machine, with tools that predate this app
by decades. `RESTORE.txt` sits unencrypted beside the archives because the
moment you need instructions is the moment you cannot read ciphertext. Seven
days are kept locally; older ones survive in restic's history.

This matters more than provider redundancy: logs are markdown and the database
is SQLite, so a recovered archive is readable with a text editor and `sqlite3`
even if this project no longer exists.

## Monitoring — silence is the failure mode

A backup fails by *not happening*, which nothing on the host can notice. Two
mechanisms:

- `~/.config/qpa/last-backup.json` — result + timestamp of the last run.
- `HEALTHCHECK_URL` in `backup.env` (optional; unset = no-op). A successful run
  pings it; a failure pings `$HEALTHCHECK_URL/fail`, so "host is gone" and
  "host is alive, backup is broken" are distinguishable. If the pings stop, the
  external service alerts.

## Restore

```bash
set -a; . ~/.config/qpa/backup.env; set +a
restic snapshots
restic restore latest --target /tmp/restore
```
The database lands at `/tmp/restore/home/ubuntu/.qpa-backup-stage/tracker.db`,
logs at `…/productivity-app/logs`. Stop the service before replacing live files.

## Rebuilding the VM from nothing

You need three things, and only the first is not reproducible: the **restic
password**, the repo URL, and S3 credentials (mint a fresh Customer Secret Key
in the OCI console — the old one dies with the VM). Then re-run steps 2–5 of
ORACLE.md and `restic restore latest`.

Newly-created Customer Secret Keys take **~100 seconds** to become usable;
`Access Denied` immediately after creating one is propagation, not a mistake.

## Checking it still works

```bash
systemctl list-timers qpa-backup.timer
journalctl -u qpa-backup.service -n 20
restic check --read-data          # decrypts and hashes every blob
```
The script exits non-zero if retention or verification fails, so a broken run
shows as a failed unit rather than a log line nobody reads.

## Known gaps

- **Same provider.** The VM and the bucket are one Oracle tenancy: account
  suspension takes out both. A second copy at another provider is the fix.
- **No monitoring.** Nothing tells you if backups stop; failures land in the
  journal. A dead-man's-switch ping is the fix.
- **Not disaster recovery.** systemd units, `backup.env` and the venv are not
  in the snapshot — the code repo and ORACLE.md cover those.
