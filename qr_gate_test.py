"""The routine gate: a linked routine is half of what decides a gate.

Run: python qr_gate_test.py

This file exists because the gate was CLAIMED and not enforced. The app pushed
routine flags to the Cloudflare Worker, whose judge was disarmed on 2026-08-08,
so the panel promised "the gate fails unless this routine is done" while
qr_judge only ever checked presence. The tests below are the enforcement.
"""

import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls, datetime, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import qr_judge         # noqa: E402

fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


def fresh():
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    storage.set_setting('gate_charging_live', '0')


YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()


def scan(node_id, ymd, hhmm='07:00', geo_pass=None):
    # The scan server writes UTC with a trailing Z, and the judge compares
    # against the same shape — a local-time scan would fall outside its own
    # window, which is the bug this format exists to prevent.
    local = datetime.fromisoformat(f'{ymd}T{hhmm}:00')
    utc = local.astimezone(None).utctimetuple()
    iso = datetime(*utc[:6]).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    storage.qr_log_scan(node_id, iso, None, None, geo_pass)


def complete(flow_id, ymd, hhmm):
    """Finish a run at a LOCAL wall-clock time on that date.

    upsert_flow_run stamps completed_at with the clock NOW, which for a
    yesterday-dated fixture is always late — and since 2026-08-15 the judge
    asks WHEN a routine was done, not merely whether. So the stamp is written
    explicitly, in the shape storage writes it (UTC, offset-aware).
    """
    storage.upsert_flow_run(flow_id, ymd, '{}', True)
    local = datetime.fromisoformat(f'{ymd}T{hhmm}:00')
    iso = datetime.utcfromtimestamp(local.timestamp()).isoformat() + '+00:00'
    conn = sqlite3.connect(storage.DB_PATH)
    conn.execute('UPDATE flow_run SET completed_at = ? WHERE flow_id = ? AND date = ?',
                 (iso, flow_id, ymd))
    conn.commit()
    conn.close()


def elapse(flow_id, kind='flow'):
    """Run the 24h clock out on every easing queued for a row."""
    conn = sqlite3.connect(storage.DB_PATH)
    conn.execute(
        'UPDATE easing_pending SET apply_at = ? WHERE kind = ? AND row_id = ?',
        ('2000-01-01T00:00:00', kind, flow_id))
    conn.commit()
    conn.close()


def _date_plus_day(ymd):
    return (date_cls.fromisoformat(ymd) + timedelta(days=1)).isoformat()


def reason_for(node_id, ymd):
    rows = [r for r in storage.qr_charge_rows_between(ymd, ymd) if r['node_id'] == node_id]
    return rows[0]['failure_reason'] if rows else None


def cents_for(node_id, ymd):
    # What the day cost. amount_cents is only written when money actually moves
    # (these fixtures run with charging off), so the figure comes from the stake
    # against the credit the judgment recorded — the same arithmetic
    # charge_for_failure does. Since 2026-09-02 that credit is only ever 0 on a
    # failure, so this is the whole stake or nothing; the expression is left as
    # it is because the rows frozen under the split still carry 50.
    rows = [r for r in storage.qr_charge_rows_between(ymd, ymd) if r['node_id'] == node_id]
    if not rows:
        return None
    stake = qr_judge.node_charge_cents(
        [n for n in storage.qr_get_nodes() if n['id'] == node_id][0],
        qr_judge.charge_settings())
    return int(stake * (1 - (rows[0]['credit_pct'] or 0) / 100.0))


# ── the predicate ────────────────────────────────────────────
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-1', '06:00', '08:00')
check('a gate with no routine linked is gated by nothing',
      storage.routine_gate_for_node(nid, YESTERDAY) is None,
      storage.routine_gate_for_node(nid, YESTERDAY))

flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
check('linking one makes the gate answer False until it is done',
      storage.routine_gate_for_node(nid, YESTERDAY) is False,
      storage.routine_gate_for_node(nid, YESTERDAY))

