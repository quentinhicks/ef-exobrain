"""Tests for the gate charging path. Run: python qr_charge_test.py

This file is the reason charging lives here rather than behind an HTTP hop: a
money path on the same box as the database can be driven exhaustively with a
fake Beeminder, and every rail asserted directly.

Each test names the failure it prevents. They are not hypothetical — money left
unexpectedly in 2026-08 through the first two, and on 2026-09-30 through the
shape the COMMITMENT section exists to end: a past day re-read under the
settings as they were later.
"""

import json
import os
import sys
import tempfile
from datetime import datetime, date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import qr_judge         # noqa: E402

fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


def fresh(armed=True, cap=2500, default=200, token='t', user='u'):
    """A clean db plus config, armed unless told otherwise, with one gate."""
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    # ONE SWITCH (2026-10-01): the arming stamp, plus the credentials.
    storage.set_setting('gate_charging_armed_at', '2026-09-29T12:00:00' if armed else '')
    storage.set_setting('gate_weekly_cap_cents', str(cap))
    storage.set_setting('gate_charge_cents', str(default))
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': token, 'beeminder_user': user}, f)
    nid = storage.qr_create_node('Sleep', 'tok' + os.urandom(4).hex(), '21:00', '22:00')
    return node_row(nid)


def node_row(nid):
    return [n for n in storage.qr_get_nodes() if n['id'] == nid][0]


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


def judged(node_id, date):
    # The whole ledger: status_of reads failure rows only, and 'n/a' is not one.
    r = [r for r in storage.qr_ledger_between(date, date) if r['node_id'] == node_id]
    return r[0]['charge_status'] if r else None


# ── the two that took money in 2026-08 ───────────────────────
node = fresh()
calls = []
for _ in range(3):
    qr_judge.charge_for_failure(node, '2026-08-01', 'absent', 200, sender(calls))
check('a repeated tick charges ONCE (the reservation is the lock)',
      len(calls) == 1, f'{len(calls)} calls')
check('and the day is logged once', status_of(node['id'], '2026-08-01')['charge_status'] == 'succeeded',
      status_of(node['id'], '2026-08-01'))

node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-02', 'absent', 200, sender(calls, boom=True))
row = status_of(node['id'], '2026-08-02')
check('a LOST RESPONSE is unknown, not failed', row['charge_status'] == 'unknown', row)
check('and unknown COUNTS against the cap (money may have moved)',
      storage.qr_weekly_spent_cents('2026-08-02') == 200,
      storage.qr_weekly_spent_cents('2026-08-02'))
calls2 = []
qr_judge.charge_for_failure(node, '2026-08-02', 'absent', 200, sender(calls2))
check('an unknown day is NEVER retried', len(calls2) == 0, f'{len(calls2)} calls')

# ── the cap ──────────────────────────────────────────────────
node = fresh(cap=500, default=200)
calls = []
for d in ('2026-08-03', '2026-08-04', '2026-08-05'):
    qr_judge.charge_for_failure(node, d, 'absent', 200, sender(calls))
check('the cap stops the charge that would breach it', len(calls) == 2, f'{len(calls)} calls')
check('the breaching day is logged capped',
      status_of(node['id'], '2026-08-05')['charge_status'] == 'capped',
      status_of(node['id'], '2026-08-05'))
check('a capped day costs NOTHING (skipped whole, never partial)',
      status_of(node['id'], '2026-08-05')['amount_cents'] is None,
      status_of(node['id'], '2026-08-05'))
check('spend is exactly the two that fired', storage.qr_weekly_spent_cents('2026-08-05') == 400,
      storage.qr_weekly_spent_cents('2026-08-05'))

# ── what money needs: a stake, the switch, the credentials ───
for label, kw, staked in (('not armed', dict(armed=False), 200),
                          ('no token in config', dict(token=''), 200),
                          ('no beeminder_user', dict(user=''), 200),
                          ('nothing staked when the window opened', {}, None)):
    node = fresh(**kw)
    calls = []
    qr_judge.charge_for_failure(node, '2026-08-06', 'absent', staked, sender(calls))
    row = status_of(node['id'], '2026-08-06')
    check(f'{label}: no money moves', len(calls) == 0, f'{len(calls)} calls')
    check(f'{label}: the day is still judged, as would_fire',
          row is not None and row['charge_status'] == 'would_fire', row)
node = fresh(token='')
check("armed with no credentials is not reported live",
      qr_judge.charge_settings()['live'] is False, qr_judge.charge_settings())
