"""Which proof clears which gate, and when the day is judged.

Run: python qr_gate_test.py

This file began as the ROUTINE gate's enforcement (a linked routine deciding a
gate). Routine gates are gone since 2026-10-05 — routines are plain lists and
nothing runs them — so what is asserted about them now is the safe end: a row
that still says 'routine' never runs and is never charged, and the mode is
refused at the door. Everything else here is about scan, hours and all-day
gates, and stays as it was.
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


YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()


def scan(node_id, ymd, hhmm='07:00', geo_pass=None):
    # The scan server writes UTC with a trailing Z, and the judge compares
    # against the same shape — a local-time scan would fall outside its own
    # window, which is the bug this format exists to prevent.
    local = datetime.fromisoformat(f'{ymd}T{hhmm}:00')
    utc = local.astimezone(None).utctimetuple()
    iso = datetime(*utc[:6]).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    storage.qr_log_scan(node_id, iso, None, None, geo_pass)


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


# WHEN THESE RUN, not when the clock says. Every block below judges YESTERDAY
# and reads the row back, so it needs a `now` past the moment yesterday settles.
# Left as a bare judge(), a suite passes by day and lies in the small hours.
SETTLED = datetime.fromisoformat(date_cls.today().isoformat() + 'T09:00:00')
TODAY = date_cls.today().isoformat()


def tick_through(ymd, settled):
    # THE COMMITMENT (2026-10-01): a day is judged only if a tick saw its
    # window coming and another saw it open — what the 5-minute timer does.
    for n in storage.qr_get_nodes():
        opens = qr_judge.day_opens_at(n, ymd, qr_judge.resolve_window(n, ymd))
        for t in (opens - timedelta(minutes=5), opens):
            qr_judge.judge(now=t)
    qr_judge.judge(now=settled)


def node_row(nid):
    return [n for n in storage.qr_get_nodes() if n['id'] == nid][0]


# ── through judge(): A SCAN GATE IS JUDGED ON ITS SCAN (2026-09-02) ────
#
# This REVERSES the 50/50 split of 2026-08-22 and the coupled rule before it.
# A gate has ONE proof.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-4', '06:00', '08:00')
scan(nid, YESTERDAY)
tick_through(YESTERDAY, SETTLED)
check('a scanned gate passes (no failure row)',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

# THERE IS NO HALF ANY MORE. A scan gate costs the whole stake or nothing —
# the two prices a single proof can have.
fresh()
nid = storage.qr_create_node('Wake', 'tok-wake-6b', '06:00', '08:00')
tick_through(YESTERDAY, SETTLED)
check('no partial price survives: a missed scan is the whole stake',
      cents_for(nid, YESTERDAY) == 200, cents_for(nid, YESTERDAY))
check('...and credit_pct is stamped 0, never 50',
      storage.qr_charge_rows_between(YESTERDAY, YESTERDAY)[0]['credit_pct'] == 0,
      storage.qr_charge_rows_between(YESTERDAY, YESTERDAY)[0]['credit_pct'])

# A SCAN GATE IS JUDGED WHEN ITS WINDOW SHUTS. Nothing can change the day after
# that, so nothing waits.
fresh()
nid = storage.qr_create_node('Sleep', 'tok-sleep-6d', '20:00', '23:00')
tick_through(TODAY, datetime.fromisoformat(TODAY + 'T23:01:00'))
check('a scan gate is judged the moment its window closes',
      (reason_for(nid, TODAY), cents_for(nid, TODAY)) == ('absent', 200),
      (reason_for(nid, TODAY), cents_for(nid, TODAY)))

# ── A ROUTINE GATE IS GONE (2026-10-05) ───────────────────────────────
#
# Nothing runs a routine any more, so a row still saying 'routine' has nothing
# that could clear it — and a gate nothing can clear is not a commitment, it is
# a daily charge. It never runs (applies_on), so every day lands 'n/a'.
fresh()
nid = storage.qr_create_node('Morning', 'tok-rg-1', '06:00', '08:00')
storage.qr_update_node(nid, {'proof_mode': 'routine'})
storage.qr_ensure_node_source(nid)       # applies_on returns early on a source
check('a leftover routine gate does not run',
      qr_judge.applies_on(node_row(nid), YESTERDAY) is False,
      qr_judge.applies_on(node_row(nid), YESTERDAY))
scan(nid, YESTERDAY)
tick_through(YESTERDAY, SETTLED)
check('...so its day is frozen n/a rather than charged',
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)) == (None, None)
      and storage.qr_judgment_exists(nid, YESTERDAY),
      (reason_for(nid, YESTERDAY), cents_for(nid, YESTERDAY)))
check('and it is not all-day by construction any more',
      qr_judge.is_all_day(node_row(nid)) is False)

# The reservation is still the lock: re-judging must not double-log.
fresh()
nid = storage.qr_create_node('Morning', 'tok-wake-10', '06:00', '08:00')
tick_through(YESTERDAY, SETTLED)
tick_through(YESTERDAY, SETTLED)
rows = [r for r in storage.qr_charge_rows_between(YESTERDAY, YESTERDAY) if r['node_id'] == nid]
check('re-running the judge logs the failure once', len(rows) == 1, len(rows))


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
tick_through(YESTERDAY, SETTLED)
check('a day the gate did not apply to is not judged',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
# Adding a day is a TIGHTENING, so it applies at once — and used to reach back.
storage.qr_update_node(nid, {'days_of_week': '0123456'})
tick_through(YESTERDAY, SETTLED)
check('adding a run-day today does not charge for yesterday',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Sleep', 'tok-freeze-2', '21:00', '23:00')
scan(nid, YESTERDAY, '22:00')
tick_through(YESTERDAY, SETTLED)
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
tick_through(YESTERDAY, SETTLED)
check('narrowing the window afterwards does not re-judge a closed day',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
check('and the day still reads success',
      [o['outcome'] for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
       if o['node_id'] == nid] == ['success'])

# A judge that was down past the day after settles a sealed day WITHOUT money.
# (A day it never saw open has no commitment at all, and lands n/a.)
fresh()
FOUR = (date_cls.today() - timedelta(days=4)).isoformat()
nid = storage.qr_create_node('Down', 'tok-freeze-3', '06:00', '08:00')
for t in ('05:55', '06:00'):                      # it saw day FOUR open...
    qr_judge.judge(now=datetime.fromisoformat(FOUR + 'T' + t + ':00'))
qr_judge.judge(now=SETTLED)                       # ...then nothing until today
rows = [r for r in storage.qr_charge_rows_between(FOUR, FOUR) if r['node_id'] == nid]
check('a day older than the money reach is judged',
      len(rows) == 1, rows)
check('and is logged stale, so the cap and the card never see it',
      rows and rows[0]['charge_status'] == 'stale' and rows[0]['amount_cents'] is None,
      rows)

# -- ALL DAY: THE WINDOW STOPS JUDGING (2026-09-03) -----------------------
#
# Quentin's instruction: a morning routine has a time it is MEANT to happen at
# and a commitment that is really "today"; study hours are a number the day
# owes and nothing to do with a clock. Both were judged against a window that
# only existed to place the pill. `all_day` says the window judges nothing.

fresh()
nid = storage.qr_create_node('Gym', 'tok-allday-1', '06:00', '08:00')
scan(nid, YESTERDAY, '21:00')                 # long after the window closed
tick_through(YESTERDAY, SETTLED)
check('control: a scan outside the window fails the day',
      reason_for(nid, YESTERDAY) == 'absent', reason_for(nid, YESTERDAY))

fresh()
nid = storage.qr_create_node('Gym', 'tok-allday-2', '06:00', '08:00')
storage.qr_update_node(nid, {'all_day': 1})
scan(nid, YESTERDAY, '21:00')
tick_through(YESTERDAY, SETTLED)
check('all day: the same scan clears it',
      reason_for(nid, YESTERDAY) is None, reason_for(nid, YESTERDAY))
check('and the day is judged, not left open',
      storage.qr_judgment_exists(nid, YESTERDAY))
check('outcomes reads the same day the same way',
      [o['outcome'] for o in qr_judge.outcomes(YESTERDAY, YESTERDAY)
       if o['node_id'] == nid] == ['success'])

# A scan at 23:59 counts; one at 00:30 is a fact about the NEXT day. The bound
# is the wall day.
fresh()
nid = storage.qr_create_node('Gym', 'tok-allday-3', '06:00', '08:00')
storage.qr_update_node(nid, {'all_day': 1})
scan(nid, _date_plus_day(YESTERDAY), '00:30')
tick_through(YESTERDAY, SETTLED)
check('a scan after midnight does NOT reach back into the all-day it followed',
      reason_for(nid, YESTERDAY) == 'absent', reason_for(nid, YESTERDAY))

node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
check('an all-day gate settles at midnight, not at its decorative window',
      qr_judge.settle_after(node, YESTERDAY, ('06:00', '08:00', 0))
      == datetime.fromisoformat(_date_plus_day(YESTERDAY) + 'T00:00:00'),
      qr_judge.settle_after(node, YESTERDAY, ('06:00', '08:00', 0)))

# THE STUDY CASE, which is what was actually asked for: hours reported in the
# evening against a daytime window. The number was always dated rather than
# timed (study_entry is keyed by DAY), so the only thing cutting it off was the
# day being judged when the window closed.
TODAY = date_cls.today().isoformat()

fresh()
nid = storage.qr_create_node('Study', 'tok-allday-4', '09:00', '17:00')
storage.qr_update_node(nid, {'proof_mode': 'hours', 'target_minutes': 60})
tick_through(TODAY, datetime.fromisoformat(TODAY + 'T18:00:00'))
check('control: an hours gate is judged the moment its window closes',
      storage.qr_judgment_exists(nid, TODAY))

fresh()
nid = storage.qr_create_node('Study', 'tok-allday-5', '09:00', '17:00')
storage.qr_update_node(nid, {'proof_mode': 'hours', 'target_minutes': 60,
                             'all_day': 1})
tick_through(TODAY, datetime.fromisoformat(TODAY + 'T18:00:00'))
check('all day: 18:00 is too early to judge it -- the evening is still owed',
      not storage.qr_judgment_exists(nid, TODAY))
storage.put_study_entry(nid, TODAY, 90)
qr_judge.judge(now=datetime.fromisoformat(_date_plus_day(TODAY) + 'T00:05:00'))
check('and hours reported at 20:00 earn the day when it does settle',
      storage.qr_judgment_exists(nid, TODAY) and reason_for(nid, TODAY) is None,
      reason_for(nid, TODAY))

# -- and the 24h teeth still bite --
check('turning the window off is a loosening',
      qr_judge.is_loosening('all_day', 0, 1) is True)
check('putting it back in charge is immediate',
      qr_judge.is_loosening('all_day', 1, 0) is False)

fresh()
nid = storage.qr_create_node('Gym', 'tok-allday-7', '06:00', '08:00')
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
imm, pend = qr_judge.schedule_node_patch(node, {'all_day': 1})
check('so making a gate all-day waits 24h rather than applying now',
      imm == {} and list(pend) == ['all_day'] and pend['all_day']['value'] == 1,
      (imm, pend))
node = dict(node, all_day=1)
imm, pend = qr_judge.schedule_node_patch(node, {'all_day': 0})
check('and taking it back applies at once',
      imm == {'all_day': 0} and pend == {}, (imm, pend))

# RESUMING A PAUSED GATE (2026-09-30, Quentin's report: set Paused -> Active,
# saved, and it stayed paused). /activate only cancelled a PENDING pause; a
# gate already off stayed off while the sheet said "active". Resuming is a
# tightening and applies at once.
fresh()
storage.set_setting('last_backup_date', date_cls.today().isoformat())
import app as app_mod   # noqa: E402
client = app_mod.app.test_client()
nid = storage.qr_create_node('Resume', 'tok-resume-1', '06:00', '08:00')
storage.qr_update_node(nid, {'active': 0})
r = client.patch(f'/api/accountability/nodes/{nid}/activate')
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
check('resuming a paused gate turns it on at once',
      r.status_code == 200 and node['active'] == 1, (r.status_code, node['active']))
client.patch(f'/api/accountability/nodes/{nid}/disable')
node = [n for n in storage.qr_get_nodes() if n['id'] == nid][0]
check('pausing it again still waits 24h', node['active'] == 1, node['active'])
client.patch(f'/api/accountability/nodes/{nid}/activate')
check('and resuming calls that queued pause off',
      not any(p['field'] == 'active' for p in storage.qr_get_pending_changes(nid)),
      storage.qr_get_pending_changes(nid))


# THE ROUTINE MODE IS REFUSED AT THE DOOR (2026-10-05), in words. (Here, after
# the app is imported: it holds the db open, so no fresh() may follow.)
nid = storage.qr_create_node('Wake', 'tok-rg-2', '06:00', '08:00')
r = client.patch(f'/api/accountability/nodes/{nid}', json={'proof_mode': 'routine'})
check('PATCH proof_mode=routine is refused',
      r.status_code == 400 and 'routine gates are gone' in (r.get_json() or {}).get('error', ''),
      (r.status_code, r.get_json()))
check('...and the gate keeps its proof', node_row(nid)['proof_mode'] == 'link',
      node_row(nid)['proof_mode'])

# ── PENDINGS ARE PER FIELD ───────────────────────────────────────────────
nid = storage.qr_create_node('Sleep', 'tok-ease-2', '21:00', '23:00',
                             lat=40.0, lng=-75.0, radius=100)
client.patch(f'/api/accountability/nodes/{nid}', json={'geofence_radius_m': 300})
client.patch(f'/api/accountability/nodes/{nid}', json={'window_end': '22:30'})
fields = sorted(p['field'] for p in storage.qr_get_pending_changes(nid))
check('queueing a second easing does not delete the first',
      fields == ['geofence_radius_m', 'window_end'], fields)

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