storage.upsert_flow_run(flow['id'], YESTERDAY, '{}', True)
check('completing it answers True', storage.routine_gate_for_node(nid, YESTERDAY) is True,
      storage.routine_gate_for_node(nid, YESTERDAY))
check('and only for THAT date — a routine done yesterday does not pass today',
      storage.routine_gate_for_node(nid, date_cls.today().isoformat()) is False,
      storage.routine_gate_for_node(nid, date_cls.today().isoformat()))

# A partial run is not a done run: upsert_flow_run stamps completed_at only on
# the last credit, so resuming mid-routine must not open the gate.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-2', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.upsert_flow_run(flow['id'], YESTERDAY, '{"1": "07:01"}', False)
check('a PARTIAL run does not satisfy the gate',
      storage.routine_gate_for_node(nid, YESTERDAY) is False,
      storage.routine_gate_for_node(nid, YESTERDAY))

# before_node_id is a DEADLINE reference, not a gate (2026-08-10).
fresh()
gated = storage.qr_create_node('Wake', 'tok-wake-3', '06:00', '08:00')
other = storage.qr_create_node('Sleep', 'tok-sleep-3', '21:00', '22:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], before_node_id=other)
check('a routine that only REFERENCES a gate as a deadline gates nothing',
      storage.routine_gate_for_node(other, YESTERDAY) is None,
      storage.routine_gate_for_node(other, YESTERDAY))

# WHEN THESE RUN, not when the clock says. Every block below judges YESTERDAY
# and reads the row back, so it needs a `now` past the moment yesterday settles
# — which for a ROUTINE gate is midnight plus ROUTINE_GRACE_HOURS. Left as a
# bare judge(), the suite passed by day and failed between midnight and 04:00,
# which is a tripwire that lies for four hours a night.
SETTLED = datetime.fromisoformat(date_cls.today().isoformat() + 'T09:00:00')
TODAY = date_cls.today().isoformat()


def routine_gate(label, token, flow_name='Morning routine'):
    """A gate whose PROOF is its routine. Returns (node_id, flow)."""
    nid = storage.qr_create_node(label, token, '06:00', '08:00')
    flow = storage.create_flow(flow_name)
    storage.update_flow(flow['id'], qr_node_id=nid)
    # Straight to the column: the 24h easing road has its own tests, and this is
    # a fixture, not a change of mind.
    storage.qr_update_node(nid, {'proof_mode': 'routine'})
    # WITH A SCHEDULE SOURCE, deliberately. applies_on returns early on the
    # source branch, and the "no routine, so it does not run" check was once
    # written BELOW that return - which made it unreachable for every gate the
    # app actually creates, while a sourceless test fixture passed anyway.
    storage.qr_ensure_node_source(nid)
    return nid, flow


def node_row(nid):
    return [n for n in storage.qr_get_nodes() if n['id'] == nid][0]


# ── through judge(): A SCAN GATE IS JUDGED ON ITS SCAN (2026-09-02) ────
#
# This REVERSES the 50/50 split of 2026-08-22 and the coupled rule before it.
# A gate has ONE proof. A routine linked to a scan gate is a deadline reference
# and a place in the runner; it is not half of this gate's price, and it can no
# longer fail this gate or delay its judgment.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-4', '06:00', '08:00')
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('a scanned gate with no routine passes (no failure row)',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-5', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('SCANNED but routine undone PASSES — the routine is not this gate',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge(now=SETTLED)
check('and the routine done without a scan earns the scan gate nothing',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)) == ('absent', 200),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))

# THERE IS NO HALF ANY MORE. Whatever the routine did, the scan gate costs the
# whole stake or nothing — the two prices a single proof can have.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
complete(flow['id'], YESTERDAY, '08:30')
qr_judge.judge(now=SETTLED)
check('no partial price survives: a missed scan is the whole stake',
      cents_for(nid, YESTERDAY) == 200, cents_for(nid, YESTERDAY))
check('...and credit_pct is stamped 0, never 50',
      storage.qr_charge_rows_between(YESTERDAY, YESTERDAY)[0]['credit_pct'] == 0,
      storage.qr_charge_rows_between(YESTERDAY, YESTERDAY)[0]['credit_pct'])

