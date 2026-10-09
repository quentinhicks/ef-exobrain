"""Inside the 24h lock a gate's day can be TIGHTENED and nothing else.
Run: python gate_tighten_test.py

2026-10-08, Quentin's instruction: "allow me to tighten gates but not allow me
to loosen gates within 24 hours". The day-level lock (override_locked) refused
EVERY change once the deadline was within 24h, so moving tonight's deadline
earlier was refused exactly like moving it later. The rule is now
qr_judge.window_tightens: a window inside the one in force is a tightening
(no scan it accepts was refused before); anything else - later, wider, or a
translation either way - stays locked. Removing a day's override is the same
question asked of the window beneath it. This is a MONEY file, tested through
the routes, because the routes are where the refusal lives.
"""

import json
import os
import sys
import tempfile
from datetime import date as date_cls, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
os.environ['PT_HEADLESS'] = '1'
sys.path.insert(0, HERE)

import storage          # noqa: E402
import qr_judge         # noqa: E402
import app as app_mod   # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


TODAY = date_cls.today().isoformat()            # its close is always inside the lock
FAR = (date_cls.today() + timedelta(days=6)).isoformat()

storage.init_db()
storage.set_setting('last_backup_date', TODAY)
c = app_mod.app.test_client()


def node_of(nid):
    return next(n for n in storage.qr_get_nodes() if n['id'] == nid)


def move(nid, ymd, start, end, off=0):
    return c.post(f'/api/accountability/nodes/{nid}/overrides', json={
        'date': ymd, 'window_start': start, 'window_end': end, 'window_end_offset_days': off})


def window(nid, ymd):
    return qr_judge.resolve_window(node_of(nid), ymd)


nid = storage.qr_create_node('Wake', 'tok-tight-1', '06:00', '08:00')
check('today is inside the lock', qr_judge.override_locked(node_of(nid), TODAY))

# -- tightening lands at once ----------------------------------------------
r = move(nid, TODAY, '06:00', '07:30')
check('an earlier deadline inside the lock is accepted', r.status_code == 200, r.get_json())
check('...and is the window now', window(nid, TODAY)[:2] == ('06:00', '07:30'), window(nid, TODAY))
r = move(nid, TODAY, '06:30', '07:30')
check('a later opening (narrower again) is accepted', r.status_code == 200, r.get_json())

# -- loosening is refused --------------------------------------------------
for label, w in [('a later deadline', ('06:30', '09:00')),
                 ('an earlier opening', ('06:00', '07:30')),
                 ('a translation earlier', ('06:00', '07:00')),
                 ('a translation later', ('07:00', '08:00'))]:
    r = move(nid, TODAY, *w)
    check(f'{label} inside the lock is refused', r.status_code == 403, r.get_json())
check('...and the window is unchanged by every refusal',
      window(nid, TODAY)[:2] == ('06:30', '07:30'), window(nid, TODAY))
check('the refusal says what IS allowed',
      'tightened' in (move(nid, TODAY, '06:00', '09:00').get_json() or {}).get('error', ''))

# -- removing a day's change is the same question --------------------------
day = c.get(f'/api/accountability/nodes/{nid}/day?date={TODAY}').get_json()
check('removing a TIGHTENING override would loosen, and is served as locked',
      day.get('remove_locked') is True, day.get('remove_locked'))
r = c.delete(f'/api/accountability/nodes/{nid}/overrides/{TODAY}')
check('...and the DELETE is refused', r.status_code == 403, r.get_json())

nid2 = storage.qr_create_node('Gym', 'tok-tight-2', '06:00', '08:00')
storage.qr_set_override(nid2, TODAY, '05:00', '09:00', 0)       # widened before the lock
day = c.get(f'/api/accountability/nodes/{nid2}/day?date={TODAY}').get_json()
check('removing a WIDENING override tightens, and is served as open',
      day.get('remove_locked') is False, day.get('remove_locked'))
r = c.delete(f'/api/accountability/nodes/{nid2}/overrides/{TODAY}')
check('...and the DELETE is accepted', r.status_code == 200, r.get_json())
check('...back on the default window', window(nid2, TODAY)[:2] == ('06:00', '08:00'))

# -- calling the day off is still a loosening ------------------------------
r = c.post(f'/api/accountability/nodes/{nid2}/overrides', json={'date': TODAY, 'skipped': True})
check('calling a day off inside the lock is still refused', r.status_code == 403, r.get_json())

# -- outside the lock nothing changes --------------------------------------
check('a day a week out is not locked', not qr_judge.override_locked(node_of(nid), FAR))
r = move(nid, FAR, '05:00', '10:00')
check('...and can still be loosened', r.status_code == 200, r.get_json())

# -- past midnight: compared as minutes, never as HH:MM strings ------------
nid3 = storage.qr_create_node('Sleep', 'tok-tight-3', '22:00', '01:00', offset_days=1)
n3 = node_of(nid3)
check('a close pulled back from 01:00 to 00:30 (+1d) tightens',
      qr_judge.window_tightens(n3, FAR, ('22:00', '00:30', 1)))
check('a close pulled back over midnight to 23:30 tightens',
      qr_judge.window_tightens(n3, FAR, ('22:00', '23:30', 0)))
check('a close pushed to 02:00 (+1d) does not',
      not qr_judge.window_tightens(n3, FAR, ('22:00', '02:00', 1)))
check('an opening moved earlier to 21:00 does not',
      not qr_judge.window_tightens(n3, FAR, ('21:00', '00:30', 1)))

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