node = fresh()
check('there is no dry run any more: a charge is never sent with dryrun set',
      'dryrun' not in qr_judge.charge_settings(), qr_judge.charge_settings())

# ── a rejected request is not counted ────────────────────────
node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-08', 'absent', 200, sender(calls, ok=False))
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
node2 = node_row(node['id'])
check('a per-gate stake actually PERSISTS through qr_update_node',
      node2.get('charge_cents') == 750, node2.get('charge_cents'))
s = qr_judge.charge_settings()
check('the per-gate stake is what a commitment stakes',
      qr_judge.node_charge_cents(node2, s) == 750, qr_judge.node_charge_cents(node2, s))
check('an UNSET per-gate stake falls back to the default, never to free',
      qr_judge.node_charge_cents({'charge_cents': None}, s) == 200,
      qr_judge.node_charge_cents({'charge_cents': None}, s))
calls = []
qr_judge.charge_for_failure(node2, '2026-08-09', 'absent', 750, sender(calls))
check('the staked amount is what is billed', calls and calls[0]['amount'] == '7.50', calls)
check('and is what the cap counts', storage.qr_weekly_spent_cents('2026-08-09') == 750,
      storage.qr_weekly_spent_cents('2026-08-09'))

# ── the amount floor ─────────────────────────────────────────
node = fresh(default=40)
calls = []
qr_judge.charge_for_failure(node, '2026-08-10', 'absent', 40, sender(calls))
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

# ── the id Beeminder actually sends ──────────────────────────
#
# It is Mongo extended JSON, not a string. Storing the raw dict raised inside
# qr_settle_charge — after the charge had gone through — leaving a real $2 charge
# recorded as 'charging' forever. The fake sender used above returned a tidy
# {'id': 'ch_1'}, which is exactly why the suite passed while production broke.
check('a Mongo-style id is flattened to its hex string',
      qr_judge._charge_id({'id': {'$oid': '6a7b640af0168a84df09b4cf'}})
      == '6a7b640af0168a84df09b4cf',
      qr_judge._charge_id({'id': {'$oid': '6a7b640af0168a84df09b4cf'}}))
check('a plain string id still passes through',
      qr_judge._charge_id({'id': 'ch_1'}) == 'ch_1', qr_judge._charge_id({'id': 'ch_1'}))
check('a missing id is None, not a crash',
      qr_judge._charge_id({}) is None and qr_judge._charge_id(None) is None, 'raised')
check('an unrecognised shape is kept as text rather than dropped',
      isinstance(qr_judge._charge_id({'id': {'weird': 1}}), str),
      qr_judge._charge_id({'id': {'weird': 1}}))

node = fresh()
calls = []
qr_judge.charge_for_failure(node, '2026-08-12', 'absent', 200,
                            sender(calls, data={'id': {'$oid': 'abc123'}}))
row = status_of(node['id'], '2026-08-12')
check('a charge settles cleanly with the real id shape',
      row['charge_status'] == 'succeeded', row)
check('and the reference is stored as text',
      row.get('charge_id') == 'abc123' or row.get('charge_ref') == 'abc123', dict(row))


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

# ── the card fee ─────────────────────────────────────────────
# The card provider takes a fixed fee per transaction on its own, so the
# stake must be split: Beeminder gets stake minus fee, and the FULL stake is
# what the log and the cap count — the fee is part of what failing costs,
# not a surcharge on top of it.
node = fresh(default=200)
storage.set_setting('gate_card_fee_cents', '50')
calls = []
qr_judge.charge_for_failure(node, '2026-08-20', 'absent', 200, sender(calls))
check('the fee comes OUT of the stake ($2 stake bills $1.50)',
      calls and calls[0]['amount'] == '1.50', calls)
check('the log keeps the full stake (what failing cost)',
      status_of(node['id'], '2026-08-20')['amount_cents'] == 200,
      status_of(node['id'], '2026-08-20'))
check('and the cap counts the full stake too',
      storage.qr_weekly_spent_cents('2026-08-20') == 200,
      storage.qr_weekly_spent_cents('2026-08-20'))

node = fresh(default=200)
calls = []
qr_judge.charge_for_failure(node, '2026-08-21', 'absent', 200, sender(calls))
check('no fee configured bills the whole stake (default 0)',
      calls and calls[0]['amount'] == '2.00', calls)

node = fresh(default=120)
storage.set_setting('gate_card_fee_cents', '50')
calls = []
qr_judge.charge_for_failure(node, '2026-08-22', 'absent', 120, sender(calls))
check('a stake under fee + $1 clamps the remainder to Beeminder\'s $1 floor',
      calls and calls[0]['amount'] == '1.00', calls)


