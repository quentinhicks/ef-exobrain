"""A RUN's pinned day has an END, and it is the money path's own grace.
Run: python run_pin_test.py

2026-09-02, Quentin's report: "when I have social dose planned next day the
previous day social still checks off", after midnight.

The runner pins the day a run was opened on (`flowRunView.date`) so a night
routine ticked at 00:05 credits the night it started - deliberate, and the
reason creditFlowStep asks runDay() instead of the clock. What was missing is
the other end. checkDayRollover never touched flowRunView, so an open run kept
the pin for the rest of the session: every later write that asks runDay() - a
metric, the journal, THIS morning's social dose - filed under a day that had
closed hours earlier. On a gated routine that is money, twice over: the new
day's routine looks undone (the split's routine half is lost and the day
charges) while the write lands on a day the judge has already frozen.

The boundary is not a new rule. `settle_after` already says a gated day cannot
be judged until midnight plus ROUTINE_GRACE_HOURS, because the routine can earn
its half right up to then; past it the day is settled. So the pin ends exactly
there, and it is SERVED (get_flows -> `settles_at`) rather than computed in
app.js, because a client re-derivation of a rule the judge charges against is a
bug even while it agrees.

The client half (pinnedRunStillLive / releaseStaleRunPin releasing the pin and
runDay() falling back to the wall day) is browser-driven; this is the server
half - the instant itself, and that every flow carries it.
"""

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


storage.init_db()

TODAY = date_cls.today().isoformat()

# ── The instant itself ───────────────────────────────────────
settles = qr_judge.run_settles_at('2026-09-01')
check('a run opened on the 1st settles on the 2nd, not the 1st',
      settles == dt(2026, 9, 2, 4, 0), settles)
check('and that is exactly midnight plus the ROUTINE grace',
      settles == dt(2026, 9, 2, 0, 0) + timedelta(hours=qr_judge.ROUTINE_GRACE_HOURS),
      qr_judge.ROUTINE_GRACE_HOURS)

# It must be the SAME instant the judge would settle a gated day at, or the
# runner would keep crediting a day the judge had already frozen. settle_after
# takes the max with the scan close, so the routine's outer bound is this one.
window = ('06:00', '09:00', 0)
check('it agrees with settle_after for a gated, routine-linked day',
      qr_judge.settle_after({'id': 1}, '2026-09-01', {'id': 1}, window) == settles,
      qr_judge.settle_after({'id': 1}, '2026-09-01', {'id': 1}, window))

# A gate with NO routine settles at its scan close instead - unchanged, and the
# reason run_settles_at takes no node: this is the ROUTINE half's bound.
check('a gate with no routine still settles at its own close, untouched',
      qr_judge.settle_after({'id': 1}, '2026-09-01', None, window)
      == dt(2026, 9, 1, 9, 0),
      qr_judge.settle_after({'id': 1}, '2026-09-01', None, window))

# Crossing a month is where a hand-rolled "+1 day" would have broken.
check('it crosses a month end without arithmetic of its own',
      qr_judge.run_settles_at('2026-09-30') == dt(2026, 10, 1, 4, 0),
      qr_judge.run_settles_at('2026-09-30'))

# ── And every flow carries it ────────────────────────────────
# The pin is a property of the RUN, not of whether the routine gates anything,
# so an ungated routine owes the boundary too - it asks runDay() for its
# metrics and its journal exactly like a gated one does.
fid = storage.create_flow('Ungated night routine')['id']
storage.create_flow_step(fid, 'Wind down')
flows = storage.get_flows(TODAY)
mine = [f for f in flows if f['id'] == fid]
check('get_flows ships settles_at on an UNGATED routine', bool(mine)
      and mine[0].get('settles_at'), mine[0].get('settles_at') if mine else None)
check('and it is the served form of the same instant',
      bool(mine) and mine[0]['settles_at'] == qr_judge.run_settles_at(TODAY).isoformat(' '),
      mine[0].get('settles_at') if mine else None)
check('every flow in the payload carries one',
      all(f.get('settles_at') for f in flows), len(flows))

# A read with no date is the routine EDITOR's read, not a run - no day, no pin.
check('a dateless read ships no pin (it is not about a day)',
      all('settles_at' not in f for f in storage.get_flows(None)))

for line in ok + bad:
    print(line)
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
