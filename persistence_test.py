"""What the app says it saved is saved. Run: python persistence_test.py

Every write goes through its real route, and is then read back from a FRESH
connection to the file — the way a restart, the judge or the backup would see
it — not from the process that wrote it. What is under test (2026-10-11,
Quentin's instruction: ensure my data and my files are being saved properly):

  1. Each kind of write lands in the database file: captures, edits, deletes
     and undo's restore (same id), placements (and which thing they are on),
     lists, documents, one-off and weekly-day blocks, settings.
  2. No write leaves a transaction open behind it. An uncommitted write is
     invisible to every other connection and is rolled back when the process
     dies — and while it is open, it locks the judge and the backup out. So
     after every request, another connection must be able to take the write
     lock at once.
  3. Files are files: a Vision photo is written to the data dir byte for
     byte, served back, and removed; the daybook writes today's file with
     what was just saved in it.
  4. The file passes SQLite's own integrity check at the end.
"""

import base64
import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls

DATA = tempfile.mkdtemp(prefix='qpa-persist-')
os.chdir(DATA)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app as app_mod    # noqa: E402
import daybook           # noqa: E402

client = app_mod.app.test_client()
TODAY = date_cls.today().isoformat()
DB = os.path.join(DATA, storage.DB_PATH)
ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def fresh():
    conn = sqlite3.connect(DB, timeout=0.5)
    conn.row_factory = sqlite3.Row
    return conn


def unlocked(label):
    # Another connection takes the write lock at once, or a write was left
    # open behind the request.
    conn = fresh()
    try:
        conn.execute('BEGIN IMMEDIATE')
        conn.rollback()
        check(f'{label}: nothing left uncommitted', True)
    except sqlite3.OperationalError as e:
        check(f'{label}: nothing left uncommitted', False, e)
    conn.close()


def one(sql, *args):
    conn = fresh()
    row = conn.execute(sql, args).fetchone()
    conn.close()
    return row


def send(method, path, body=None):
    r = client.open(path, method=method, json=body)
    unlocked(f'{method} {path}')
    return r


# ── 1. The inventory ─────────────────────────────────────────
r = send('POST', '/api/inbox', {'content': 'persist: a capture'})
item = r.get_json()
check('a capture is in the file', one('SELECT content FROM inbox_item WHERE id = ?', item['id'])['content']
      == 'persist: a capture')

send('PATCH', f"/api/inbox/{item['id']}", {'status': 'active', 'notes': 'with notes', 'tags': '30m'})
row = one('SELECT status, notes, tags FROM inbox_item WHERE id = ?', item['id'])
check('an edit is in the file', (row['status'], row['notes'], row['tags']) == ('active', 'with notes', '30m'),
      dict(row))

send('POST', '/api/engage/placements', {'item_id': item['id'], 'date': TODAY, 'minute': 600,
                                         'anchor': 'ev1|2026-01-01T10:00:00'})
row = one('SELECT minute, anchor FROM engage_placement WHERE item_id = ? AND date = ?', item['id'], TODAY)
check('a placement is in the file, with the thing it is on',
      row is not None and (row['minute'], row['anchor']) == (600, 'ev1|2026-01-01T10:00:00'),
      dict(row) if row else None)

snap = client.get(f"/api/inbox/{item['id']}/snapshot").get_json()
send('DELETE', f"/api/inbox/{item['id']}")
check('a delete is in the file', one('SELECT 1 FROM inbox_item WHERE id = ?', item['id']) is None)
send('POST', '/api/inbox/restore', snap)
row = one('SELECT content, notes FROM inbox_item WHERE id = ?', item['id'])
check("undo's restore is in the file, under the SAME id",
      row is not None and row['notes'] == 'with notes')
row = one('SELECT anchor FROM engage_placement WHERE item_id = ?', item['id'])
check('and so is its placement, still on the same thing',
      row is not None and row['anchor'] == 'ev1|2026-01-01T10:00:00')

# ── 2. Lists and documents ───────────────────────────────────
lst = send('POST', '/api/ref/lists', {'name': 'persist list', 'kind': 'list'}).get_json()
send('POST', '/api/ref/items', {'list_id': lst['id'], 'content': 'a bullet'})
check('a list and its item are in the file',
      one('SELECT COUNT(*) AS n FROM ref_item WHERE list_id = ?', lst['id'])['n'] == 1)
doc = send('POST', '/api/ref/lists', {'name': 'persist doc', 'kind': 'doc', 'body': 'first'}).get_json()
send('POST', f"/api/ref/lists/{doc['id']}/append", {'text': 'second'})
body = one('SELECT body FROM ref_list WHERE id = ?', doc['id'])['body']
check('a document append is in the file', 'first' in body and 'second' in body, body)

# ── 3. Blocks, both halves ───────────────────────────────────
db_ = send('POST', '/api/day-blocks', {'date': TODAY, 'start_min': 540, 'end_min': 600,
                                       'label': 'persist block', 'color': '#336699'}).get_json()
check('a one-off block is in the file',
      one('SELECT label FROM day_block WHERE id = ?', db_['id'])['label'] == 'persist block')
wk = storage.create_block('persist weekly', '#669933', date_cls.today().weekday(), '13:00', '14:00', None, None)
wk_id = wk['id'] if isinstance(wk, dict) else wk
send('POST', '/api/overrides', {'block_id': wk_id, 'date': TODAY, 'cancelled': True})
row = one('SELECT cancelled FROM block_override WHERE block_id = ? AND date = ?', wk_id, TODAY)
check("a weekly block's one-day change is in the file", row is not None and row['cancelled'] == 1)

# ── 4. Settings ──────────────────────────────────────────────
send('PATCH', '/api/settings', {'persist_probe': 'yes'})
check('a setting is in the file',
      one("SELECT value FROM setting WHERE key = 'persist_probe'")['value'] == 'yes')

# ── 5. Files ─────────────────────────────────────────────────
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==')
r = send('POST', '/api/vision', {'data': 'data:image/png;base64,' + base64.b64encode(png).decode()})
name = (r.get_json() or {}).get('name')
path = os.path.join(DATA, storage.VISION_DIR, name or '-')
check('a Vision photo is a file in the data dir', bool(name) and os.path.isfile(path), name)
check('byte for byte', os.path.isfile(path) and open(path, 'rb').read() == png)
check('and is served back', bool(name) and client.get(f'/vision/{name}').data == png)
send('DELETE', f'/api/vision/{name}')
check('and removing it removes the file', not os.path.exists(path))

daybook.write_day(TODAY)
day_file = os.path.join(DATA, daybook.DAYBOOK_DIR, TODAY[:4], f'{TODAY}.md')
text = open(day_file, encoding='utf-8').read() if os.path.isfile(day_file) else ''
check("today's daybook file carries what was saved", 'persist: a capture' in text and 'persist block' in text)

# ── 6. The file itself ───────────────────────────────────────
conn = fresh()
check('the database passes integrity_check', conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok')
conn.close()

for line in ok + bad:
    print(line)
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