# ── THE COMMITMENT (2026-10-01, Quentin: "this type of error literally keeps
# happening") ─────────────────────────────────────────────────────────────
#
# A day is at stake only if the judge saw it coming: a tick within
# COMMIT_LEAD_MIN before the window found it running, the tick at the opening
# sealed it, and only the sealed row is charged. These drive the real judge on
# a fake clock. The fixture gate's window is 21:00-22:00.
judge_calls = []
qr_judge._http_post = lambda url, body: (judge_calls.append(body) or (True, {'id': 'ch_j'}))
D = '2026-09-30'


def at(hhmm, ymd=D):
    return datetime.fromisoformat(f'{ymd}T{hhmm}:00')


def tick(*times):
    for t in times:
        qr_judge.judge(now=at(t) if isinstance(t, str) else t)


def scan(node_id, ymd, hhmm):
    local = datetime.fromisoformat(f'{ymd}T{hhmm}:00')
    utc = local.astimezone(None).utctimetuple()
    storage.qr_log_scan(node_id, datetime(*utc[:6]).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                        None, None, None)


# The ordinary day, both ways.
node = fresh(default=500)
judge_calls.clear()
tick('20:55', '21:00', '22:05')
check('a day seen coming and missed while armed is charged its stake',
      len(judge_calls) == 1 and judge_calls[0]['amount'] == '5.00'
      and judged(node['id'], D) == 'succeeded', (judge_calls, judged(node['id'], D)))
node = fresh(default=500)
scan(node['id'], D, '21:30')
judge_calls.clear()
tick('20:55', '21:00', '22:05')
check('and a day met in its window costs nothing',
      not judge_calls and judged(node['id'], D) == 'ok', judged(node['id'], D))

# The incident, replayed: paused when the window opened, resumed after it.
node = fresh(default=500)
storage.qr_update_node(node['id'], {'active': 0})
tick('20:55', '21:00')
storage.qr_update_node(node['id'], {'active': 1})
judge_calls.clear()
tick('21:30', '22:05', at('11:20', '2026-10-01'))
check('a gate paused when its window opened is not charged after resuming',
      not judge_calls and judged(node['id'], D) == 'n/a', judged(node['id'], D))

# The incident's other half: armed after the window opened.
node = fresh(armed=False, default=500)
tick('20:55', '21:00')
storage.set_setting('gate_charging_armed_at', '2026-09-30T21:30:00')
judge_calls.clear()
tick('22:05')
check('arming after a window opened charges nothing for that day',
      not judge_calls and judged(node['id'], D) == 'would_fire', judged(node['id'], D))
judge_calls.clear()
tick(at('20:55', '2026-10-01'), at('21:00', '2026-10-01'), at('22:05', '2026-10-01'))
check('and the next day, seen coming while armed, is charged as usual',
      len(judge_calls) == 1, judge_calls)

# Disarming is immediate, even for a sealed day.
node = fresh(default=500)
tick('20:55', '21:00')
storage.set_setting('gate_charging_armed_at', '')
judge_calls.clear()
tick('22:05')
check('disarming after the seal still stops the charge',
      not judge_calls and judged(node['id'], D) == 'would_fire', judged(node['id'], D))

# The judge down at the opening: nothing was seen coming, so nothing is owed.
node = fresh(default=500)
judge_calls.clear()
tick('21:10', '22:05')
check('a window the judge never saw open is n/a, never charged',
      not judge_calls and judged(node['id'], D) == 'n/a', judged(node['id'], D))
node = fresh(default=500)
judge_calls.clear()
tick('20:30', '21:00', '22:05')                  # last look 30 min before
check('a look older than COMMIT_LEAD_MIN does not count as seeing it coming',
      not judge_calls and judged(node['id'], D) == 'n/a', judged(node['id'], D))

# Paused in the last minutes before the opening: the seal checks again.
node = fresh(default=500)
tick('20:55')
storage.qr_update_node(node['id'], {'active': 0})
judge_calls.clear()
tick('21:00', '22:05')
check('a gate paused between the last look and the opening is not sealed',
      not judge_calls and judged(node['id'], D) == 'n/a', judged(node['id'], D))

# Called off before it opened.
node = fresh(default=500)
tick('20:50')
storage.qr_set_override(node['id'], D, '21:00', '22:00', 0, skipped=1)
judge_calls.clear()
tick('20:55', '21:00', '22:05')
check('a day called off before it opened drops its provisional row',
      not judge_calls and judged(node['id'], D) == 'n/a'
      and storage.qr_get_commitment(node['id'], D) is None, judged(node['id'], D))

