"""The stake splits between the scan and the routine. Run: python gate_split_test.py

2026-08-22, Quentin's instruction, and it REVERSES the 2026-08-15 rule that
either half missed at its own deadline lost the whole day. That rule left a
missed morning with no reason to do the routine at all — the day was already
gone by 09:00, and the routine is the half actually worth doing.

    scan in its window AND routine done by its deadline  ->  nothing
    either one of those on its own                       ->  half the stake
    neither                                              ->  the whole stake

This is a MONEY file, so it checks the arithmetic and, just as importantly, the
TIMING: a day whose routine can still earn its half until midnight cannot be
judged when the scan window shuts, because a judged day is frozen and there is
no second look. It also checks the two halves against the cap and the card fee,
which are the two places a fractional amount could go wrong quietly.
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


YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()
TODAY = date_cls.today().isoformat()
TOMORROW = (date_cls.today() + timedelta(days=1)).isoformat()


def fresh(live=False, cap=2500, fee=0):
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    storage.set_setting('gate_charging_live', '1' if live else '0')
    storage.set_setting('gate_charge_dryrun', '0' if live else '1')
    storage.set_setting('gate_weekly_cap_cents', str(cap))
    storage.set_setting('gate_card_fee_cents', str(fee))
    # The token lives in config.json, never the db. Without one beeminder_charge
    # returns 'failed' before it reaches the sender, so a money fixture that
    # forgets it tests nothing at all.
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': 'test-token', 'beeminder_user': 'quentin'}, f)


def scan(node_id, ymd, hhmm='07:00'):
    local = dt.fromisoformat(f'{ymd}T{hhmm}:00')
    utc = local.astimezone(None).utctimetuple()
    storage.qr_log_scan(node_id, dt(*utc[:6]).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                        None, None, None)


def complete(flow_id, ymd, hhmm):
    storage.upsert_flow_run(flow_id, ymd, '{}', True)
    local = dt.fromisoformat(f'{ymd}T{hhmm}:00')
    iso = dt.utcfromtimestamp(local.timestamp()).isoformat() + '+00:00'
    conn = storage.get_conn()
    conn.execute('UPDATE flow_run SET completed_at = ? WHERE flow_id = ? AND date = ?',
                 (iso, flow_id, ymd))
    conn.commit()
    conn.close()


def gate(token, with_routine=True, start='06:00', end='08:00'):
    nid = storage.qr_create_node('Wake', token, start, end)
    fid = None
    if with_routine:
        f = storage.create_flow('Morning routine')
        storage.update_flow(f['id'], qr_node_id=nid)
        fid = f['id']
    return nid, fid


def row(node_id, ymd):
    rows = [r for r in storage.qr_charge_rows_between(ymd, ymd) if r['node_id'] == node_id]
    return rows[0] if rows else None


def judged(node_id, ymd):
    return storage.qr_node_day_state(node_id, ymd)['judged']


# ── the ladder, all five combinations ─────────────────────────────────────
CASES = [
    # (label, scanned, routine done at, expected credit, expected reason)
    ('both on time', True, '07:30', 100, None),
    ('scan on time, routine late', True, '08:30', 50, 'routine_late'),
    ('scan on time, routine never', True, None, 50, 'routine_incomplete'),
    ('no scan, routine late in the day', False, '21:40', 50, 'absent'),
    ('no scan, no routine', False, None, 0, 'absent'),
]

for i, (label, did_scan, done_at, want_credit, want_reason) in enumerate(CASES):
    fresh()
    nid, fid = gate('tok-split-%d' % i)
    if did_scan:
        scan(nid, YESTERDAY)
    if done_at:
        complete(fid, YESTERDAY, done_at)
    qr_judge.judge()
    j = judged(nid, YESTERDAY)
    got = (j or {}).get('credit_pct'), (j or {}).get('failure_reason')
    check('%s -> %d%% back, %s' % (label, want_credit, want_reason or 'nothing owed'),
          got == (want_credit, want_reason), got)

# ── a gate with NO routine has no half to earn ────────────────────────────
fresh()
nid, _ = gate('tok-noflow-a', with_routine=False)
scan(nid, YESTERDAY)
qr_judge.judge()
check('no routine, scanned: nothing owed', (judged(nid, YESTERDAY) or {}).get('credit_pct') == 100,
      judged(nid, YESTERDAY))

fresh()
nid, _ = gate('tok-noflow-b', with_routine=False)
qr_judge.judge()
j = judged(nid, YESTERDAY)
check('no routine, not scanned: the WHOLE stake, not half',
      (j['credit_pct'], j['failure_reason']) == (0, 'absent'), j)

# ── TIMING: the day has to be over before any of it can be said ───────────
fresh()
nid, fid = gate('tok-timing', start='06:00', end='08:00')
at_0801 = dt.fromisoformat(f'{TODAY}T08:01:00')
qr_judge.judge(now=at_0801)
check('the scan window closing does NOT judge a gate with a routine',
      judged(nid, TODAY) is None, judged(nid, TODAY))
complete(fid, TODAY, '19:00')
qr_judge.judge(now=dt.fromisoformat(f'{TODAY}T23:59:00'))
check('...still not judged at 23:59', judged(nid, TODAY) is None, judged(nid, TODAY))
qr_judge.judge(now=dt.fromisoformat(f'{TOMORROW}T00:01:00'))
j = judged(nid, TODAY)
check('...and once the day is over, the evening routine earned its half',
      (j or {}).get('credit_pct') == 50, j)

fresh()
nid, _ = gate('tok-timing-noflow', with_routine=False)
qr_judge.judge(now=at_0801)
check('a gate with NO routine is still judged the moment its window shuts',
      (judged(nid, TODAY) or {}).get('credit_pct') == 0, judged(nid, TODAY))

# ── the money itself ──────────────────────────────────────────────────────
sent = []


def sender(url, body):
    sent.append(body)
    return True, {'id': {'$oid': 'abc123'}}


fresh(live=True)
nid, fid = gate('tok-money-half')
scan(nid, YESTERDAY)
complete(fid, YESTERDAY, '08:30')                 # late: half owed
storage.qr_ensure_charge_columns()
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
qr_judge.charge_for_failure(node, YESTERDAY, 'routine_late', sender=sender,
                            window=('06:00', '08:00', 0), credit=0.5)
check('half a $2.00 stake bills $1.00', sent and sent[-1]['amount'] == '1.00', sent[-1:])
check('...and the log records what was charged, not the full stake',
      row(nid, YESTERDAY)['amount_cents'] == 100, row(nid, YESTERDAY))
check('...and the cap counts the half, not the whole',
      storage.qr_weekly_spent_cents(YESTERDAY) == 100,
      storage.qr_weekly_spent_cents(YESTERDAY))

# The card fee comes out of what is actually owed, not out of the full stake.
sent.clear()
fresh(live=True, fee=50)
nid, fid = gate('tok-money-fee')
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
qr_judge.charge_for_failure(node, YESTERDAY, 'routine_late', sender=sender,
                            window=('06:00', '08:00', 0), credit=0.5)
check('the fee still comes out of the amount owed ($1.00 owed - $0.50 fee)',
      sent and sent[-1]['amount'] == '1.00', sent[-1:])   # Beeminder's $1 floor
check('...and the log keeps the $1.00 the day cost',
      row(nid, YESTERDAY)['amount_cents'] == 100, row(nid, YESTERDAY))

# A half day under the cap must not be skipped as if it were a whole one.
sent.clear()
fresh(live=True, cap=150)
nid, fid = gate('tok-money-cap')
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
st = qr_judge.charge_for_failure(node, YESTERDAY, 'routine_late', sender=sender,
                                 window=('06:00', '08:00', 0), credit=0.5)
check('a $1.00 half fits under a $1.50 cap that $2.00 would have breached',
      st == 'succeeded', st)

# ── what the surfaces are told ────────────────────────────────────────────
fresh()
nid, fid = gate('tok-outcome')
scan(nid, YESTERDAY)
qr_judge.judge()
out = {(o['node_id'], o['date']): o['outcome']
       for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)}
check('a half-met day draws as PARTIAL, not as failed',
      out.get((nid, YESTERDAY)) == 'partial', out)

fresh()
nid, fid = gate('tok-outcome-2')
qr_judge.judge()
out = {(o['node_id'], o['date']): o['outcome']
       for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)}
check('a day with neither half still draws as failed',
      out.get((nid, YESTERDAY)) == 'failed', out)

fresh()
nid, fid = gate('tok-outcome-3')
scan(nid, YESTERDAY)
complete(fid, YESTERDAY, '07:30')
qr_judge.judge()
out = {(o['node_id'], o['date']): o['outcome']
       for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)}
check('both halves draws as success', out.get((nid, YESTERDAY)) == 'success', out)

# A row written before the split has no credit_pct, and meant the whole stake.
check('an old row with no credit reads as a plain failure',
      qr_judge.judged_outcome({'failure_reason': 'absent', 'credit_pct': None}) == 'failed')

# ── the freeze still holds ────────────────────────────────────────────────
fresh()
nid, fid = gate('tok-freeze')
qr_judge.judge()
first = judged(nid, YESTERDAY)
complete(fid, YESTERDAY, '21:00')          # too late: the day is already judged
qr_judge.judge()
check('a judged day is not re-opened by finishing the routine afterwards',
      judged(nid, YESTERDAY)['credit_pct'] == first['credit_pct'],
      (first, judged(nid, YESTERDAY)))

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