# A SCAN GATE IS JUDGED WHEN ITS WINDOW SHUTS, again. Waiting for the day to end
# was the split's timing rule, and it existed only because a routine could still
# earn half after the window closed. Nothing can now, so nothing waits.
fresh()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6c', '20:00', '23:00')
flow = storage.create_flow('Night routine')
storage.update_flow(flow['id'], qr_node_id=nid, offset_min=-240)
qr_judge.judge(now=datetime.fromisoformat(TODAY + 'T23:01:00'))
check('a linked routine no longer delays a scan gate past its close',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('absent', 200),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

fresh()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6d', '20:00', '23:00')
qr_judge.judge(now=datetime.fromisoformat(TODAY + 'T23:01:00'))
check('and a gate with no routine is judged the moment its window closes',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('absent', 200),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

# ── A ROUTINE GATE: the wall day, and no deadline inside it ──────────
#
# (2026-09-02, Quentin's instruction.) Its commitment is "done at all, on the
# day it was owed". There is no clock time inside the day at which that can be
# said, so it settles at the day's end plus the grace — the same instant a run
# stops being able to earn its day.
fresh()
nid, flow = routine_gate('Morning', 'tok-rg-1')
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge(now=SETTLED)
check('a routine gate whose routine was done passes',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid, flow = routine_gate('Morning', 'tok-rg-2')
qr_judge.judge(now=SETTLED)
check('a routine gate whose routine was NOT done costs the whole stake',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY))
      == ('routine_incomplete', 200),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))

