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


def reason_for(node_id, ymd):
    rows = [r for r in storage.qr_charge_rows_between(ymd, ymd) if r['node_id'] == node_id]
    return rows[0]['failure_reason'] if rows else None


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

# ── through judge() ──────────────────────────────────────────
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-4', '06:00', '08:00')
scan(nid, YESTERDAY)
qr_judge.judge()
check('a scanned gate with no routine passes (no failure row)',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-5', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
qr_judge.judge()
check('SCANNED but routine undone now FAILS — the gate the panel promised',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge()
check('scanned AND routine done in time passes', reason_for(nid, YESTERDAY) is None,
      reason_for(nid, YESTERDAY))

# ── each half has its OWN deadline (2026-08-15) ──────────────
# Done, but after the routine was due. The routine's deadline here is the gate's
# close (it has no window of its own and no offset), so 08:30 is late.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
complete(flow['id'], YESTERDAY, '08:30')
qr_judge.judge()
check('a routine finished AFTER its deadline does not save the day',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

# The routine falls due before the scan window closes (offset_min = -240 on a
# 20:00–23:00 gate → due 19:00). At 20:00 the scan still has three hours, but
# the routine's clock has run out and the day is already lost.
fresh()
TODAY = date_cls.today().isoformat()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6c', '20:00', '23:00')
flow = storage.create_flow('Night routine')
storage.update_flow(flow['id'], qr_node_id=nid, offset_min=-240)
at_2000 = datetime.fromisoformat(f'{TODAY}T20:00:00')
qr_judge.judge(now=at_2000)
check('a routine missed at ITS deadline fails the gate while the scan window is'
      ' still open', reason_for(nid, TODAY) == 'routine_incomplete', reason_for(nid, TODAY))

# …and the same day, done in time, is not judged early: the scan still has
# until 23:00 to happen.
fresh()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6d', '20:00', '23:00')
flow = storage.create_flow('Night routine')
storage.update_flow(flow['id'], qr_node_id=nid, offset_min=-240)
complete(flow['id'], TODAY, '18:30')
qr_judge.judge(now=at_2000)
check('a routine done in time leaves the scan window alone',
      reason_for(nid, TODAY) is None, reason_for(nid, TODAY))
qr_judge.judge(now=datetime.fromisoformat(f'{TODAY}T23:01:00'))
check('…and once the scan window closes unscanned, THAT is the failure',
      reason_for(nid, TODAY) == 'absent', reason_for(nid, TODAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-7', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
complete(flow['id'], YESTERDAY, '07:30')
qr_judge.judge()
check('routine done but NEVER SCANNED still reads as absent, not as the routine',
      reason_for(nid, YESTERDAY) == 'absent', reason_for(nid, YESTERDAY))

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
qr_judge.judge()
check('unlinking the routine does NOT release the gate tonight',
      reason_for(nid, YESTERDAY) == 'routine_incomplete', reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-8b', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.update_flow(flow['id'], qr_node_id=None)
conn = sqlite3.connect(storage.DB_PATH)          # the 24h elapses
conn.execute("""UPDATE flow SET pending = replace(pending, substr(pending,
                instr(pending, '"apply_at": "') + 13, 26), '2000-01-01T00:00:00')
                WHERE id = ?""", (flow['id'],))
conn.commit()
conn.close()
scan(nid, YESTERDAY)
qr_judge.judge()
check('…and once the 24h is up, it does',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# Deleting the routine outright is the same release.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-9', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.delete_flow(flow['id'])
scan(nid, YESTERDAY)
qr_judge.judge()
check('deleting the routine releases it too',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# The reservation is still the lock: re-judging must not double-log.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-10', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
scan(nid, YESTERDAY)
qr_judge.judge()
qr_judge.judge()
rows = [r for r in storage.qr_charge_rows_between(YESTERDAY, YESTERDAY) if r['node_id'] == nid]
check('re-running the judge logs the routine failure once', len(rows) == 1, len(rows))


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
qr_judge.judge()
check('a day the gate did not apply to is not judged',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
# Adding a day is a TIGHTENING, so it applies at once — and used to reach back.
storage.qr_update_node(nid, {'days_of_week': '0123456'})
qr_judge.judge()
check('adding a run-day today does not charge for yesterday',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Sleep', 'tok-freeze-2', '21:00', '23:00')
scan(nid, YESTERDAY, '22:00')
qr_judge.judge()
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
qr_judge.judge()
check('narrowing the window afterwards does not re-judge a closed day',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
check('and the day still reads success',
      [o['outcome'] for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
       if o['node_id'] == nid] == ['success'])

# The backfill reaches further than the two-day window, but never with money.
fresh()
FOUR = (date_cls.today() - timedelta(days=4)).isoformat()
nid = storage.qr_create_node('Down', 'tok-freeze-3', '06:00', '08:00')
qr_judge.judge()
rows = [r for r in storage.qr_charge_rows_between(FOUR, FOUR) if r['node_id'] == nid]
check('a day older than the money reach is judged',
      len(rows) == 1, rows)
check('and is logged stale, so the cap and the card never see it',
      rows and rows[0]['charge_status'] == 'stale' and rows[0]['amount_cents'] is None,
      rows)

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
