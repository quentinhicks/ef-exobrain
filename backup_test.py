"""The data is backed up, and the backups are kept safe. Run: python backup_test.py

(2026-10-11, Quentin's instruction: tests that storage itself is being backed
up securely.) Two halves: the local snapshot this process takes
(storage.backup_db) is tested by running it; the offsite run
(deploy/qpa-backup.sh, restic + gpg on the VM) cannot run here, so it is held
to what deploy/BACKUPS.md promises by reading the script — a tripwire, not a
proof that restic uploaded anything (the VM's last-backup.json and the
healthcheck are that).

  1. A snapshot is a real, restorable database holding the latest write, and
     the SQL dump holds it too.
  2. A snapshot taken while another connection is mid-write is still whole
     (the online backup API, never a file copy) and lands after it commits.
  3. Retention keeps the newest BACKUP_KEEP snapshots and drops the rest.
  4. On the VM the plaintext copies are readable by their owner only.
  5. Secrets live in config.json and nowhere else: not in the database, not
     in a backup, not in any API answer.
  6. Nothing in the data plane is served over HTTP, and none of it can be
     committed: git ignores the db, config, backups, logs, daybook, photos.
  7. The offsite script snapshots with the backup API, sends the db, logs,
     daybook, photos and config to restic (client-side encrypted), keeps a
     gpg AES256 escape archive of the same at 0600, prunes, checks, and
     reports a failed step as a failure.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from datetime import date as date_cls

REPO = os.path.dirname(os.path.abspath(__file__))
DATA = tempfile.mkdtemp(prefix='qpa-backup-')
os.chdir(DATA)
sys.path.insert(0, REPO)

import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app as app_mod    # noqa: E402

client = app_mod.app.test_client()
TODAY = date_cls.today().isoformat()
SNAP = os.path.join(DATA, storage.BACKUPS_DIR, f'tracker-{TODAY}.db')
DUMP = os.path.join(DATA, storage.BACKUPS_DIR, 'tracker.sql')
ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def snap_has(content):
    conn = sqlite3.connect(SNAP)
    hit = conn.execute('SELECT 1 FROM inbox_item WHERE content = ?', (content,)).fetchone()
    whole = conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    conn.close()
    return bool(hit), whole


# ── 1. A snapshot holds the latest write ─────────────────────
client.post('/api/inbox', json={'content': 'backup: the latest write'})
storage.backup_db()
hit, whole = snap_has('backup: the latest write')
check('the snapshot opens and passes integrity_check', whole)
check('the snapshot holds the latest write', hit)
check('the SQL dump holds it too', 'backup: the latest write' in open(DUMP, encoding='utf-8').read())
check('the backup records itself', storage.get_settings().get('last_backup_date') == TODAY)

# ── 2. Taken while another connection is mid-write ───────────
held = threading.Event()


def writer():
    conn = sqlite3.connect(storage.DB_PATH)
    conn.execute('BEGIN IMMEDIATE')
    conn.execute("INSERT INTO inbox_item (content) VALUES ('backup: mid-write')")
    held.set()
    time.sleep(1.0)
    conn.commit()
    conn.close()


t = threading.Thread(target=writer)
t.start()
held.wait()
err = None
try:
    storage.backup_db()
except Exception as e:
    err = e
t.join()
check('a snapshot taken during another write completes', err is None, err)
_, whole = snap_has('backup: mid-write')
check('and is whole', whole)

# ── 3. Retention ─────────────────────────────────────────────
for i in range(storage.BACKUP_KEEP + 5):
    open(os.path.join(DATA, storage.BACKUPS_DIR, f'tracker-2000-01-{i + 1:02d}.db'), 'w').close()
storage.backup_db()
kept = sorted(f for f in os.listdir(storage.BACKUPS_DIR) if re.match(r'tracker-\d{4}-\d{2}-\d{2}\.db$', f))
check(f'retention keeps {storage.BACKUP_KEEP} snapshots', len(kept) == storage.BACKUP_KEEP, len(kept))
check("and today's is one of them", os.path.basename(SNAP) in kept)

# ── 4. Owner-only on the VM ──────────────────────────────────
if os.name == 'posix':
    for p in (SNAP, DUMP):
        check(f'{os.path.basename(p)} is 0600', (os.stat(p).st_mode & 0o777) == 0o600, oct(os.stat(p).st_mode))
else:
    ok.append('SKIP  file modes (Windows has none; checked on the VM)')

# ── 5. Secrets stay in config.json ───────────────────────────
TOKEN = 'tok-backup-test-7f3a9c'
client.patch('/api/config', json={'beeminder_auth_token': TOKEN})
check('the token was saved to config.json', TOKEN in open('config.json', encoding='utf-8').read())
storage.backup_db()
for label, path in (('the database', storage.DB_PATH), ('the snapshot', SNAP), ('the SQL dump', DUMP)):
    check(f'the token is not in {label}', TOKEN.encode() not in open(path, 'rb').read())
for path in ('/api/config', '/api/settings'):
    check(f'GET {path} never answers with the token', TOKEN not in client.get(path).get_data(as_text=True))
client.patch('/api/config', json={'beeminder_auth_token': app_mod.CLEAR_SENTINEL})

# ── 6. Not served, not committed ─────────────────────────────
os.makedirs('logs', exist_ok=True)
open('logs/private.md', 'w').write('private')
for path in ('/tracker.db', '/config.json', f'/backups/tracker-{TODAY}.db', '/backups/tracker.sql',
             '/logs/private.md', f'/daybook/{TODAY[:4]}/{TODAY}.md', '/static/../config.json',
             '/static/..%2Fconfig.json', '/vision/..%2Fconfig.json', '/vision/../tracker.db'):
    r = client.get(path)
    leaked = r.status_code == 200 and (b'SQLite format' in r.data or b'private' in r.data
                                       or b'beeminder' in r.data or b'INSERT INTO' in r.data)
    check(f'GET {path} does not serve data', not leaked, r.status_code)

git = shutil.which('git')
if git:
    for path in ('tracker.db', 'config.json', 'credentials.json', 'backups/tracker-2026-01-01.db',
                 'backups/tracker.sql', 'logs/x.md', 'daybook/2026/2026-01-01.md',
                 'vision/20260101000000-abcdef.jpg'):
        r = subprocess.run([git, 'check-ignore', '-q', path], cwd=REPO)
        check(f'git ignores {path}', r.returncode == 0)
else:
    ok.append('SKIP  git ignore checks (no git on PATH)')

# ── 7. The offsite run says what BACKUPS.md promises ─────────
script = open(os.path.join(REPO, 'deploy', 'qpa-backup.sh'), encoding='utf-8').read()
code = '\n'.join(l for l in script.splitlines() if not l.lstrip().startswith('#'))
promises = [
    ('snapshots with the online backup API, not a file copy', 'src.backup(dest)' in code),
    ('stops on errors in pipes and unset vars', 'set -uo pipefail' in code),
    ('the staging copy is owner-only', 'chmod 700 "$STAGE"' in code),
    ('restic gets the snapshot', 'TARGETS=("$STAGE/tracker.db")' in code),
    ('restic gets logs/', 'TARGETS+=("$APP_DIR/logs")' in code),
    ('restic gets daybook/', 'TARGETS+=("$APP_DIR/daybook")' in code),
    ('restic gets vision/', 'TARGETS+=("$APP_DIR/vision")' in code),
    ('restic gets config.json', 'TARGETS+=("$APP_DIR/config.json")' in code),
    ('restic gets the escape archives', 'TARGETS+=("$ESCAPE_DIR")' in code),
    ('the escape archive is gpg AES256', '--symmetric --cipher-algo AES256' in code),
    ('the escape archive carries daybook/', 'ESCAPE_PATHS+=(daybook)' in code),
    ('the escape archive carries vision/', 'ESCAPE_PATHS+=(vision)' in code),
    ('the escape archive is 0600', 'chmod 600 "$ARCHIVE"' in code),
    ('the unencrypted tarball is removed', 'rm -f "$STAGE/escape.tar.gz"' in code),
    ('a failed restic backup is reported as a failure', 'restic backup' in code
     and '|| fail_out "restic backup failed"' in code),
    ('retention runs', 'restic forget' in code and '--prune' in code),
    ('the repository is checked', 'restic check' in code),
    ('a failed prune or check is not reported ok', '[ $fail -eq 0 ] || fail_out' in code),
    ('the dead-man switch is pinged on success and on failure',
     code.count('HEALTHCHECK_URL') >= 2 and '/fail' in code),
]
for label, cond in promises:
    check(f'qpa-backup.sh: {label}', cond)
bash = shutil.which('bash')
if bash:
    r = subprocess.run([bash, '-n', os.path.join(REPO, 'deploy', 'qpa-backup.sh')], capture_output=True)
    check('qpa-backup.sh parses', r.returncode == 0, r.stderr.decode()[:200])
timer = open(os.path.join(REPO, 'deploy', 'qpa-backup.timer'), encoding='utf-8').read()
check('the timer catches up after downtime (Persistent=true)', 'Persistent=true' in timer)

for line in ok + bad:
    print(line)
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
