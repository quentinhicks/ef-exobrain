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
    # What the day cost, as the split prices it. amount_cents is only written
    # when money actually moves (these fixtures run with charging off), so the
    # figure comes from the CREDIT the judgment recorded against the stake —
    # the same arithmetic charge_for_failure does.
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
# — which for a gate with a routine is midnight plus ROUTINE_GRACE_HOURS. Left
# as a bare judge(), the suite passed by day and failed between midnight and
# 04:00, which is a tripwire that lies for four hours a night.
SETTLED = datetime.fromisoformat(date_cls.today().isoformat() + 'T09:00:00')

# ── through judge() ──────────────────────────────────────────
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
check('SCANNED but routine undone now FAILS — the gate the panel promised',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge(now=SETTLED)
check('scanned AND routine done in time passes', reason_for(nid, YESTERDAY) is None,
      reason_for(nid, YESTERDAY))

# ── the stake SPLITS between the two halves (2026-08-22) ─────
#
# This reverses the 2026-08-15 rule that either half missed at its own deadline
# lost the whole day. It left a missed morning with no reason to do the routine
# at all, which is the half actually worth doing. Now each half is worth half
# the stake, and only both-on-time pays nothing.
#
# Scanned, routine done LATE (its deadline is the gate's close, 08:00, so 08:30
# is late). The scan half is earned; the routine half is not.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
complete(flow['id'], YESTERDAY, '08:30')
qr_judge.judge(now=SETTLED)
check('a routine finished AFTER its deadline no longer loses the WHOLE day',
      reason_for(nid, YESTERDAY) == 'routine_late', reason_for(nid, YESTERDAY))
check('...it costs half the stake, because the scan half was met',
      cents_for(nid, YESTERDAY) == 100, cents_for(nid, YESTERDAY))

# Scanned, routine NEVER done: same half owed, different reason — one says the
# routine ran late, the other that it never ran.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b2', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('scanned but the routine never ran also costs half',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY))
      == ('routine_incomplete', 100),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))

# NOT scanned, routine done late in the day: the routine half is earned however
# late it was, which is the incentive the whole change exists to create.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b3', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
complete(flow['id'], YESTERDAY, '21:40')
qr_judge.judge(now=SETTLED)
check('a routine done at 21:40 on a 08:00 gate still earns its half back',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)) == ('absent', 100),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))

# Neither half: the whole stake, as before.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b4', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
qr_judge.judge(now=SETTLED)
check('neither half met still costs the whole stake',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)) == ('absent', 200),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))

# Both on time: nothing owed, and the row is the freeze's judged success.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b5', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge(now=SETTLED)
check('both halves on time is the only way to pay nothing',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# ── and the DAY has to end before any of that can be said ────
#
# The routine can earn its half until midnight, so a gate with a routine is no
# longer judged when its scan window shuts. (Before this, a routine missed at
# its own deadline was judged on the spot — which would now charge the full
# stake for a routine that was about to be done, and a judged day is FROZEN.)
fresh()
TODAY = date_cls.today().isoformat()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6c', '20:00', '23:00')
flow = storage.create_flow('Night routine')
storage.update_flow(flow['id'], qr_node_id=nid, offset_min=-240)
at_2000 = datetime.fromisoformat(f'{TODAY}T20:00:00')
qr_judge.judge(now=at_2000)
check('the routine deadline passing no longer judges the day',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
qr_judge.judge(now=datetime.fromisoformat(f'{TODAY}T23:01:00'))
check('...nor does the scan window closing, while the day can still change',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
# The routine, done at 23:30 — after both deadlines, still inside the day.
complete(flow['id'], TODAY, '23:30')
qr_judge.judge(now=datetime.fromisoformat(f'{TODAY}T23:59:00'))
check('...still not judged one minute before midnight',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
tomorrow = (date_cls.today() + timedelta(days=1)).isoformat()
qr_judge.judge(now=datetime.fromisoformat(f'{tomorrow}T04:05:00'))
check('once the day is over AND the grace is out, the late routine earned its half',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('absent', 100),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

# A gate with NO routine is unchanged: nothing about it can still move once the
# window shuts, so it is judged then, exactly as it always was.
fresh()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6d', '20:00', '23:00')
qr_judge.judge(now=datetime.fromisoformat(f'{TODAY}T23:01:00'))
check('a gate with no routine is still judged the moment its window closes',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('absent', 200),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-7', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge(now=SETTLED)
check('routine done but NEVER SCANNED still reads as absent, not as the routine',
      reason_for(nid, YESTERDAY) == 'absent', reason_for(nid, YESTERDAY))
check('...and costs half, since the routine half was met',
      cents_for(nid, YESTERDAY) == 100, cents_for(nid, YESTERDAY))

# Unlinking has to actually release the gate, or a removed requirement keeps
# failing days forever — but it is an EASING, so it releases in 24h and not
# tonight. This test asserted the instant release and had been failing since the
# 24h rule reached routines; the rule is the intended behaviour, so the
# assertion moved rather than the code.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-8', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.update_flow(flow['id'], qr_node_id=None)
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('unlinking the routine does NOT release the gate tonight',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-8b', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.update_flow(flow['id'], qr_node_id=None)
elapse(flow['id'])                               # the 24h elapses
scan(nid, YESTERDAY)
qr_judge.judge(now=SETTLED)
check('…and once the 24h is up, it does',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# Deleting the routine outright is the same release.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-9', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
# DELETING a gated routine is a larger easing than unlinking it, and unlinking
# already waits 24h. This door had no check at all — '×' at 20:55 released a
# 21:00 deadline outright.
check('deleting a gated routine is DEFERRED, not done', storage.delete_flow(flow['id']))
scan(nid, YESTERDAY)
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
nid = storage.qr_create_node('Wake', 'tok-wake-10', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
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
