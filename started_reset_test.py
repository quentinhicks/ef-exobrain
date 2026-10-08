"""The to-do list's dots reset daily. Run: python started_reset_test.py

A dot (started_at) is a statement about TODAY: the morning after, every row
comes back undotted, and the row itself stays on the list. What is under test:

  * a stamp from before today is cleared; one from today is kept;
  * the day is the stamp's LOCAL date. The client stamps with toISOString, so
    a dot set at 21:00 the evening before reads as TOMORROW in UTC — slicing
    the first ten characters would let it survive the reset;
  * only the dot goes: the row, its status and its content are untouched;
  * a stamp that does not parse is left alone rather than guessed at.
"""
import datetime
import os
import sys
import tempfile

os.chdir(tempfile.mkdtemp(prefix='qpa-started-'))

import storage

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


real = datetime.date


class Frozen(real):
    @classmethod
    def today(cls):
        return real(2026, 10, 8)


storage.init_db()
storage.date_cls = Frozen


def utc_z(local):
    # The client's shape: the local wall time, as an instant, written in UTC.
    return local.astimezone().astimezone(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


evening_before = datetime.datetime(2026, 10, 7, 21, 0)
this_morning = datetime.datetime(2026, 10, 8, 8, 0)
rows = {
    'yesterday evening, UTC Z': utc_z(evening_before),
    'this morning, UTC Z': utc_z(this_morning),
    'yesterday, naive local': '2026-10-07 15:00:00',
    'today, naive local': '2026-10-08 09:30:00',
    'last week': utc_z(datetime.datetime(2026, 10, 1, 12, 0)),
    'garbage': 'not a stamp',
    'never started': None,
}
conn = storage.get_conn()
ids = {}
for label, stamp in rows.items():
    cur = conn.execute(
        "INSERT INTO inbox_item (content, status, kind, started_at) VALUES (?, 'active', 'item', ?)",
        (label, stamp))
    ids[label] = cur.lastrowid
conn.commit()
conn.close()

storage.clear_stale_started()


def row(label):
    conn = storage.get_conn()
    r = dict(conn.execute('SELECT * FROM inbox_item WHERE id = ?', (ids[label],)).fetchone())
    conn.close()
    return r


check('the evening before is cleared, though its UTC date is today',
      row('yesterday evening, UTC Z')['started_at'] is None, rows['yesterday evening, UTC Z'])
check('a dot from this morning is kept',
      row('this morning, UTC Z')['started_at'] == rows['this morning, UTC Z'])
check('a naive local stamp from yesterday is cleared',
      row('yesterday, naive local')['started_at'] is None)
check('a naive local stamp from today is kept',
      row('today, naive local')['started_at'] == rows['today, naive local'])
check('last week is cleared', row('last week')['started_at'] is None)
check('an unparseable stamp is left alone', row('garbage')['started_at'] == 'not a stamp')
check('a row never started stays unstarted', row('never started')['started_at'] is None)
r = row('yesterday evening, UTC Z')
check('only the dot goes: the row stays active, with its wording',
      r['status'] == 'active' and r['content'] == 'yesterday evening, UTC Z', r)

storage.clear_stale_started()
check('running twice changes nothing more',
      row('this morning, UTC Z')['started_at'] == rows['this morning, UTC Z'])

print('\n'.join(ok + bad))
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
