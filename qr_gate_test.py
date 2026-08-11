"""The routine gate: a linked routine is half of what decides a gate.

Run: python qr_gate_test.py

This file exists because the gate was CLAIMED and not enforced. The app pushed
routine flags to the Cloudflare Worker, whose judge was disarmed on 2026-08-08,
so the panel promised "the gate fails unless this routine is done" while
qr_judge only ever checked presence. The tests below are the enforcement.
"""

import os
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
storage.upsert_flow_run(flow['id'], YESTERDAY, '{}', True)
qr_judge.judge()
check('scanned AND routine done passes', reason_for(nid, YESTERDAY) is None,
      reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-7', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.upsert_flow_run(flow['id'], YESTERDAY, '{}', True)
qr_judge.judge()
check('routine done but NEVER SCANNED still reads as absent, not as the routine',
      reason_for(nid, YESTERDAY) == 'absent', reason_for(nid, YESTERDAY))

# Unlinking has to actually release the gate, or a removed requirement keeps
# failing days forever.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-8', '06:00', '08:00')
flow = storage.create_flow('Morning routine')
storage.update_flow(flow['id'], qr_node_id=nid)
storage.update_flow(flow['id'], qr_node_id=None)
scan(nid, YESTERDAY)
qr_judge.judge()
check('unlinking the routine releases the gate',
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

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
