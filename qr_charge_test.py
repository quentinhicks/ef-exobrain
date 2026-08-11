"""Tests for the gate charging path. Run: python qr_charge_test.py

This file is the reason charging lives here rather than behind an HTTP hop: a
money path on the same box as the database can be driven exhaustively with a
fake Beeminder, and every rail asserted directly.

Each test names the failure it prevents. They are not hypothetical — money left
unexpectedly in 2026-08 through the first two.
"""

import json
import os
import sys
import tempfile

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import qr_judge         # noqa: E402

fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


def fresh(live=True, dryrun=False, cap=2500, default=200, token='t', user='u'):
    """A clean db plus config, with charging armed unless told otherwise."""
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    storage.set_setting('gate_charging_live', '1' if live else '0')
    storage.set_setting('gate_charge_dryrun', '1' if dryrun else '0')
    storage.set_setting('gate_weekly_cap_cents', str(cap))
    storage.set_setting('gate_charge_cents', str(default))
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': token, 'beeminder_user': user}, f)
    nid = storage.qr_create_node('Sleep', 'tok' + os.urandom(4).hex(), '21:00', '22:00')
    if not isinstance(nid, dict):
        nid = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
    return nid


def sender(calls, ok=True, data=None, boom=False):
    def send(url, body):
        calls.append(body)
        if boom:
            raise OSError('connection reset')
        return ok, (data if data is not None else {'id': 'ch_1'})
    return send


def status_of(node_id, date):
    rows = [r for r in storage.qr_charge_rows_between(date, date) if r['node_id'] == node_id]
    return rows[0] if rows else None


# ── the two that took money in 2026-08 ───────────────────────
node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-01', 'absent', sender(calls))
qr_judge.charge_for_failure(node, '2026-08-01', 'absent', sender(calls))
qr_judge.charge_for_failure(node, '2026-08-01', 'absent', sender(calls))
check('a repeated tick charges ONCE (the reservation is the lock)',
      len(calls) == 1, f'{len(calls)} calls')
check('and the day is logged once', status_of(node['id'], '2026-08-01')['charge_status'] == 'succeeded',
      status_of(node['id'], '2026-08-01'))

node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-02', 'absent', sender(calls, boom=True))
row = status_of(node['id'], '2026-08-02')
check('a LOST RESPONSE is unknown, not failed', row['charge_status'] == 'unknown', row)
check('and unknown COUNTS against the cap (money may have moved)',
      storage.qr_weekly_spent_cents('2026-08-02') == 200,
      storage.qr_weekly_spent_cents('2026-08-02'))
calls2 = []
qr_judge.charge_for_failure(node, '2026-08-02', 'absent', sender(calls2))
check('an unknown day is NEVER retried', len(calls2) == 0, f'{len(calls2)} calls')

# ── the cap ──────────────────────────────────────────────────
node = fresh(cap=500, default=200)
calls = []
for d in ('2026-08-03', '2026-08-04', '2026-08-05'):
    qr_judge.charge_for_failure(node, d, 'absent', sender(calls))
check('the cap stops the charge that would breach it', len(calls) == 2, f'{len(calls)} calls')
check('the breaching day is logged capped',
      status_of(node['id'], '2026-08-05')['charge_status'] == 'capped',
      status_of(node['id'], '2026-08-05'))
check('a capped day costs NOTHING (skipped whole, never partial)',
      status_of(node['id'], '2026-08-05')['amount_cents'] is None,
      status_of(node['id'], '2026-08-05'))
check('spend is exactly the two that fired', storage.qr_weekly_spent_cents('2026-08-05') == 400,
      storage.qr_weekly_spent_cents('2026-08-05'))

# ── the four locks, each alone ───────────────────────────────
for label, kw in (('gate_charging_live=0', dict(live=False)),
                  ('no token in config', dict(token='')),
                  ('no beeminder_user', dict(user=''))):
    node = fresh(**kw)
    calls = []
    qr_judge.charge_for_failure(node, '2026-08-06', 'absent', sender(calls))
    row = status_of(node['id'], '2026-08-06')
    check(f'{label} moves no money', len(calls) == 0, f'{len(calls)} calls')
    check(f'{label} still records the judgment', row is not None, row)

node = fresh(dryrun=True)
calls = []
qr_judge.charge_for_failure(node, '2026-08-07', 'absent', sender(calls))
check('dryrun exercises the real pipeline', len(calls) == 1, f'{len(calls)} calls')
check('dryrun tells Beeminder it is a dry run', calls and calls[0].get('dryrun') == '1', calls)
check('and is logged as dryrun', status_of(node['id'], '2026-08-07')['charge_status'] == 'dryrun',
      status_of(node['id'], '2026-08-07'))

