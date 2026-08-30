"""A gate's day can be called OFF, and calling it off is a real write.
Run: python gate_skip_test.py

2026-08-29, Quentin's instruction. Right-clicking a gate on the timeline used to
file a `timeline_dismissal` row - a VIEW-only store nothing in qr_judge reads.
The pill vanished, the calendar said the gate was gone for that day, and the
judge charged the day exactly as if nothing had happened. The two surfaces had
no way to disagree out loud, because only one of them was ever consulted.

The day-level road already existed and the gesture simply was not on it:
`qr_override` is the first thing resolve_window consults, and `override_locked`
is the 24h protection. A skip is a column on that row, so:

    applies_on refuses the day  ->  the judge lands 'n/a'  ->  no money

which is the same road a non-run weekday already travels. This is a MONEY file:
it checks that a skip actually reaches the judge, that it CANNOT be used to
dodge a gate already inside its 24h lock, and that un-skipping - which
re-commits the day - is never refused and can never reach into a frozen day.
"""

import json
import os
import sys
import tempfile
from datetime import date as date_cls, datetime as dt, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import storage          # noqa: E402
import qr_judge         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


TODAY = date_cls.today().isoformat()
YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()
FAR = (date_cls.today() + timedelta(days=6)).isoformat()


def fresh():
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    storage.set_setting('gate_charging_live', '0')
    storage.set_setting('gate_charge_dryrun', '1')
    storage.set_setting('gate_weekly_cap_cents', '10000')
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': 't', 'beeminder_user': 'q'}, f)


def node_of(nid):
    return next(n for n in storage.qr_get_nodes() if n['id'] == nid)


def judged(nid, ymd):
    return storage.qr_node_day_state(nid, ymd)['judged']


def skip(nid, ymd, on=True):
    w = qr_judge.resolve_window(node_of(nid), ymd)
    storage.qr_set_override(nid, ymd, w[0], w[1], w[2], skipped=on)


# -- the skip reaches the judge -------------------------------------------
fresh()
nid = storage.qr_create_node('Wake', 'tok-skip-1', '06:00', '08:00')
check('a gate runs on a plain day', qr_judge.applies_on(node_of(nid), YESTERDAY))

skip(nid, YESTERDAY)
check('...and does not on a day that was called off',
      not qr_judge.applies_on(node_of(nid), YESTERDAY))

# The judge, on a day with no scan at all: without the skip this is a charge.
qr_judge.judge(now=dt.fromisoformat(TODAY + 'T09:00:00'))
j = judged(nid, YESTERDAY)
check("a called-off day is judged 'n/a', not charged",
      bool(j) and j['charge_status'] == 'n/a', dict(j) if j else None)
check('...and earns no failure reason, because nothing failed',
      bool(j) and not j['failure_reason'], j and j['failure_reason'])

check('outcomes stays silent about it - neutral, like a non-run weekday',
      not [o for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
           if o['node_id'] == nid],
      qr_judge.outcomes(YESTERDAY, YESTERDAY))

# -- but the pill still draws, or there is no way back --------------------
days = storage.qr_gate_day_windows(node_of(nid), days=3,
                                   start=date_cls.fromisoformat(YESTERDAY))
check('a called-off day is still SERVED to the timeline',
      YESTERDAY in days, sorted(days))
check('...carrying the mark, so the pill draws struck through rather than gone',
      days.get(YESTERDAY, {}).get('skipped') is True, days.get(YESTERDAY))
check('...and an ordinary day is served unmarked',
      days.get(TODAY, {}).get('skipped') is False, days.get(TODAY))

# -- the 24h lock: skipping is a loosening, un-skipping is not ------------
fresh()
nid = storage.qr_create_node('Wake', 'tok-skip-2', '06:00', '08:00')
n = node_of(nid)
# 06:00 this morning: today's 08:00 close is inside the lock, a week out is not.
now = dt.fromisoformat(TODAY + 'T06:00:00')
check('today is locked, so the day cannot be dodged on the day',
      qr_judge.override_locked(n, TODAY, now))
check('...while a day a week out is open to being called off',
      not qr_judge.override_locked(n, FAR, now))

# -- un-skipping cannot reach back into a frozen day ----------------------
fresh()
nid = storage.qr_create_node('Wake', 'tok-skip-3', '06:00', '08:00')
skip(nid, YESTERDAY)
qr_judge.judge(now=dt.fromisoformat(TODAY + 'T09:00:00'))
check("yesterday is frozen 'n/a'",
      judged(nid, YESTERDAY)['charge_status'] == 'n/a')

storage.qr_delete_override(nid, YESTERDAY)      # changed my mind, day back on
check('the day runs again once the skip is dropped',
      qr_judge.applies_on(node_of(nid), YESTERDAY))
qr_judge.judge(now=dt.fromisoformat(TODAY + 'T10:00:00'))
check('...but the frozen day is NOT retroactively charged for it',
      judged(nid, YESTERDAY)['charge_status'] == 'n/a',
      dict(judged(nid, YESTERDAY)))

# -- the two questions on one row do not overwrite each other -------------
fresh()
nid = storage.qr_create_node('Wake', 'tok-skip-4', '06:00', '08:00')
storage.qr_set_override(nid, FAR, '05:00', '09:00', 0)          # dragged wider
storage.qr_set_override(nid, FAR, '05:00', '09:00', 0, skipped=True)
ov = storage.qr_get_override(nid, FAR)
check('calling a day off keeps the window it was dragged to',
      (ov['window_start'], ov['window_end']) == ('05:00', '09:00'), dict(ov))

storage.qr_set_override(nid, FAR, '05:30', '09:30', 0)          # dragged again
ov = storage.qr_get_override(nid, FAR)
check('...and moving the window does not quietly put the day back on',
      ov['skipped'] == 1 and ov['window_start'] == '05:30', dict(ov))

storage.qr_set_override(nid, FAR, '05:30', '09:30', 0, skipped=False)
check('...while saying so explicitly does put it back',
      storage.qr_get_override(nid, FAR)['skipped'] == 0)

# -- the retired view store ----------------------------------------------
fresh()
conn = storage.get_conn()
conn.execute("INSERT INTO timeline_dismissal (type, key) VALUES ('qr', '1:2026-01-01')")
conn.execute("INSERT INTO timeline_dismissal (type, key) VALUES ('block', '1:2026-01-01')")
conn.execute("DELETE FROM setting WHERE key = 'qr_dismissals_retired'")
conn.commit()
conn.close()
storage.init_db()
kinds = {d['type'] for d in storage.get_timeline_dismissals()}
check('the retired gate dismissals are cleared once', 'qr' not in kinds, kinds)
check('...and block dismissals, which really are a view preference, stay',
      'block' in kinds, kinds)

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
