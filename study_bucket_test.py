"""The hours gate: a bucket, a requirement, a flat stake. Run: python study_bucket_test.py

2026-09-02, Quentin's design. A gate cleared by a NUMBER rather than a scan:

    R  = T - B                      what the day owes
    pass (H >= R):  no charge,  B' = B + H - T
    fail (H <  R):  charge,     B' = B + H // 2

This is a MONEY file, so it checks three separable things and keeps them
separable:

  · THE ARITHMETIC, in integer minutes. 2400/7 has no exact float and `H >= R`
    is decided exactly at that boundary, so a day worked to the minute is the
    case most likely to be wrong and is tested directly.
  · THE FREEZE. The bucket is a running total, so a correction to an already
    judged day must not move what a later day was judged against. That is the
    whole reason it is stamped rather than re-derived.
  · THE MONEY. One row per node+date whatever happens, exactly one amount, the
    shared weekly cap, and the card fee coming out of the stake rather than on
    top of it.

Companion to gate_split_test.py, whose fixtures this borrows.
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


T = qr_judge.DEFAULT_TARGET_MINUTES          # 343 = 5h43m
TODAY = date_cls.today().isoformat()
YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()


def day(n):
    return (date_cls.today() - timedelta(days=n)).isoformat()


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
    with open('config.json', 'w') as f:
        json.dump({'beeminder_auth_token': 'test-token', 'beeminder_user': 'quentin'}, f)


def hours_gate(token='tok-study', stake=500, target=None):
    # The real shape: the window closes at 04:00 the NEXT morning, so late work
    # still counts for the day it was owed.
    nid = storage.qr_create_node('Study', token, '04:00', '04:00', offset_days=1)
    storage.qr_update_node(nid, {'proof_mode': 'hours', 'charge_cents': stake})
    if target is not None:
        storage.qr_update_node(nid, {'target_minutes': target})
    return nid


def node(nid):
    return next(n for n in storage.qr_get_nodes() if n['id'] == nid)


def row(node_id, ymd):
    # Straight at the table: the two shipped readers are the FAILURE list
    # (qr_charge_rows_between filters failure_reason IS NOT NULL) and the
    # per-gate record, and neither carries the ladder columns. A money test
    # asserts the row that was actually written.
    storage.qr_ensure_charge_columns()
    conn = storage.get_conn()
    r = conn.execute('SELECT * FROM qr_charge_log WHERE node_id = ? AND date = ?',
                     (node_id, ymd)).fetchone()
    conn.close()
    return dict(r) if r else None


def rows_for(node_id, ymd):
    storage.qr_ensure_charge_columns()
    conn = storage.get_conn()
    n = conn.execute('SELECT COUNT(*) c FROM qr_charge_log WHERE node_id = ? AND date = ?',
                     (node_id, ymd)).fetchone()['c']
    conn.close()
    return n


# Judged well past the 04:00 close of the day being judged.
def settled(ymd):
    return dt.fromisoformat(ymd + 'T09:00:00') + timedelta(days=1)


# ── the arithmetic, in isolation ─────────────────────────────────────────
#
# hours_satisfies is asked directly here so a failure points at the ladder
# rather than at the judge that calls it.
fresh()
nid = hours_gate()
CASES = [
    # (label, bucket in, minutes worked, passes, bucket out)
    ('exactly the target passes, and banks nothing', 0, T, True, 0),
    ('one minute short fails', 0, T - 1, False, (T - 1) // 2),
    ('a long day banks the surplus', 0, 480, True, 480 - T),
    ('the bucket lowers what the next day owes', 137, 206, True, 0),
    ('one minute short of the LOWERED bar still fails', 137, 205, False, 137 + 102),
    ('a failed day banks half of what was worked', 0, 240, False, 120),
    ('an odd failed day floors the half', 0, 241, False, 120),
    ('nothing worked, nothing banked', 0, 0, False, 0),
    ('a bucket over the target passes on zero, and drains by T', T + 60, 0, True, 60),
]
for label, b_in, worked, want_pass, want_out in CASES:
    storage.put_study_entry(nid, TODAY, worked)
    got = qr_judge.hours_satisfies(node(nid), TODAY, bucket_in=b_in)
    check(label, (got[0], got[3]) == (want_pass, want_out), got)

check('the requirement is T minus the bucket',
      qr_judge.hours_satisfies(node(nid), TODAY, bucket_in=100)[2] == T - 100)
check('a null target means the default, never zero',
      qr_judge.target_minutes({'target_minutes': None}) == T)
check('and an explicit target is used as given',
      qr_judge.target_minutes({'target_minutes': 300}) == 300)

# The boundary the float version would have got wrong: 2400/7 is 342.857..., so
# a day worked to exactly the stored target must pass, not miss by an epsilon.
check('the target is an integer number of minutes', isinstance(T, int) and T == 343)

# ── the judge: one row, the right verdict, the stamped ladder ────────────
fresh()
nid = hours_gate()
storage.put_study_entry(nid, YESTERDAY, 360)          # 6h against 5h43m
qr_judge.judge(now=settled(YESTERDAY))
r = row(nid, YESTERDAY)
check('a met day judges ok and costs nothing',
      (r['failure_reason'], r['charge_status'], r['amount_cents']) == (None, 'ok', None), r)
check('and stamps what it was judged against',
      (r['req_minutes'], r['minutes_logged'], r['bucket_after_minutes']) == (T, 360, 360 - T),
      r)

fresh()
nid = hours_gate()
storage.put_study_entry(nid, YESTERDAY, 240)
qr_judge.judge(now=settled(YESTERDAY))
r = row(nid, YESTERDAY)
check('a short day fails with its own reason',
      r['failure_reason'] == 'hours_short', r)
check('for the whole stake, never half — an hours gate has no second half',
      (r['amount_cents'], r['credit_pct']) == (None, 0), r)
check('and banks half of what was worked', r['bucket_after_minutes'] == 120, r)

# Re-judging must not write a second row or a second amount.
qr_judge.judge(now=settled(YESTERDAY))
check('re-judging the same day writes no second row',
      rows_for(nid, YESTERDAY) == 1, rows_for(nid, YESTERDAY))

# ── no entry at all is a zero, not a skip ───────────────────────────────
fresh()
nid = hours_gate()
qr_judge.judge(now=settled(YESTERDAY))
r = row(nid, YESTERDAY)
check('a night never entered is judged as zero minutes, and fails',
      (r['failure_reason'], r['minutes_logged']) == ('hours_short', 0), r)

# ── R <= 0 passes without an entry, and drains ──────────────────────────
fresh()
nid = hours_gate()
storage.put_study_entry(nid, day(2), 2 * T + 60)      # two days' worth, two days back
qr_judge.judge(now=settled(day(2)))
qr_judge.judge(now=settled(YESTERDAY))
r2, r1 = row(nid, day(2)), row(nid, YESTERDAY)
check('a surplus carries into the next day', r2['bucket_after_minutes'] == T + 60, r2)
check('a day whose requirement is already met passes with no entry at all',
      (r1['failure_reason'], r1['charge_status']) == (None, 'ok'), r1)
check('a requirement below zero needs no work at all', r1['req_minutes'] == -60, r1)
check('and the bucket still drains by the full target',
      r1['bucket_after_minutes'] == 60, r1)

# ── the chain carries across a day the gate did not run ─────────────────
fresh()
nid = hours_gate()
storage.qr_update_node(nid, {'days_of_week': '0123456'})
storage.put_study_entry(nid, day(3), 400)
qr_judge.judge(now=settled(day(3)))
before = row(nid, day(3))['bucket_after_minutes']
# A day called off lands 'n/a' with a NULL bucket, and the chain must skip it
# rather than read the NULL as a reset.
storage.qr_set_override(nid, day(2), '04:00', '04:00', 1, skipped=1)
qr_judge.judge(now=settled(day(2)))
skipped = row(nid, day(2))
check('a called-off day carries no bucket of its own',
      skipped['charge_status'] == 'n/a' and skipped['bucket_after_minutes'] is None,
      skipped)
check('and the next day inherits the bucket from BEFORE it, not zero',
      storage.qr_bucket_before(nid, YESTERDAY) == before, before)

# ── the freeze: a later correction cannot move a judged day ─────────────
fresh()
nid = hours_gate()
storage.put_study_entry(nid, day(2), 400)
qr_judge.judge(now=settled(day(2)))
stamped = row(nid, day(2))
storage.put_study_entry(nid, day(2), 60)              # a correction, after the fact
qr_judge.judge(now=settled(day(2)))
after = row(nid, day(2))
check('a judged day is not re-scored when its entry changes',
      (after['req_minutes'], after['minutes_logged'], after['bucket_after_minutes'])
      == (stamped['req_minutes'], stamped['minutes_logged'],
          stamped['bucket_after_minutes']), after)
check('and the bucket the next day inherits comes off that frozen row',
      storage.qr_bucket_before(nid, YESTERDAY) == stamped['bucket_after_minutes'])

# ── the money ───────────────────────────────────────────────────────────
sent = []


def fake_sender(url, body):
    # (url, body) -> (ok, data), the contract _http_post has and qr_charge_test
    # stubs the same way.
    sent.append(body)
    return True, {'id': 'ch_1'}


fresh(live=True, fee=0)
nid = hours_gate(stake=500)
storage.put_study_entry(nid, YESTERDAY, 60)
qr_judge.charge_for_failure(node(nid), YESTERDAY, 'hours_short', sender=fake_sender,
                            window=('04:00', '04:00', 1),
                            hours=(T, 60, 30))
r = row(nid, YESTERDAY)
check('a failed day charges the flat stake, not a fraction of it',
      r['amount_cents'] == 500, r)
check('and Beeminder is billed exactly that with no card fee set',
      sent and sent[0]['amount'] == '5.00', sent)

sent.clear()
fresh(live=True, fee=30)
nid = hours_gate(stake=500)
qr_judge.charge_for_failure(node(nid), YESTERDAY, 'hours_short', sender=fake_sender,
                            window=('04:00', '04:00', 1),
                            hours=(T, 0, 0))
r = row(nid, YESTERDAY)
check('the card fee comes OUT of the stake: the log keeps the full 500',
      r['amount_cents'] == 500, r)
check('while the card sees the remainder',
      sent and sent[0]['amount'] == '4.70', sent)

sent.clear()
fresh(live=True, cap=300)
nid = hours_gate(stake=500)
status = qr_judge.charge_for_failure(node(nid), YESTERDAY, 'hours_short',
                                     sender=fake_sender,
                                     window=('04:00', '04:00', 1),
                                     hours=(T, 0, 0))
check('a charge breaching the shared weekly cap is skipped WHOLE',
      status == 'capped' and not sent, (status, sent))
check('and the capped day still stamps its ladder',
      row(nid, YESTERDAY)['bucket_after_minutes'] == 0)

# ── the ladder survives a real multi-day run ────────────────────────────
#
# Four days end to end, each judged in order, asserting the bucket the way it
# would actually accumulate. This is the case no single-day test catches: the
# chain is read back off stamped rows, so an error compounds instead of
# repeating.
fresh()
nid = hours_gate()
WORKED = [480, 240, 300, 0]
b, want = 0, []
for i, m in enumerate(WORKED):
    d = day(len(WORKED) - i)
    storage.put_study_entry(nid, d, m)
    req = T - b
    passed = m >= req
    b = (b + m - T) if passed else (b + m // 2)
    want.append((d, passed, b))
    qr_judge.judge(now=settled(d))
for d, passed, b_after in want:
    r = row(nid, d)
    got = (r['failure_reason'] is None, r['bucket_after_minutes'])
    check('day %s: %s, bucket %d' % (d, 'met' if passed else 'missed', b_after),
          got == (passed, b_after), got)

# ── the NIGHT gate is untouched by any of this ──────────────────────────
#
# The whole reason the hours entry is a SOFT step on the night routine: a hard
# one would sit in day_steps and hold the sleep gate open. Here the weaker
# claim, but the one that would break silently: adding an hours gate does not
# change what a scan-and-routine gate is judged as.
fresh()
night = storage.qr_create_node('Night', 'tok-night', '22:00', '02:00', offset_days=1)
f = storage.create_flow('Night routine')
storage.update_flow(f['id'], qr_node_id=night)
hours_gate('tok-study-2')
qr_judge.judge(now=settled(YESTERDAY))
r = row(night, YESTERDAY)
check('a scan gate with a routine still judges by its own ladder',
      r['failure_reason'] == 'absent' and r['credit_pct'] == 0, r)
check('and its window was resolved, not borrowed from the hours gate',
      (r['window_start'], r['window_end']) == ('22:00', '02:00'), r)

# ── the route: the day is sent, and the close is a real refusal ─────────
#
# The store and the judge are only half the promise. The other half is the
# DOOR: the number is typed at 01:00 for a day that ends at 04:00, so the
# route must take the day it is given and refuse one that has closed. Driven
# through Flask's test client rather than a browser — this is about the
# contract, not the pixels.
fresh()
storage.set_setting('last_backup_date', TODAY)      # the backup thread must not fire
nid = hours_gate('tok-route')
import app as flask_app                             # noqa: E402
client = flask_app.app.test_client()


def put(ymd, minutes, node_id=None):
    r = client.put('/api/accountability/nodes/%d/hours' % (node_id or nid),
                   json={'date': ymd, 'minutes': minutes})
    return r.status_code, r.get_json()


code, body = put(TODAY, 300)
check('the route files the minutes under the day it was SENT',
      code == 200 and storage.study_entry_minutes(nid, TODAY) == 300, (code, body))
check('and answers with the resolved day, not an echo',
      body['required_minutes'] == T and body['passes'] is False, body)

code, body = put(TODAY, 420)
check('re-sending revises the same day rather than adding a second row',
      code == 200 and storage.study_entry_minutes(nid, TODAY) == 420, (code, body))
check('and now it passes', body['passes'] is True, body)

# The four hours after midnight are the whole reason this gate exists, so the
# assertion is against the RESOLVED close rather than a hardcoded day: before
# 04:00 yesterday is still open and must be writable, after it is shut. Run
# this suite at 01:00 and at 10:00 and it checks opposite outcomes, correctly.
close = qr_judge._local_dt(qr_judge.close_date_of(YESTERDAY, 1), '04:00')
still_open = dt.now() <= close
code, body = put(YESTERDAY, 300)
if still_open:
    check('before 04:00, yesterday is still open and the minutes land there',
          code == 200 and storage.study_entry_minutes(nid, YESTERDAY) == 300,
          (code, body))
else:
    check('after 04:00, yesterday is REFUSED, not silently accepted',
          code == 409 and body.get('closed') is True, (code, body))
    check('and nothing was written for it',
          storage.study_entry_minutes(nid, YESTERDAY) == 0)

# A day that is closed whatever the hour.
code, body = put(day(3), 300)
check('a long-closed day is refused with the close in the message',
      code == 409 and body.get('closed') is True, (code, body))
check('and nothing was written for it', storage.study_entry_minutes(nid, day(3)) == 0)

qr_judge.judge(now=settled(YESTERDAY))
code, body = put(YESTERDAY, 300)
check('a judged day is refused too — the freeze is enforced at the door',
      code == 409, (code, body))

for bad_body in ({'minutes': 300}, {'date': 'yesterday', 'minutes': 300},
                 {'date': TODAY, 'minutes': 'lots'}, {'date': TODAY, 'minutes': -5},
                 {'date': TODAY, 'minutes': 2000}):
    r = client.put('/api/accountability/nodes/%d/hours' % nid, json=bad_body)
    check('refused: %s' % bad_body, r.status_code == 400, r.get_json())

scan_only = storage.qr_create_node('Wake', 'tok-scan-only', '06:00', '08:00')
code, body = put(TODAY, 60, node_id=scan_only)
check('a gate that is not an hours gate has no hours door',
      code == 400, (code, body))

r = client.get('/api/accountability/nodes/%d/hours' % nid)
check('the GET may default to today — a read of the wrong day only misinforms',
      r.status_code == 200 and r.get_json()['date'] == TODAY, r.get_json())

# ── the PLAN half: drawn spans, and the union that sums them ────────────
#
# A different store from the entries above, and nothing here is on the money
# path — qr_judge never reads plan_span. What is tested is the arithmetic the
# banner shows and the guard rails on the route, because "3 hr 26 short" is a
# sentence that has to be right.
#
# NO fresh() from here down: the Flask client opened above holds tracker.db, so
# Windows refuses to delete it. Everything below uses its own gates and its own
# days instead, which is the same isolation without the teardown.
nid = hours_gate('tok-plan-suite')
c2 = client

check('an empty day plans nothing', storage.plan_minutes_for(TODAY) == 0)

a = storage.create_plan_span(TODAY, 540, 660)       # 09:00-11:00
b_ = storage.create_plan_span(TODAY, 780, 900)      # 13:00-15:00
check('two separate spans add up', storage.plan_minutes_for(TODAY) == 240,
      storage.plan_minutes_for(TODAY))

# OVERLAP IS COUNTED ONCE. Two spans over the same hour are one hour of
# intended work; summing them would let a plan satisfy itself on paper by
# being drawn twice over the same stretch.
storage.create_plan_span(TODAY, 600, 720)           # 10:00-12:00, overlaps `a`
check('an overlap is counted once, not twice',
      storage.plan_minutes_for(TODAY) == 300, storage.plan_minutes_for(TODAY))

# A span fully inside another adds nothing at all.
storage.create_plan_span(TODAY, 620, 640)
check('a span swallowed by another adds nothing',
      storage.plan_minutes_for(TODAY) == 300, storage.plan_minutes_for(TODAY))

# The spans belong to their own day, and the day is sent, never defaulted.
storage.create_plan_span(YESTERDAY, 540, 600)
check('a span belongs to the day it was drawn on',
      storage.plan_minutes_for(TODAY) == 300
      and storage.plan_minutes_for(YESTERDAY) == 60)

r = c2.post('/api/plan/spans', json={'date': TODAY, 'start_min': 1380, 'end_min': 1500})
check('a span may run past midnight — end_min beyond 1440',
      r.status_code == 200 and r.get_json()['end_min'] == 1500, r.get_json())

# `bad` is the failure list this file prints at the end — a loop variable of
# that name silently ate it.
for span_body in ({'start_min': 60, 'end_min': 120},
                  {'date': 'today', 'start_min': 60, 'end_min': 120},
                  {'date': TODAY, 'start_min': 60, 'end_min': 62},
                  {'date': TODAY, 'start_min': 60, 'end_min': 'noon'},
                  {'date': TODAY, 'start_min': -10, 'end_min': 120}):
    rr = c2.post('/api/plan/spans', json=span_body)
    check('refused: %s' % span_body, rr.status_code == 400, rr.get_json())

# DELETE and its undo replay: the row comes back with its ORIGINAL id, which is
# what the client's inverse posts.
gone = storage.get_plan_span(a['id'])
c2.delete('/api/plan/spans/%d' % a['id'])
check('a span can be removed', storage.get_plan_span(a['id']) is None)
c2.post('/api/plan/spans', json={'id': gone['id'], 'date': gone['date'],
                                 'start_min': gone['start_min'],
                                 'end_min': gone['end_min']})
back = storage.get_plan_span(gone['id'])
check('and the undo restores it under the SAME id, not a copy',
      back and back['start_min'] == gone['start_min'], back)

# NOTHING JUDGES A PLAN. The gate's verdict must be identical with spans drawn
# and with none — the whole reason the plan is a separate store. Two gates in
# ONE database rather than two databases: the Flask client above holds the file
# open, so a fresh() here cannot delete it, and judging one gate before the
# spans exist and the other after is the same comparison without the teardown.
nodeA = hours_gate('tok-plan-nomoney')
storage.put_study_entry(nodeA, YESTERDAY, 120)
qr_judge.judge(now=settled(YESTERDAY))
without = row(nodeA, YESTERDAY)

nodeB = hours_gate('tok-plan-nomoney2')
storage.put_study_entry(nodeB, YESTERDAY, 120)
for lo, hi in ((540, 660), (780, 960)):
    storage.create_plan_span(YESTERDAY, lo, hi)
check('spans exist on the day now being judged',
      storage.plan_minutes_for(YESTERDAY) > 0)
qr_judge.judge(now=settled(YESTERDAY))
with_plan = row(nodeB, YESTERDAY)
check('a drawn plan changes NOTHING about what the day is judged as',
      (without['failure_reason'], without['req_minutes'],
       without['minutes_logged'], without['bucket_after_minutes'])
      == (with_plan['failure_reason'], with_plan['req_minutes'],
          with_plan['minutes_logged'], with_plan['bucket_after_minutes']),
      (without, with_plan))

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