# ── a rejected request is not counted ────────────────────────
node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-08', 'absent', sender(calls, ok=False))
row = status_of(node['id'], '2026-08-08')
check('a REJECTED request is failed, not unknown', row['charge_status'] == 'failed', row)
check('and does not count against the cap (nothing was charged)',
      storage.qr_weekly_spent_cents('2026-08-08') == 0,
      storage.qr_weekly_spent_cents('2026-08-08'))

# ── per-gate amounts ─────────────────────────────────────────
node = fresh(default=200)
# Through the REAL write path, not by injecting the value: QR_NODE_FIELDS is an
# allowlist, so a field missing from it is silently dropped.
storage.qr_update_node(node['id'], {'charge_cents': 750})
node2 = [n for n in storage.qr_get_nodes() if n['id'] == node['id']][0]
check('a per-gate stake actually PERSISTS through qr_update_node',
      node2.get('charge_cents') == 750, node2.get('charge_cents'))
calls = []
qr_judge.charge_for_failure(node2, '2026-08-09', 'absent', sender(calls))
check('a per-gate stake overrides the default',
      calls and calls[0]['amount'] == '7.50', calls)
check('and is what the cap counts', storage.qr_weekly_spent_cents('2026-08-09') == 750,
      storage.qr_weekly_spent_cents('2026-08-09'))
s = qr_judge.charge_settings()
check('an UNSET per-gate stake falls back to the default, never to free',
      qr_judge.node_charge_cents({'charge_cents': None}, s) == 200,
      qr_judge.node_charge_cents({'charge_cents': None}, s))

# ── the amount floor ─────────────────────────────────────────
node = fresh(default=40)
calls = []
qr_judge.charge_for_failure(node, '2026-08-10', 'absent', sender(calls))
check('an amount under Beeminder\'s $1 minimum is clamped up, not rejected',
      calls and calls[0]['amount'] == '1.00', calls)

# ── raising a stake is immediate; cutting it waits ───────────
imm, pend = qr_judge.apply_node_patch({'charge_cents': 200}, {'charge_cents': 800})
check('RAISING the stake applies immediately', imm.get('charge_cents') == 800 and not pend, (imm, pend))
imm, pend = qr_judge.apply_node_patch({'charge_cents': 800}, {'charge_cents': 200})
check('CUTTING the stake waits 24h like any other loosening',
      pend.get('charge_cents') == 200 and not imm, (imm, pend))

# Clearing a stake is a move to the DEFAULT, so it waits or not depending on
# which direction that is. Comparing the raw values would let a $9 stake be
# cleared down to a $2 default with no delay.
node = fresh(default=200)
imm, pend = qr_judge.apply_node_patch({'charge_cents': 800}, {'charge_cents': None})
check('CLEARING a stake above the default still waits 24h',
      pend.get('charge_cents') is None and 'charge_cents' in pend and not imm, (imm, pend))
imm, pend = qr_judge.apply_node_patch({'charge_cents': 100}, {'charge_cents': None})
check('clearing a stake BELOW the default applies at once (it is a raise)',
      'charge_cents' in imm and not pend, (imm, pend))
imm, pend = qr_judge.apply_node_patch({'charge_cents': None}, {'charge_cents': 100})
check('setting a stake below the default waits (it is a cut)',
      pend.get('charge_cents') == 100 and not imm, (imm, pend))

# ── verify_token never leaks, and catches a mismatch ─────────
def me(ok=True, username='u'):
    def send(url):
        return ok, {'username': username}
    return send

node = fresh(token='secret-token', user='u')
v = qr_judge.verify_token(me())
check('a good token verifies', v['valid'] and v['username'] == 'u', v)
check('verification never returns the token itself',
      'secret-token' not in json.dumps(v), v)
check('a token belonging to someone else is refused',
      qr_judge.verify_token(me(username='someone_else'))['valid'] is False,
      qr_judge.verify_token(me(username='someone_else')))
check('a rejected token is invalid', qr_judge.verify_token(me(ok=False))['valid'] is False,
      qr_judge.verify_token(me(ok=False)))
node = fresh(token='')
check('no token configured reads as invalid, not as an error',
      qr_judge.verify_token(me())['valid'] is False, qr_judge.verify_token(me()))

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
