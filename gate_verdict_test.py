"""One gate, one proof, one verdict. Run: python gate_verdict_test.py

2026-09-02, Quentin's instruction. This file REPLACES gate_split_test.py, whose
subject — a stake split 50/50 between a scan and a linked routine — no longer
exists.

    the gate's own proof met      ->  nothing
    the gate's own proof missed   ->  the whole stake

There is no third price. The split was itself a fix for an all-or-nothing rule
that left a missed morning with no reason to do the routine at all; it fixed
that by pricing two commitments against one stake, and the coupling was the
real fault. Separated, each checkpoint keeps its own live incentive all day and
nothing is ever pre-lost.

This is a MONEY file, so it checks the arithmetic and, just as importantly, the
TIMING and the CAP: a judged day is frozen with no second look, and a ROUTINE
gate — retired 2026-10-05 with the runner — lands 'n/a' and never costs
anything, even on a day sealed before it was retired. The card fee and the shared weekly cap are the two places an
amount could go wrong quietly, so both are asserted against the whole stake the
separation now always charges.

qr_gate_test.py covers which proof clears which gate. This file is about what a
failure COSTS.
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


def fresh(live=False, cap=2500, fee=0):
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    # ONE SWITCH (2026-10-01): armed, plus the credentials below.
    storage.set_setting('gate_charging_armed_at', '2026-09-29T12:00:00' if live else '')
    storage.set_setting('gate_weekly_cap_cents', str(cap))
    storage.set_setting('gate_card_fee_cents', str(fee))
    # The token lives in config.json, never the db. Without one beeminder_charge
    # returns 'failed' before it reaches the sender, so a money fixture that
    # forgets it tests nothing at all.
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': 'test-token', 'beeminder_user': 'quentin'}, f)


def scan(node_id, ymd, hhmm='07:00'):
    local = dt.fromisoformat(ymd + 'T' + hhmm + ':00')
    utc = local.astimezone(None).utctimetuple()
    storage.qr_log_scan(node_id, dt(*utc[:6]).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                        None, None, None)


def scan_gate(token, start='06:00', end='08:00'):
    nid = storage.qr_create_node('Wake', token, start, end)
    # WITH A SCHEDULE SOURCE, deliberately: applies_on returns early on the
    # source branch, so a check written below that return is unreachable for
    # every gate the app actually creates while a sourceless fixture passes.
    storage.qr_ensure_node_source(nid)
    return nid


def node_row(nid):
    return [n for n in storage.qr_get_nodes() if n['id'] == nid][0]


def row(node_id, ymd):
    rows = [r for r in storage.qr_charge_rows_between(ymd, ymd) if r['node_id'] == node_id]
    return rows[0] if rows else None


def judged(node_id, ymd):
    return storage.qr_node_day_state(node_id, ymd)['judged']


def tick_through(ymd, settled):
    # THE COMMITMENT (2026-10-01): a day is judged only if a tick saw its
    # window coming and another saw it open — what the 5-minute timer does.
    for n in storage.qr_get_nodes():
        opens = qr_judge.day_opens_at(n, ymd, qr_judge.resolve_window(n, ymd))
        for t in (opens - timedelta(minutes=5), opens):
            qr_judge.judge(now=t)
    qr_judge.judge(now=settled)


# PAST THE SETTLE POINT, not the wall clock: a money tripwire that passes by
# day and lies in the small hours is worse than one that is missing.
SETTLED = dt.fromisoformat(TODAY + 'T09:00:00')

# ── two prices, and only two ──────────────────────────────────────────────
CASES = [
    # (label, build, satisfy?, expected credit_pct, expected reason)
    ('a scan gate, scanned',        'scan',    True,  100, None),
    ('a scan gate, not scanned',    'scan',    False, 0,   'absent'),
]

for i, (label, kind, satisfied, want_pct, want_reason) in enumerate(CASES):
    fresh()
    nid = scan_gate('tok-price-%d' % i)
    if satisfied:
        scan(nid, YESTERDAY)
    tick_through(YESTERDAY, SETTLED)
    j = judged(nid, YESTERDAY)
    check(label + ': credit %d, reason %s' % (want_pct, want_reason),
          (j or {}).get('credit_pct') == want_pct
          and (j or {}).get('failure_reason') == want_reason,
          ((j or {}).get('credit_pct'), (j or {}).get('failure_reason')))

# A ROUTINE GATE IS GONE, AND COSTS NOTHING (2026-10-05). Nothing runs a
# routine any more, so a row still saying 'routine' could never be cleared —
# it does not run (applies_on), and lands 'n/a', armed or not.
fresh(live=True)
nid = scan_gate('tok-retired')
storage.qr_update_node(nid, {'proof_mode': 'routine'})
tick_through(YESTERDAY, SETTLED)
j = judged(nid, YESTERDAY)
check('a leftover routine gate lands n/a, never a charge',
      (j or {}).get('charge_status') == 'n/a' and not (j or {}).get('amount_cents'), j)

# ...and a day SEALED under that proof before it was retired is not charged
# either: the sealed terms are what _settle reads, and they name a proof
# nothing can satisfy any more.
fresh(live=True)
nid = scan_gate('tok-retired-sealed')
storage.qr_put_commitment(nid, YESTERDAY, ('06:00', '08:00', 0),
                          json.dumps({'proof_mode': 'routine'}), 200,
                          YESTERDAY + 'T05:55:00')
storage.qr_seal_commitment(nid, YESTERDAY, YESTERDAY + 'T06:00:00', 200)
qr_judge.judge(now=SETTLED)
j = judged(nid, YESTERDAY)
check('a day sealed under a routine proof lands n/a, never a charge',
      (j or {}).get('charge_status') == 'n/a' and not (j or {}).get('amount_cents'), j)

# ── the money itself ──────────────────────────────────────────────────────
sent = []


def sender(url, body):
    sent.append(body)
    return True, {'id': {'$oid': 'abc123'}}


fresh(live=True)
nid = scan_gate('tok-money-whole')
qr_judge.charge_for_failure(node_row(nid), YESTERDAY, 'absent', 200,
                            sender=sender, window=('06:00', '08:00', 0))
check('a failure bills the WHOLE $2.00 stake',
      sent and sent[-1]['amount'] == '2.00', sent[-1:])
check('...and the log records it',
      row(nid, YESTERDAY)['amount_cents'] == 200, row(nid, YESTERDAY))
check('...and the cap counts it',
      storage.qr_weekly_spent_cents(YESTERDAY) == 200,
      storage.qr_weekly_spent_cents(YESTERDAY))
check('...and credit_pct is stamped 0, not left NULL',
      row(nid, YESTERDAY)['credit_pct'] == 0, row(nid, YESTERDAY))

# THE CARD FEE COMES OUT OF THE STAKE, never on top of it: Beeminder is billed
# stake − fee while the log and the cap keep the whole stake. A $4.00 stake puts
# the remainder above Beeminder's $1 floor, which is what makes the subtraction
# visible — at a $2.00 stake with a $0.50 fee the floor would lift $1.50 back up
# and a deleted subtraction would look identical. That is not hypothetical:
# removing `bill = amount - fee` once left every check in the old file green.
sent[:] = []
fresh(live=True, fee=50)
storage.set_setting('gate_charge_cents', '400')
nid = scan_gate('tok-money-fee')
qr_judge.charge_for_failure(node_row(nid), YESTERDAY, 'absent', 400,
                            sender=sender, window=('06:00', '08:00', 0))
check('the fee is visibly out of the bill ($4.00 stake - $0.50 fee)',
      sent and sent[-1]['amount'] == '3.50', sent[-1:])
check('...while the log and the cap keep the whole $4.00',
      row(nid, YESTERDAY)['amount_cents'] == 400
      and storage.qr_weekly_spent_cents(YESTERDAY) == 400,
      (row(nid, YESTERDAY), storage.qr_weekly_spent_cents(YESTERDAY)))

# THE WEEKLY CAP MEASURES WHAT HAS BEEN CHARGED AND CHARGES NO FURTHER
# (Quentin, 2026-09-02, keeping the existing behaviour). A breaching charge is
# skipped WHOLE and logged 'capped' — so a week can finish UNDER the cap rather
# than spent to the cent, which is the deliberate trade for never billing a
# fraction of a stake nobody set.
sent[:] = []
fresh(live=True, cap=300)
nid = scan_gate('tok-cap-1')
st = qr_judge.charge_for_failure(node_row(nid), YESTERDAY, 'absent', 200,
                                 sender=sender, window=('06:00', '08:00', 0))
check('the first $2.00 fits under a $3.00 cap', st == 'succeeded', st)
nid2 = scan_gate('tok-cap-2')
st = qr_judge.charge_for_failure(node_row(nid2), YESTERDAY, 'absent', 200,
                                 sender=sender, window=('06:00', '08:00', 0))
check('the second breaches it and is skipped WHOLE, not part-billed',
      st == 'capped', st)
check('...so nothing more reached the card',
      len(sent) == 1, sent)
check('...and the capped row carries no amount',
      row(nid2, YESTERDAY)['amount_cents'] in (None, 0), row(nid2, YESTERDAY))
check('...leaving the week under the cap, at $2.00 of $3.00',
      storage.qr_weekly_spent_cents(YESTERDAY) == 200,
      storage.qr_weekly_spent_cents(YESTERDAY))

# THE CAP IS SHARED ACROSS EVERY GATE, and that is a consequence worth pinning
# down rather than discovering: qr_weekly_spent_cents is not per-node, so a bad
# week on one gate can make another gate's failure free. Separating the gates
# did NOT separate this. Asserted so the day it changes is a decision.
check('the cap is global — one gate spending it caps a different gate',
      row(nid, YESTERDAY)['node_id'] != row(nid2, YESTERDAY)['node_id']
      and row(nid2, YESTERDAY)['charge_status'] == 'capped')

# ── what the surfaces are told ────────────────────────────────────────────
fresh()
nid = scan_gate('tok-outcome-1')
scan(nid, YESTERDAY)
tick_through(YESTERDAY, SETTLED)
out = {(o['node_id'], o['date']): o['outcome']
       for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)}
check('a met day draws as success', out.get((nid, YESTERDAY)) == 'success', out)

fresh()
nid = scan_gate('tok-outcome-2')
tick_through(YESTERDAY, SETTLED)
out = {(o['node_id'], o['date']): o['outcome']
       for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)}
check('a missed day draws as failed, and never as partial',
      out.get((nid, YESTERDAY)) == 'failed', out)

# PARTIAL IS HISTORY, NOT DEAD CODE. Nothing writes a 50 any more, but the rows
# judged between 2026-08-22 and 2026-09-02 carry one and a judged day is frozen
# — re-scoring them as plain failures would rewrite what they cost.
check('a frozen 50 still reads back as partial',
      qr_judge.judged_outcome({'failure_reason': 'absent', 'credit_pct': 50}) == 'partial')
check('a row from before the split, with no credit at all, reads as failed',
      qr_judge.judged_outcome({'failure_reason': 'absent', 'credit_pct': None}) == 'failed')

# ── the freeze still holds ────────────────────────────────────────────────
#
fresh()
nid = scan_gate('tok-freeze')
tick_through(YESTERDAY, SETTLED)
first = judged(nid, YESTERDAY)
check('the day was judged and charged', (first or {}).get('failure_reason'), first)
scan(nid, YESTERDAY)                       # too late: the day is already judged
qr_judge.judge(now=SETTLED)
check('a judged day is not re-opened by a scan arriving afterwards',
      judged(nid, YESTERDAY)['credit_pct'] == first['credit_pct']
      and judged(nid, YESTERDAY)['failure_reason'] == first['failure_reason'],
      (first, judged(nid, YESTERDAY)))

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