# LATE IS NOT A FAILURE. The gate's window is 06:00-08:00 and the routine was
# finished at 23:40; there is no 'routine_late' any more, because there is no
# deadline for it to be late against.
fresh()
nid, flow = routine_gate('Morning', 'tok-rg-3')
complete(flow['id'], YESTERDAY, '23:40')
qr_judge.judge(now=SETTLED)
check('a routine finished at 23:40 on an 06:00-08:00 gate still earns the day',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# A SCAN CANNOT CLEAR IT. The proof is the routine and nothing else — the same
# exclusivity 'tag' has, one proof kind along.
fresh()
nid, flow = routine_gate('Morning', 'tok-rg-4')
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('scanning a routine gate does not clear it',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

# THE TIMING. Judged neither at the window's close nor at midnight, but at
# midnight plus the grace — so a routine finished at 00:05 still earns its day.
fresh()
nid, flow = routine_gate('Night', 'tok-rg-5')
qr_judge.judge(now=datetime.fromisoformat(TODAY + 'T08:01:00'))
check('a routine gate is not judged when its window closes',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
qr_judge.judge(now=datetime.fromisoformat(TODAY + 'T23:59:00'))
check('...nor one minute before midnight',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
tomorrow = (date_cls.today() + timedelta(days=1)).isoformat()
qr_judge.judge(now=datetime.fromisoformat(tomorrow + 'T03:59:00'))
check('...nor inside the grace, where a run can still be finished',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
check('settle_after says the same instant run_settles_at does',
      qr_judge.settle_after(node_row(nid), TODAY, None, ('06:00', '08:00', 0))
      == qr_judge.run_settles_at(TODAY))
qr_judge.judge(now=datetime.fromisoformat(tomorrow + 'T04:05:00'))
check('...and once the grace is out, the undone routine is charged',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('routine_incomplete', 200),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

# A ROUTINE GATE WITH NO ROUTINE DOES NOT RUN. Unlinking is an easing, so it
# takes 24h; once it lands, applies_on stops answering for the gate at all and
# the day is frozen 'n/a' — judged and never charged. A gate nothing can clear
# must not be a daily charge, which is the same rule that refuses the mode at
# the door in the first place.
fresh()
nid, flow = routine_gate('Morning', 'tok-rg-6')
storage.update_flow(flow['id'], qr_node_id=None)
qr_judge.judge(now=SETTLED)
check('unlinking does NOT release a routine gate tonight',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

fresh()
nid, flow = routine_gate('Morning', 'tok-rg-7')
storage.update_flow(flow['id'], qr_node_id=None)
elapse(flow['id'])                               # the 24h elapses
check('...and once it is up the gate stops running at all',
      qr_judge.applies_on(node_row(nid), YESTERDAY) is False,
      qr_judge.applies_on(node_row(nid), YESTERDAY))
qr_judge.judge(now=SETTLED)
check('...so the day is frozen n/a rather than charged',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)) == (None, None),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))


# Deleting the routine outright is the same release.
fresh()
nid, flow = routine_gate('Morning', 'tok-wake-9')
# DELETING a gated routine is a larger easing than unlinking it, and unlinking
# already waits 24h. This door had no check at all — '×' at 20:55 released a
# 21:00 deadline outright.
check('deleting a gated routine is DEFERRED, not done', storage.delete_flow(flow['id']))
qr_judge.judge(now=SETTLED)
check('so it does not release the gate tonight',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))
elapse(flow['id'])
conn = storage.get_conn()
storage.apply_due_flow_pendings(conn)
conn.close()
check('…and once the 24h is up, the routine is gone',
      not [f for f in storage.get_flows() if f['id'] == flow['id']])

# The reservation is still the lock: re-judging must not double-log.
fresh()
nid, flow = routine_gate('Morning', 'tok-wake-10')
qr_judge.judge(now=SETTLED)
qr_judge.judge(now=SETTLED)
rows = [r for r in storage.qr_charge_rows_between(YESTERDAY, YESTERDAY) if r['node_id'] == nid]
check('re-running the judge logs the routine failure once', len(rows) == 1, len(rows))


# ── THE EASING REGIME IS AN ALLOWLIST (2026-08-17) ───────────────────────
#
# is_loosening fell through to False, so it was an opt-in BLACKLIST: any field
# nobody had written a branch for applied instantly on the money path.

fresh()
nid = storage.qr_create_node('Sleep', 'tok-ease-1', '21:00', '23:00',
                             lat=40.0, lng=-75.0, radius=100)
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
imm, pend = qr_judge.apply_node_patch(node, {'active': False})
check('switching a gate OFF waits 24h, like the /disable route always did',
      pend == {'active': False} and not imm, (imm, pend))
imm, pend = qr_judge.apply_node_patch(dict(node, active=0), {'active': True})
check('turning one back ON is tightening and applies now',
      imm == {'active': True} and not pend, (imm, pend))
imm, pend = qr_judge.apply_node_patch(node, {'geofence_lat': None})
check('CLEARING the geofence waits — it makes any scan anywhere satisfy',
      pend == {'geofence_lat': None}, (imm, pend))
imm, pend = qr_judge.apply_node_patch(node, {'geofence_lat': 41.0})
check('and moving it waits too', pend == {'geofence_lat': 41.0}, (imm, pend))
imm, pend = qr_judge.apply_node_patch(dict(node, geofence_lat=None),
                                      {'geofence_lat': 41.0})
check('adding a fence where there was none is tightening',
      imm == {'geofence_lat': 41.0}, (imm, pend))
imm, pend = qr_judge.apply_node_patch(node, {'label': 'Renamed'})
check('a rename is not a commitment change', imm == {'label': 'Renamed'}, (imm, pend))

# ── PENDINGS ARE PER FIELD ───────────────────────────────────────────────
fresh()
nid = storage.qr_create_node('Sleep', 'tok-ease-2', '21:00', '23:00')
flow = storage.create_flow('Night routine')
storage.update_flow(flow['id'], qr_node_id=nid, offset_min=-60)
storage.update_flow(flow['id'], qr_node_id=None)          # easing 1: unlink
storage.update_flow(flow['id'], offset_min=30)            # easing 2: later offset
f = [x for x in storage.get_flows(TODAY) if x['id'] == flow['id']][0]
fields = sorted(p['field'] for p in (f['pending'] or []))
check('queueing a second easing does not delete the first',
      fields == ['offset_min', 'qr_node_id'], fields)

# ── THE DEADLINE IS SERVED (2026-08-17) ──────────────────────────────────
#
# app.js used to compute this itself from (src.intervals || [])[0]. But
# day_intervals is CLIPPED and sorted by start, so a 23:00→07:00 routine's
# from_previous TAIL sorts first: the client read the window as 00:00–07:00 and
# showed the routine due this morning, overdue all day, while the judge charged
# against 07:00 the NEXT morning. Display and the money path must not disagree.
fresh()
nid = storage.qr_create_node('Sleep', 'tok-cross', '21:00', '23:00')
flow = storage.create_flow('Night')
past = (date_cls.today() - timedelta(days=30)).isoformat()
src = storage.create_schedule_source(
    kind='rule', title='Night window', start=f'{past}T23:00:00', duration='PT8H',
    recurrenceRules=[{'frequency': 'daily'}])
storage.update_flow(flow['id'], qr_node_id=nid,
                    source_uid=src['uid'] if isinstance(src, dict) else src)
f = [x for x in storage.get_flows(TODAY) if x['id'] == flow['id']][0]
check('a routine window across midnight opens at 23:00, not at the clipped tail',
      f['window_open_min'] == 23 * 60, f['window_open_min'])
check('and is due 07:00 TOMORROW — past 1440, which the tail lost',
      f['due_min'] == 31 * 60, f['due_min'])
check('the served deadline is the one the judge charges against',
      qr_judge.routine_deadline(None, f, TODAY).isoformat()
      == f'{_date_plus_day(TODAY)}T07:00:00',
      qr_judge.routine_deadline(None, f, TODAY))

# ── THE FREEZE (2026-08-17) ──────────────────────────────────────────────
#
# A closed day is decided when it closes. It used to stay derived from its
# scans, so it was re-resolved every tick under whatever the configuration
# said by then — and tightenings apply immediately, so a rule written today
# reached back and charged for a day that was never a commitment.

fresh()
DOW_YDAY = str(date_cls.fromisoformat(YESTERDAY).weekday())
OTHER = ''.join(d for d in '0123456' if d != DOW_YDAY)
nid = storage.qr_create_node('Weekday only', 'tok-freeze-1', '06:00', '08:00',
                             days=OTHER)
qr_judge.judge(now=SETTLED)
check('a day the gate did not apply to is not judged',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
# Adding a day is a TIGHTENING, so it applies at once — and used to reach back.
storage.qr_update_node(nid, {'days_of_week': '0123456'})
qr_judge.judge(now=SETTLED)
check('adding a run-day today does not charge for yesterday',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Sleep', 'tok-freeze-2', '21:00', '23:00')
scan(nid, YESTERDAY, '22:00')
qr_judge.judge(now=SETTLED)
check('a satisfied day is judged, not merely left alone',
      storage.qr_judgment_exists(nid, YESTERDAY))
check('and it stays out of the FAILURE log',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
check('outcomes reads it back as success',
      [o['outcome'] for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
       if o['node_id'] == nid] == ['success'])
# The window that judged it is stamped, so narrowing the gate now cannot
# re-resolve a closed day into a failure.
storage.qr_update_node(nid, {'window_start': '06:00', 'window_end': '07:00'})
qr_judge.judge(now=SETTLED)
check('narrowing the window afterwards does not re-judge a closed day',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
check('and the day still reads success',
      [o['outcome'] for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
       if o['node_id'] == nid] == ['success'])

# The backfill reaches further than the two-day window, but never with money.
fresh()
FOUR = (date_cls.today() - timedelta(days=4)).isoformat()
nid = storage.qr_create_node('Down', 'tok-freeze-3', '06:00', '08:00')
qr_judge.judge(now=SETTLED)
rows = [r for r in storage.qr_charge_rows_between(FOUR, FOUR) if r['node_id'] == nid]
check('a day older than the money reach is judged',
      len(rows) == 1, rows)
check('and is logged stale, so the cap and the card never see it',
      rows and rows[0]['charge_status'] == 'stale' and rows[0]['amount_cents'] is None,
      rows)

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