# What was sealed is what is judged, whatever changes afterwards.
node = fresh(default=500)
tick('20:55', '21:00')
storage.qr_update_node(node['id'], {'charge_cents': 900, 'window_start': '21:40',
                                    'window_end': '23:00', 'proof_mode': 'tag'})
scan(node['id'], D, '21:20')                     # a LINK scan, inside the sealed window
judge_calls.clear()
tick('22:05')
check('a change after the seal does not reach the day: sealed window and proof',
      not judge_calls and judged(node['id'], D) == 'ok', judged(node['id'], D))
check('and the read-outs resolve the day to the window that was sealed',
      qr_judge.resolve_window(node_row(node['id']), D) == ('21:00', '22:00', 0),
      qr_judge.resolve_window(node_row(node['id']), D))
node = fresh(default=500)
tick('20:55', '21:00')
storage.qr_update_node(node['id'], {'charge_cents': 900})
judge_calls.clear()
tick('22:05')
check('a stake raised after the seal bills the sealed stake',
      judge_calls and judge_calls[0]['amount'] == '5.00', judge_calls)

# A provisional row follows the gate until the opening.
node = fresh(default=500)
tick('20:50')
storage.qr_update_node(node['id'], {'charge_cents': 700})
tick('20:55')
c = storage.qr_get_commitment(node['id'], D)
check('before the opening the provisional stake follows the gate',
      c and c['staked_cents'] == 700 and not c['sealed_at'], c)
tick('21:00')
check('and the opening seals it', storage.qr_get_commitment(node['id'], D)['sealed_at'],
      storage.qr_get_commitment(node['id'], D))
storage.qr_update_node(node['id'], {'active': 0})
tick('21:05')
check('a sealed row is not dropped by anything the judge does after',
      storage.qr_get_commitment(node['id'], D)['sealed_at'],
      storage.qr_get_commitment(node['id'], D))

# Deleting the gate takes its commitments with it.
node = fresh(default=500)
tick('20:55')
storage.qr_delete_node(node['id'])
check('deleting a gate deletes its commitments',
      storage.qr_get_commitment(node['id'], D) is None)


# ── the switch, through its route ────────────────────────────
# LAST: importing app holds tracker.db open, so each fixture gets its own dir.
os.chdir(tempfile.mkdtemp())
fresh(armed=False)
storage.set_setting('last_backup_date', date_cls.today().isoformat())
import app as _app                                         # noqa: E402
cl = _app.app.test_client()
cl.patch('/api/gates/billing', json={'armed': True})
first = (storage.get_settings() or {}).get('gate_charging_armed_at')
check('arming from the route writes the stamp', bool(first), first)
check('and makes it live', qr_judge.charge_settings()['live'] is True, qr_judge.charge_settings())
cl.patch('/api/gates/billing', json={'armed': True})
check('re-arming keeps the original stamp',
      (storage.get_settings() or {}).get('gate_charging_armed_at') == first)
cl.patch('/api/gates/billing', json={'armed': False})
check('disarming clears it', not (storage.get_settings() or {}).get('gate_charging_armed_at'))
check('and is not live', qr_judge.charge_settings()['live'] is False)
cl.patch('/api/gates/billing', json={'armed': True})
cl.patch('/api/gates/billing', json={'gate_charging_live': False})
check('the old name still turns it OFF, so a page loaded before the change can disarm',
      qr_judge.charge_settings()['live'] is False)

os.chdir(tempfile.mkdtemp())
node = fresh(default=500)
storage.set_setting('last_backup_date', date_cls.today().isoformat())
today = date_cls.today()
qr_judge.judge(now=datetime.combine(today, datetime.min.time()) + timedelta(hours=20, minutes=55))
b = cl.get('/api/gates/billing').get_json()
check('the billing panel lists what is at stake today',
      (node['id'], today.isoformat(), 500)
      in [(c['node_id'], c['date'], c['staked_cents']) for c in b['commitments']],
      b['commitments'])
check('and no longer reports a dry run or a code lock',
      not {'dryrun', 'charging_disabled', 'live_setting'} & set(b), sorted(b))
d = cl.get(f'/api/accountability/nodes/{node["id"]}/day?date={today.isoformat()}').get_json()
check('the gate read-out carries the day\'s commitment',
      d['commitment'] and d['commitment']['staked_cents'] == 500
      and d['commitment']['sealed'] is False, d.get('commitment'))

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
