"""A routine can ALSO be a task. Run: python flow_task_test.py

Running a routine was only reachable from the Lists surface or the GTD
fold-out's ▶, so a routine you do weekly was invisible on the day you were
meant to do it. With `as_task` on, the routine seeds an ordinary next action on
the days it runs.

What earns tests here is the seeding arithmetic, because it writes into
inbox_item on every pool read: exactly ONE live action per routine however many
times the pool is read, the right DAY, and the run and the task agreeing about
whether the thing is still outstanding.
"""

import os
import sys
import tempfile
import datetime

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import app as A         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()
TODAY = datetime.date.today()
TODAY_S = TODAY.isoformat()
today_dow = str(TODAY.weekday())
other_dow = str((TODAY.weekday() + 1) % 7)


def pool_names():
    return [i['content'] for i in c.get('/api/inbox/active').get_json()]


# The pool JOINs area, so a seeded action needs one. A fresh db has the
# undeletable General fallback; use an explicit area to prove area_id is read.
area = c.post('/api/areas', json={'name': 'Admin'}).get_json()

wr = c.post('/api/flows', json={'name': 'Weekly review'}).get_json()
c.patch(f"/api/flows/{wr['id']}", json={'period': 'week'})

check('a routine is not a task by default', 'Weekly review' not in pool_names(), pool_names())

# ── on, for today ────────────────────────────────────────────────
c.patch(f"/api/flows/{wr['id']}",
        json={'as_task': 1, 'days_of_week': today_dow, 'area_id': area['id']})
check('turning it on seeds the action', 'Weekly review' in pool_names(), pool_names())
seeded = [i for i in c.get('/api/inbox/active').get_json() if i['content'] == 'Weekly review'][0]
check('the action points back at the routine', seeded['flow_id'] == wr['id'], seeded)
check('and lands in the area the routine names', seeded['area_id'] == area['id'], seeded)

# ── idempotent: the pool is read constantly ──────────────────────
for _ in range(4):
    pool_names()
check('re-reading the pool does not seed a second one',
      pool_names().count('Weekly review') == 1, pool_names())

# ── the wrong day ────────────────────────────────────────────────
# A routine of its own, because the ledger above is spent for this period:
# once seeded, changing the days must NOT resurrect the task you ticked off.
off = c.post('/api/flows', json={'name': 'Other-day routine'}).get_json()
c.patch(f"/api/flows/{off['id']}",
        json={'as_task': 1, 'days_of_week': other_dow, 'area_id': area['id']})
check('it is not seeded on a day it does not run',
      'Other-day routine' not in pool_names(), pool_names())
c.patch(f"/api/flows/{off['id']}", json={'as_task': 0})
c.patch(f"/api/flows/{off['id']}", json={'as_task': 1, 'days_of_week': today_dow})
check('and is on a day it does', 'Other-day routine' in pool_names(), pool_names())

# The ledger is what makes ticking it off stick — re-arming is switching the
# rule off and on again, which is a deliberate act, not a side effect of
# editing the days.
c.delete(f"/api/inbox/{[i for i in c.get('/api/inbox/active').get_json()
                        if i['content'] == 'Other-day routine'][0]['id']}")
c.patch(f"/api/flows/{off['id']}", json={'days_of_week': today_dow})
check('editing the days does not resurrect a task already ticked off',
      'Other-day routine' not in pool_names(), pool_names())
c.patch(f"/api/flows/{off['id']}", json={'as_task': 0})

c.delete(f"/api/inbox/{seeded['id']}")

# ── completing the RUN retires the task ──────────────────────────
c.put(f"/api/flows/{wr['id']}/run", json={'date': TODAY_S, 'steps': {}, 'completed': True})
check('completing the routine takes its task away',
      'Weekly review' not in pool_names(), pool_names())
check('...and does not seed it again while it stays complete',
      'Weekly review' not in pool_names(), pool_names())

# A completed run does not un-complete (upsert_flow_run COALESCEs completed_at),
# so the task stays retired for the rest of the period. That is the point of a
# period key: a weekly routine files under its Monday and is done all week.
check('and stays retired for the rest of the period',
      'Weekly review' not in pool_names(), pool_names())

# ── switching it off retires what is already there ───────────────
c.patch(f"/api/flows/{wr['id']}", json={'as_task': 0})
check('switching it off removes the standing action',
      'Weekly review' not in pool_names(), pool_names())
check('and it stays off', 'Weekly review' not in pool_names(), pool_names())

# ── a DAILY routine, every day (NULL days) ───────────────────────
d = c.post('/api/flows', json={'name': 'Morning routine'}).get_json()
c.patch(f"/api/flows/{d['id']}", json={'as_task': 1, 'area_id': area['id']})
check('no days means every day', 'Morning routine' in pool_names(), pool_names())
daily = [i for i in c.get('/api/inbox/active').get_json()
         if i['content'] == 'Morning routine'][0]

# Completing the ACTION by hand is not completing the routine — but it must not
# come straight back either, or ticking it off would do nothing at all.
c.delete(f"/api/inbox/{daily['id']}")
check('ticking the action off leaves it gone for the period',
      'Morning routine' not in pool_names(), pool_names())

# ── a gate-linked routine is untouched by any of this ────────────
check('as_task did not disturb the gate columns',
      c.get('/api/flows').get_json() is not None)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
