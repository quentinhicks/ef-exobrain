# The QR judge. Was a Cloudflare Worker cron (2026-08-08); now a systemd timer
# on the same box as the database, so it reads scans directly instead of over
# an authenticated HTTP hop.
#
# JUDGMENT IS PRESENCE-ONLY: a window is judged the moment it closes, and the
# test is a satisfying scan (geofence-passing where a geofence is set). The
# retired to-do gate is gone, and so is the routine gate (2026-10-05) — a QR URL
# is location proof.
#
# CHARGING IS NOT PORTED. The Worker's money path was disabled at five layers
# and re-enabling it is a deliberate, staged protocol (QR-accountability/
# RE-ENABLE.md). Bringing it across as dead code would have quietly recreated
# the thing that took money unexpectedly. Failures are still recorded in
# qr_charge_log with charge_status='would_fire', so the app's ✓/✗ colouring is
# unchanged — only the money is gone.
#
# qr_charge_log is a FAILURE log: no row is written when a window is satisfied,
# and outcomes() recomputes success from the scans instead. See the note in
# judge() — this is deliberate, not an omission.
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date as date_cls, datetime, timedelta

import storage
import schedule

# The process runs in the app's timezone — but only because __main__ calls
# storage.apply_timezone() itself. It does NOT inherit it: this is a separate
# process on a systemd timer, and for its whole life this comment claimed
# otherwise while the process actually ran under the OS zone. That zone is
# load-bearing here (mktime → UTC scan bounds, which day is "yesterday", when
# a 24h pending lands), and it decides real charges.
DOW = '0123456'  # 0 = Monday .. 6 = Sunday, matching recurring_task.days_of_week


def _dow_of(ymd):
    return str(datetime.strptime(ymd, '%Y-%m-%d').weekday())


def _date_plus(ymd, days):
    return (datetime.strptime(ymd, '%Y-%m-%d').date() + timedelta(days=days)).isoformat()


# THE DAY A WINDOW CLOSES ON. One spelling: this was `if offset` in one place
# and `offset == 1` in three others, which agree only while the offset is
# exactly 0 or 1 — and window_end_offset_days is an INTEGER column. The client
# had a third spelling (`off ? 1440 : 0`). A window's close date is not a
# question three functions should each answer.
def close_date_of(ymd, offset):
    return _date_plus(ymd, int(offset or 0))


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def weekly_window_for(node, ymd):
    raw = node.get('weekly_windows')
    if not raw:
        return None
    try:
        weekly = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return weekly.get(_dow_of(ymd)) or None


def source_window_for(node, ymd, resolve=None):
    """The gate's window for a date, taken from its SCHEDULE SOURCE (2026-08-11).

    A gate is judged once per date — `qr_scan` and `qr_charge_log` are both
    UNIQUE(node_id, date) — so a source yielding two intervals on one day
    contributes the first one that STARTS that day. That last part is the whole
    subtlety: day_intervals clips at both edges, so a 23:00→07:00 gate appears on
    every date twice, as last night's tail (00:00–07:00) and tonight's head
    (23:00–24:00). Taking the earliest would judge the tail and silently turn a
    sleep gate into a 7-hour morning window.
    """
    occ = _starting_occurrence(node, ymd, resolve)
    if not occ:
        return None
    start, end = occ
    return (start.strftime('%H:%M'), end.strftime('%H:%M'),
            (end.date() - start.date()).days)


def _starting_occurrence(node, ymd, resolve=None):
    """The occurrence that STARTS on `ymd`, unclipped.

    Deliberately not day_intervals(): that clips to the day, so a 23:00→07:00
    window comes back as 23:00–24:00 and the gate would be judged as closing at
    midnight. A gate needs the real end and the day offset, which only the raw
    occurrence carries.
    """
    uid = node.get('source_uid')
    if not uid:
        return None
    if resolve is None:
        resolve, _ = storage.schedule_resolver()
    src = resolve(uid)
    if not src:
        return None
    day = date_cls.fromisoformat(ymd)
    try:
        occs = schedule.occurrences(src, resolve, day, day)
    except schedule.Cycle:
        return None
    return next(((s, e) for s, e in occs if s.date() == day), None)


def resolve_window(node, ymd, override=None):
    # date override > SOURCE > weekly window > node defaults. This ordering is
    # mirrored in the timeline, the engage day and the Gates panel; changing it
    # here without changing them makes the app disagree with the judge.
    #
    # The source sits above the legacy columns rather than replacing them: the
    # adoption is additive (storage._adopt_gate_schedules), so a gate whose
    # source is somehow missing still judges against the window it always had.
    # A SEALED day is judged against the window it was sealed with, so that
    # is the answer for it everywhere (see THE COMMITMENT, above judge()).
    sealed = storage.qr_sealed_window(node['id'], ymd)
    if sealed:
        return sealed
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override:
        # A day override is a deliberate decision about THIS day, so it stands as
        # written.
        return (override['window_start'], override['window_end'],
                override.get('window_end_offset_days') or 0)
    from_source = source_window_for(node, ymd)
    if from_source:
        return from_source
    weekly = weekly_window_for(node, ymd)
    if weekly:
        return (weekly['window_start'], weekly['window_end'],
                weekly.get('window_end_offset_days') or 0)
    return (node['window_start'], node['window_end'],
            node.get('window_end_offset_days') or 0)


def _hhmm_min(hhmm):
    h, m = str(hhmm).split(':')
    return int(h) * 60 + int(m)


def applies_on(node, ymd, override=None):
    # THE DAY OFF WINS OVER EVERY SCHEDULE. A skip is a deliberate day-level
    # decision made on the day-level surface, so it is asked first and answered
    # here rather than at each of the four callers — this function is the ONE
    # place "does this gate run on this date" is answered, and the judge, the
    # outcomes, the drawn windows and the read-out all reach it. A skipped day
    # therefore lands 'n/a' by the same road a non-run weekday does: judged,
    # frozen, and never charged.
    #
    # `override` mirrors resolve_window's parameter exactly: outcomes() has the
    # whole range prefetched and must not go back to the db per day.
    # A SEALED day runs: it was committed when its window opened, and nothing
    # after that reaches it (THE COMMITMENT, above judge()).
    if storage.qr_sealed_window(node['id'], ymd):
        return True
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override and override.get('skipped'):
        return False
    # A RETIRED PROOF NEVER RUNS. Routine gates are gone (2026-10-05): nothing
    # runs a routine any more, so a row still saying 'routine' has nothing that
    # could clear it, and a gate nothing can clear is not a commitment, it is a
    # daily charge. The PATCH route refuses the mode; this is the lock on the
    # safe end for a row that somehow still carries it. Asked BEFORE the
    # schedule branches below, both of which RETURN. Lands 'n/a' by the same
    # road a non-run weekday does: judged, frozen, never charged.
    if is_retired_proof(node):
        return False
    # With a source, "does it run today" is whether the source has an occurrence
    # — days_of_week is only the fallback for a gate that has no source yet.
    # A gate RUNS on a date when its schedule has an occurrence STARTING that
    # date — not merely covering it, or a Monday 23:00 gate would also claim
    # Tuesday, which is the day its window happens to end on.
    if node.get('source_uid'):
        resolve, _ = storage.schedule_resolver()
        if resolve(node['source_uid']):
            return bool(_starting_occurrence(node, ymd, resolve))
    days = node.get('days_of_week')
    return days is None or _dow_of(ymd) in str(days)


def _local_dt(ymd, hhmm):
    return datetime.strptime(ymd + ' ' + hhmm, '%Y-%m-%d %H:%M')


def _utc_iso(ymd, hhmm):
    # Window times are LOCAL wall clock; qr_scan.scanned_at is UTC with a Z
    # (the format the Worker wrote, kept so migrated rows and new ones compare
    # the same way). Converting here is load-bearing: comparing a naive local
    # bound against a UTC timestamp as strings silently misses every scan that
    # falls after local midnight in UTC — which for a 21:45 window is ALL of
    # them, so every night would have judged absent.
    #
    # mktime reads the tuple in the PROCESS timezone and handles DST, which is
    # the same convention the rest of the app dates things by.
    epoch = time.mktime(time.strptime(ymd + ' ' + hhmm, '%Y-%m-%d %H:%M'))
    return datetime.utcfromtimestamp(epoch).strftime('%Y-%m-%dT%H:%M:%S.000Z')


# ── ONE GATE, ONE PROOF, ONE VERDICT (2026-09-02, Quentin's instruction) ──
#
# This REPLACES the 50/50 split of 2026-08-22, which priced a scan and a linked
# routine as two halves of one stake. The split was itself a fix for an
# all-or-nothing rule that left a missed morning with no reason to do the
# routine at all — but it fixed that by coupling two commitments to one price,
# and coupling is what was actually wrong. Separated, nothing is ever
# pre-lost: each checkpoint keeps its own live incentive all day, and no
# checkpoint's failure discounts another's.
#
# So a gate is cleared by exactly ONE kind of proof, named in proof_mode:
#
#   'link' / 'tag'  a scan inside the window          (scan_satisfies)
#   'hours'         a number that meets the day's bar (hours_satisfies)
#
# 'routine' (its linked routine, finished) was the third until 2026-10-05,
# when routines became plain lists and nothing ran them any more. A row that
# still says it never runs — see is_retired_proof.
#
# THERE IS NO PARTIAL CREDIT ANY MORE. credit_pct is still written — 100 on a
# pass, 0 on a fail — and judged_outcome still reads the 50s frozen into rows
# judged under the split, because a judged day is frozen and history says what
# it said. Nothing can write a 50 again.


def day_verdict(node, ymd, scans, now=None, hours=None):
    """Did this gate's day pass? (ok, reason). THE one answer.

    `reason` is NULL on a pass — a row with no failure_reason is a judged
    success, which is what the freeze made a row mean (qr_reserve_judgment).
    """
    if is_hours_gate(node):
        # A number, not a scan.
        passed = (hours or hours_satisfies(node, ymd))[0]
        return (True, None) if passed else (False, 'hours_short')

    return ((True, None) if any(scan_satisfies(node, sc) for sc in scans)
            else (False, 'absent'))


def settle_after(node, ymd, window):
    """The moment this day can be judged without the answer still moving.

    A gate proved by a SCAN or by a NUMBER settles when its window closes:
    nothing about the day can change after that, which is what a window is.
    """
    if is_all_day(node):
        # The wall day ends, and with it the last minute that could have
        # cleared this gate: a scan or a number at 00:30 is a fact about the
        # new day, not the old one.
        return _local_dt(_date_plus(ymd, 1), '00:00')
    start, end, offset = window
    return _local_dt(close_date_of(ymd, offset), end)


# How far back a judge that has been down will reach. Bounded so a database
# restored from an old backup, or a gate created long ago, cannot walk a month.
BACKFILL_MAX_DAYS = 14


def _days_to_judge(node, today):
    # Always the normal two; further back only to the day after the last one
    # judged, so a running judge does exactly what it always did.
    yesterday = _date_plus(today, -1)
    last = storage.qr_last_judged_date(node['id'])
    first = _date_plus(today, -BACKFILL_MAX_DAYS)
    if last and last >= first:
        first = _date_plus(last, 1)
    older = []
    ymd = first
    while ymd < yesterday:
        older.append(ymd)
        ymd = _date_plus(ymd, 1)
    return older + [yesterday, today]


# ── THE COMMITMENT (2026-10-01, Quentin's instruction: simplify the money
# route so this stops happening) ──────────────────────────────────────────
#
# Every money bug before this had one shape: the judge decided AFTER a window
# closed what the day's commitment had been, by reading the settings as they
# were THEN — active, armed, run-days, window, skip, tag — so a change
# between the window and the judgment re-judged the past under the new value.
# Each was patched one setting at a time (n/a rows, row_revision, the skip
# store, armed_at, paused gates), and the next feature had to remember all of
# them, because a day with NO record was a candidate for a charge.
#
# The default is inverted. A day is at stake only if the judge SAW IT COMING:
#
#   1. Every tick before a window opens refreshes a provisional commitment —
#      the resolved window, the proof terms, and the stake if charging is
#      armed — or drops it if the gate is paused, off that day or called off.
#   2. The first tick after it opens SEALS that row, provided it was refreshed
#      within COMMIT_LEAD_MIN of the opening and the gate is still running.
#      The stake survives only if charging is still armed. Otherwise there is
#      no commitment for the day at all.
#   3. At settle the judge reads ONLY the sealed row and the proof. No sealed
#      row: 'n/a', never money. Money also needs charging armed at that moment
#      — turning it off is immediate.
#
# So nothing done after a window opens can reach that day: not resuming, not
# arming, not editing, not the judge having been down. A sealed
# window is also what resolve_window and applies_on answer for that day, so
# the calendar and the read-outs show the window being judged.
COMMIT_LEAD_MIN = 15


def day_opens_at(node, ymd, window):
    # The moment a day stops being provisional. An all-day gate is the whole
    # wall day, so it opens at midnight.
    if is_all_day(node):
        return _local_dt(ymd, '00:00')
    return _local_dt(ymd, window[0])


# The node fields the verdict reads, stamped so a change after the seal
# (link -> tag is immediate; a target raised mid-day) cannot reach the day.
COMMIT_TERMS = ('proof_mode', 'all_day', 'target_minutes', 'geofence_lat')


def committed_node(node, commitment):
    return dict(node, **json.loads(commitment.get('terms') or '{}'))


def _commit(node, ymd, now, settings):
    c = storage.qr_get_commitment(node['id'], ymd)
    if c and c['sealed_at']:
        return
    if storage.qr_judgment_exists(node['id'], ymd):
        return
    runs = bool(node['active']) and applies_on(node, ymd)
    window = resolve_window(node, ymd)
    opens = day_opens_at(node, ymd, window)
    if now < opens:
        if runs:
            terms = json.dumps({k: node.get(k) for k in COMMIT_TERMS})
            stake = node_charge_cents(node, settings) if settings['live'] else None
            storage.qr_put_commitment(node['id'], ymd, window, terms, stake,
                                      now.isoformat(timespec='seconds'))
        else:
            storage.qr_drop_commitment(node['id'], ymd)
        return
    if not c:
        return
    seen = datetime.fromisoformat(c['checked_at'])
    if runs and seen >= opens - timedelta(minutes=COMMIT_LEAD_MIN):
        storage.qr_seal_commitment(node['id'], ymd, now.isoformat(timespec='seconds'),
                                   c['staked_cents'] if settings['live'] else None)
    else:
        storage.qr_drop_commitment(node['id'], ymd)


def _settle(node, ymd, now, today, lines):
    if storage.qr_judgment_exists(node['id'], ymd):
        return
    c = storage.qr_get_commitment(node['id'], ymd)
    if not (c and c['sealed_at']):
        # Nothing was committed: the gate was paused, off that day, called
        # off, charging could not see it coming — or the judge was down. Frozen
        # 'n/a' once the day can no longer be committed, which is the record
        # saying so, and never a charge.
        window = resolve_window(node, ymd)
        if now >= settle_after(node, ymd, window):
            storage.qr_drop_commitment(node['id'], ymd)
            storage.qr_reserve_judgment(node['id'], ymd, None, 'n/a', None, window=window)
        return

    term = committed_node(node, c)
    window = (c['window_start'], c['window_end'], c['offset_days'] or 0)
    if now < settle_after(term, ymd, window):
        return
    if is_retired_proof(term):
        # Sealed under a proof that no longer exists (a routine gate sealed
        # before 2026-10-05): nothing can be asked of it, so the day is the
        # record of a gate that did not run — 'n/a', never money.
        storage.qr_reserve_judgment(node['id'], ymd, None, 'n/a', None, window=window)
        return
    open_iso, close_iso = day_scan_bounds(term, ymd, window)
    scans = storage.qr_scans_in_window(node['id'], open_iso, close_iso)
    # The bucket is a running total, so it is resolved ONCE and stamped: a
    # correction to last Tuesday must not rewrite what Wednesday was owed.
    hrs = hours_satisfies(term, ymd) if is_hours_gate(term) else None
    stamp = (hrs[2], hrs[1], hrs[3]) if hrs else None
    _ok, reason = day_verdict(term, ymd, scans, now, hours=hrs)
    if reason is None:
        storage.qr_reserve_judgment(node['id'], ymd, None, 'ok', None, window=window,
                                    credit_pct=100, hours=stamp)
        return
    if ymd < _date_plus(today, -1):
        # A judge that was down past the day after: judged and frozen, never
        # charged. Only yesterday and today may touch money.
        if storage.qr_reserve_judgment(node['id'], ymd, reason, 'stale', None,
                                       window=window, credit_pct=0, hours=stamp):
            lines.append('X   %s (%s): %s -> stale' % (node['label'], ymd, reason))
        return
    status = charge_for_failure(term, ymd, reason, c['staked_cents'],
                                window=window, hours=stamp)
    if status is not None:
        lines.append('X   %s (%s): %s -> %s' % (node['label'], ymd, reason, status))


def judge(now=None, verbose=False):
    now = now or datetime.now()
    today = now.date().isoformat()
    lines = []

    applied = storage.qr_apply_due_pending_changes(now.isoformat())
    for a in applied:
        lines.append('applied pending %s on node %s' % (a['field'], a['node_id']))

    settings = charge_settings()
    for node in storage.qr_get_nodes():
        # Yesterday too: a +1d window opens on its date and may still be open
        # after midnight. Tomorrow so a window opening just past midnight has
        # its provisional row from the ticks before it.
        for ymd in (_date_plus(today, -1), today, _date_plus(today, 1)):
            _commit(node, ymd, now, settings)
        for ymd in _days_to_judge(node, today):
            _settle(node, ymd, now, today, lines)

    if verbose:
        for line in lines:
            print(line)
    return lines


def outcomes(from_date, to_date, now=None):
    # The ✓/✗ the app paints on QR hairlines. READ from the judgment where one
    # exists — the day was decided when it closed and does not get a second
    # opinion from a config that has moved since (2026-08-17). Only a closed
    # day the judge never reached is still derived from its scans, which is
    # what history written before the freeze is. Windows that have not closed
    # yet are omitted entirely — neutral, not failed, which is why an un-judged
    # QR renders plain.
    now = now or datetime.now()
    judged = {(j['node_id'], j['date']): j
              for j in storage.qr_judgments_between(from_date, to_date)}
    overrides = {(o['node_id'], o['date']): o
                 for o in storage.qr_overrides_between(from_date, to_date)}
    # A +1d window opening on to_date can close as late as the end of to+1.
    scans = storage.qr_scans_between(_utc_iso(from_date, '00:00'),
                                     _utc_iso(_date_plus(to_date, 2), '00:00'))
    by_node = {}
    for s in scans:
        by_node.setdefault(s['node_id'], []).append(s)

    out = []
    for node in storage.qr_get_nodes(active_only=True):
        ymd = from_date
        while ymd <= to_date:
            if not applies_on(node, ymd, overrides.get((node['id'], ymd))):
                ymd = _date_plus(ymd, 1)
                continue
            start, end, offset = resolve_window(
                node, ymd, overrides.get((node['id'], ymd)))
            open_iso, close_iso = day_scan_bounds(node, ymd, (start, end, offset))
            # WHEN the day stops moving, asked of the judge's own function
            # rather than re-derived from the window — an all-day gate closes
            # at midnight, and painting it as failed while it was still
            # winnable is the bug this avoids.
            settles = settle_after(node, ymd, (start, end, offset))
            j = judged.get((node['id'], ymd))
            if j and j['charge_status'] == 'n/a':
                # Frozen as "the gate did not run that day" — neutral, exactly
                # as an applies_on miss is, even if it would apply now.
                ymd = _date_plus(ymd, 1)
                continue
            if j:
                # A judged day is read back, never re-derived. Which of the
                # three it was comes from the AMOUNT against the stake: a half
                # charge is a half-met day, and calling that "failed" would
                # hide the half that was met — the thing the split exists to
                # make visible.
                out.append({'node_id': node['id'], 'date': ymd,
                            'outcome': judged_outcome(j)})
            elif now >= settles:
                # A closed day the judge never reached. An hours gate is asked
                # its own predicate here — the SAME function judge() uses, which
                # is the point of there being one. Deriving it from scans would
                # paint every such day failed, since an hours gate has no scans
                # at all.
                if is_hours_gate(node):
                    ok = hours_satisfies(node, ymd)[0]
                else:
                    ok = any(
                        open_iso <= s['scanned_at'] <= close_iso and scan_satisfies(node, s)
                        for s in by_node.get(node['id'], []))
                out.append({'node_id': node['id'], 'date': ymd,
                            'outcome': 'success' if ok else 'failed'})
            ymd = _date_plus(ymd, 1)
    return out


# ── The 24h gates ─────────────────────────────────────────────────────────
#
# The whole accountability system rests on not being able to weaken a
# commitment in the moment you want to dodge it. TIGHTENING applies at once;
# LOOSENING waits 24 hours, by which time the window you were avoiding has
# passed. Ported verbatim from the Worker — these predicates ARE the teeth.

LOOSEN_DELAY_H = 24


def judged_outcome(judgment):
    """success / partial / failed, READ off a judgment row, never re-derived.

    Asked in one place so the timeline, the day read-out and anything later
    cannot disagree about what a half-charged day was. credit_pct is NULL on
    rows written before the split — and those rows meant the whole stake, so a
    missing value is a plain failure, which is what they were.

    NO NEW ROW CAN BE PARTIAL (2026-09-02): the split is gone and credit_pct is
    now only 100 or 0. 'partial' is kept because the rows judged between
    2026-08-22 and then carry 50, a judged day is FROZEN, and re-scoring them
    as plain failures would rewrite what they cost. Do not delete this branch
    to tidy up a state nothing writes; it is history, not dead code.
    """
    if not judgment.get('failure_reason'):
        return 'success'
    return 'partial' if (judgment.get('credit_pct') or 0) > 0 else 'failed'


def scan_satisfies(node, scan):
    """Does this scan clear that gate? THE one answer, asked in two places.

    It was written twice — once in judge() and once in outcomes() — and the two
    copies agreed right up until a third kind of proof existed. They read this
    now, so the history the app draws and the day the judge charges for cannot
    disagree about what counted.

    HARD ('tag') means a verified NTAG 424 DNA tap and nothing else: not a link,
    not a geofence, however honest either looks. That is the whole point of the
    hard mode — a link can be opened anywhere and a geofence is a claim made by
    software you control, while a tap needs the tag in your hand.

    SOFT ('link') keeps the old rule — the link, geofenced where a fence is set
    — and accepts a tap too, because a tap is strictly stronger evidence than
    the thing being asked for.
    """
    if (node.get('proof_mode') or 'link') == 'tag':
        return scan.get('proof') == 'tag'
    if scan.get('proof') == 'tag':
        return True
    return node.get('geofence_lat') is None or scan.get('geofence_pass') == 1


# ── The hours gate (2026-09-02, Quentin's design) ────────────────────────
#
# A THIRD kind of proof, and scan_satisfies' own docstring predicted it: the
# answer was written twice and the copies agreed right up until a third kind
# existed. So this is one function with the same two callers — judge() and
# outcomes() — and nothing anywhere re-derives it.
#
# The commitment is an average, not a day: T minutes a day, with a BUCKET of
# credit carried forward, so a long Saturday genuinely buys down Sunday.
#
#     R  = T - B                      what today owes
#     pass (H >= R):  B' = B + H - T
#     fail (H <  R):  B' = B + H // 2   and the stake is charged
#
# Two properties worth naming, because both are deliberate and neither is
# obvious. A failed day still banks half of what was worked, so B never falls
# on a miss and tomorrow's bar is never RAISED by failing — money settles a bad
# day, not carried debt, which is what stops the unpayable spiral every
# cumulative system dies of. And the bucket needs no cap, because a pass always
# subtracts the full T: an overworked bucket drains at T a day on its own.
#
# INTEGER MINUTES throughout. 2400/7 = 342.857... has no exact float and
# `H >= R` is a money decision made exactly at that boundary.
DEFAULT_TARGET_MINUTES = 343          # 2400 a week / 7 = 5h43m


def target_minutes(node):
    v = node.get('target_minutes')
    # NULL means the default, never zero — the charge_cents rule. A gate whose
    # target read as 0 would pass every day forever without saying so.
    return int(v) if v not in (None, '') else DEFAULT_TARGET_MINUTES


def hours_satisfies(node, ymd, bucket_in=None):
    """Did this day meet its requirement? (passed, logged, required, bucket_after).

    All four in integer minutes. `bucket_in` is read from the last judged day
    that carried one unless a caller already has it — never recomputed by
    walking the history, because the whole point of stamping it is that a later
    correction cannot reach back through it.
    """
    t = target_minutes(node)
    b = storage.qr_bucket_before(node['id'], ymd) if bucket_in is None else bucket_in
    req = t - b
    logged = storage.study_entry_minutes(node['id'], ymd)
    passed = logged >= req
    # Floor on the failed half: the bucket never overstates the credit it holds.
    after = (b + logged - t) if passed else (b + logged // 2)
    return passed, logged, req, after


def is_hours_gate(node):
    return (node.get('proof_mode') or 'link') == 'hours'


# A PROOF THAT NO LONGER EXISTS (2026-10-05). 'routine' was cleared by a
# routine's run, and the runner is gone. The ONE answer, asked by applies_on
# (the gate never runs) and _settle (a day sealed under it lands 'n/a').
def is_retired_proof(node):
    return (node.get('proof_mode') or 'link') == 'routine'


# ── ALL DAY: the window stops judging (2026-09-03, Quentin's instruction) ──
#
# A morning routine has a time it is MEANT to happen at and a commitment that
# is really "today"; study hours are a number owed by the day and nothing about
# a clock. Both were being judged against a window that existed to place the
# pill. So this predicate is the ONE answer to "does this gate's window judge".
#
# What the window still does, on every gate: `applies_on` decides which DAYS
# from the schedule and the pill draws at the window. What it stops doing is
# deciding whether the day was met.
def is_all_day(node):
    return bool(node.get('all_day'))


def day_scan_bounds(node, ymd, window):
    """The UTC range a scan must land in to count for `ymd`. ONE answer.

    Asked in three places — judge(), outcomes() and the gate read-out — which
    is exactly the shape scan_satisfies was written in twice before it became
    one function. An all-day gate takes the whole LOCAL day; every other gate
    takes its resolved window, tail included.

    An all-day gate ignores `window_end_offset_days` deliberately: the offset
    exists to carry a window past midnight, and a gate with no deadline inside
    its day has nothing to carry. The day is the date the gate is filed under.
    """
    start, end, offset = window
    if is_all_day(node):
        return _utc_iso(ymd, '00:00'), _utc_iso(_date_plus(ymd, 1), '00:00')
    return _utc_iso(ymd, start), _utc_iso(close_date_of(ymd, offset), end)


def is_loosening(field, current, nxt, node=None):
    if field == 'source_uid':
        # A source has no fields to compare, so the question is asked of the
        # OCCURRENCES: has the new schedule stopped covering a minute the old one
        # covered? See schedule.demands_less — it catches weekly→monthly, a moved
        # anchor and an added end date, none of which is a loosened field.
        resolve, _ = storage.schedule_resolver()
        old, new = resolve(current), resolve(nxt)
        if not old or not new:
            return bool(old) and not new      # losing the schedule entirely is looser
        try:
            return schedule.demands_less(old, new, resolve, date_cls.today())
        except schedule.Cycle:
            return True                       # cannot prove it is tighter
    if field == 'target_minutes':
        # LOWERING the daily target is loosening — it is the requirement
        # itself. Raising it is immediate: nothing about the delay exists to
        # stop you committing harder. A blank resolves to the DEFAULT first,
        # because that is what will actually be judged, exactly as clearing a
        # stake does.
        cur = target_minutes({'target_minutes': current})
        new = target_minutes({'target_minutes': nxt})
        return new < cur
    if field == 'charge_cents':
        # LOWERING the stake is loosening, so it waits 24h like every other
        # way of making a gate easier. Raising it is immediate: nothing about
        # the delay exists to protect you from committing harder. Clearing it
        # back to the default counts as whichever direction that move is.
        # A blank resolves to the DEFAULT, because that is what will actually
        # be charged — comparing the raw values would let clearing a $9 stake
        # down to a $2 default through immediately, which is the loophole.
        default = charge_settings()['default_cents']
        cur = int(current) if current not in (None, '') else default
        new = int(nxt) if nxt not in (None, '') else default
        return new < cur
    if field == 'window_start':
        return str(nxt) > str(current)          # a later start is less demanding
    if field == 'window_end':
        return str(nxt) < str(current)          # an earlier end is less demanding
    if field == 'window_end_offset_days':
        return (nxt or 0) < (current or 0)
    if field == 'geofence_radius_m':
        return (nxt or 0) > (current or 0)      # a wider fence is easier to satisfy
    if field == 'days_of_week':
        # Dropping any applied day is loosening; adding days is tightening.
        return any(d not in str(nxt) for d in str(current or ''))
    if field == 'weekly_windows':
        # Per-day windows: if ANY weekday's effective window loosens against
        # its current effective state, the whole change waits. Comparing the
        # merged view (weekly entry over node defaults) is what stops a day
        # being loosened by deleting its entry and falling back to a slacker
        # default.
        def parse(v):
            if not v:
                return {}
            try:
                return json.loads(v)
            except (ValueError, TypeError):
                return {}
        cur, new = parse(current), parse(nxt)
        base = {'window_start': node['window_start'], 'window_end': node['window_end'],
                'window_end_offset_days': node.get('window_end_offset_days') or 0}
        for d in range(7):
            c = dict(base, **(cur.get(str(d)) or {}))
            n = dict(base, **(new.get(str(d)) or {}))
            if (is_loosening('window_start', c['window_start'], n['window_start'])
                    or is_loosening('window_end', c['window_end'], n['window_end'])
                    or is_loosening('window_end_offset_days',
                                    c.get('window_end_offset_days') or 0,
                                    n.get('window_end_offset_days') or 0)):
                return True
        return False
    if field == 'all_day':
        # Turning the window off is the loosest thing a gate can be told short
        # of being deleted: a 06:00 deadline becomes "sometime today". It
        # waits 24h. Putting the window back in charge is a tightening and
        # applies at once, cancelling any queued easing, like every other
        # field.
        return not _falsy(nxt) and _falsy(current)
    if field == 'active':
        # Switching a gate OFF is the purest loosening there is. The dedicated
        # /disable route always queued it 24h; this predicate had no branch for
        # it, so the generic PATCH {'active': false} went through at once —
        # 20:55, five minutes before a 21:00 deadline, and tonight is not
        # judged. Turning one back ON is tightening and applies immediately.
        return _falsy(nxt) and not _falsy(current)
    if field == 'proof_mode':
        # ONE provable tightening, and everything else waits (2026-09-02).
        # link -> tag is the only
        # move that unambiguously demands MORE: the gate stops accepting a URL
        # you can open from bed and starts needing the object in your hand. It
        # applies at once, but only where a live tag exists to clear it with,
        # which app.py refuses at the door rather than pending.
        #
        # Every other move swaps one kind of proof for a DIFFERENT kind, and
        # there is no scale on which a scan and a number can be compared — so
        # none of them is proven tighter, and the allowlist rule says they
        # wait. This branch used to read `current == 'tag'`, which was
        # blacklist-shaped: link -> hours fell through as a tightening and
        # applied instantly on the money path. (Moving TO 'routine' is refused
        # at the door since 2026-10-05; moving off it waits like any swap.)
        return not (str(current) != 'tag' and str(nxt) == 'tag')
    if field in ('geofence_lat', 'geofence_lng'):
        # A fence cannot be proven tighter by comparing coordinates: moving it
        # is loosening for the place you were meant to be, and CLEARING it
        # makes any scan anywhere satisfy the gate. Adding one where there was
        # none is the only direction that is unambiguously tightening.
        if current in (None, ''):
            return False
        return str(nxt) != str(current)
    # NO PREDICATE MEANS NOT PROVEN TIGHTER. The fallthrough used to be False,
    # which made this an opt-in blacklist: any field nobody had thought about
    # applied instantly on the money path. It is an allowlist now — a new
    # QR_NODE_FIELDS entry waits 24h until someone writes its branch.
    return True


def _falsy(v):
    # '0' is a true string in Python, and these values arrive from JSON and
    # from the pending store as both types. ONE definition, in storage, because
    # the future-day projection (storage.row_as_of's callers) has to read a
    # queued `active` exactly the way the judge does.
    return storage.falsy(v)


def override_locked(node, ymd, now=None):
    # A day's deadline locks once its effective close is within 24h: the
    # override can no longer be created, moved OR removed. Removal is included
    # on purpose — deleting an override that made a day harder would otherwise
    # be a loophole straight back to the slacker default.
    now = now or datetime.now()
    start, end, offset = resolve_window(node, ymd)
    close_date = close_date_of(ymd, offset)
    return _local_dt(close_date, end) <= now + timedelta(hours=LOOSEN_DELAY_H)


# WITHIN THE LOCK, A DAY MAY STILL BE TIGHTENED (2026-10-08, Quentin's
# instruction: "allow me to tighten gates but not loosen them within 24
# hours"). The lock exists to stop a day being made EASIER as it comes due;
# it refused every change, so moving tonight's deadline earlier was refused
# exactly like moving it later. A window is a tightening when it lies inside
# the one in force — no scan it accepts was refused before. A translation
# accepts scans the old window did not, so it is not one, whichever way it
# goes. `window` is (start HH:MM, end HH:MM, end offset days).
def window_tightens(node, ymd, window):
    def span(w):
        s = _hhmm_min(w[0])
        return s, _hhmm_min(w[1]) + (w[2] or 0) * 1440
    ns, ne = span(window)
    cs, ce = span(resolve_window(node, ymd))
    return cs <= ns <= ne <= ce


# The only fields a change to cannot make the gate easier to satisfy. Anything
# not named here has to be PROVEN tighter by is_loosening to apply at once.
QR_IMMEDIATE_FIELDS = ('label',)


# A CHANGE CAN BE DATED FORWARD (2026-08-17), and this is the one place that
# decides WHEN one lands. Two floors, and the later of them wins:
#
#   the easing floor — now for a tightening, now + 24h for a loosening. This
#   is the teeth above, and a date cannot get underneath it: asking for a
#   loosening "from tomorrow" when tomorrow is eight hours away still waits
#   the full 24h, and the caller is told the day it really starts.
#
#   the date you asked for — local midnight of it. A change dated forward is
#   NOT applied now even when it tightens: "7am from Wednesday" must leave
#   Tuesday alone, and tightening early would be a change nobody asked for.
#
# Returns (immediate {field: value}, pending {field: {value, apply_at,
# effective_date}}). apply_at is when the ROW is rewritten; effective_date is
# the first day the change governs, and the two differ for a plain easing —
# see storage.effective_date_for.
def schedule_node_patch(node, fields, effective_from=None, now=None):
    now = now or datetime.now()
    want = None
    if effective_from:
        want = datetime.combine(date_cls.fromisoformat(effective_from),
                                datetime.min.time())
    immediate, pending = {}, {}
    for field, value in fields.items():
        if field not in storage.QR_NODE_FIELDS:
            continue
        eases = (field not in QR_IMMEDIATE_FIELDS
                 and is_loosening(field, node.get(field), value, node))
        at = now + timedelta(hours=LOOSEN_DELAY_H) if eases else now
        if want and want > at:
            at = want
        if at <= now:
            immediate[field] = value
        else:
            pending[field] = {
                'value': value, 'apply_at': at.isoformat(),
                'effective_date': storage.effective_date_for(
                    at, _governs_min(node, fields, at))}
    return immediate, pending


def _governs_min(node, fields, at):
    """The minute of `at`'s day this gate starts deciding anything.

    Its window OPENING, so effective_date_for can tell a change that is already
    in force from one that arrived too late to be. Without this every pending
    rounded up to the next day whatever the hour, which told a change made a
    day and a half before a 06:00 gate that it governed from the day after the
    one it could plainly have governed.

    Conservative in both directions it can be: a window_start in the same patch
    is taken at its EARLIEST reading, so a gate being moved earlier is judged
    against the earlier opening and never claims a day it could not have
    governed. Anything unresolvable returns None, which is the old
    always-round-up answer — late, never wrong.
    """
    try:
        start, _, _ = resolve_window(node, at.date().isoformat())
        opens = _hhmm_min(start)
    except Exception:
        return None
    want = (fields or {}).get('window_start')
    if want:
        try:
            opens = min(opens, _hhmm_min(want))
        except Exception:
            pass
    return opens


def apply_node_patch(node, fields, now=None):
    # The undated split, in the shape the callers before dates were added
    # still read: (immediate, pending) as {field: value}. One classifier —
    # this delegates rather than deciding again.
    immediate, pending = schedule_node_patch(node, fields, None, now)
    return immediate, {f: p['value'] for f, p in pending.items()}

# ── Charging ─────────────────────────────────────────────────
#
# ONE SWITCH AND THE CREDENTIALS (2026-10-01, Quentin's instruction). Money
# moves only when all three hold:
#
#   1. gate_charging_armed_at is set — written only by the arm action of
#      PATCH /api/gates/billing, cleared by disarming. That is the switch.
#   2. beeminder_auth_token is in config.json
#   3. beeminder_user is in config.json
#
# There were six (a live '1', a dry-run flag, the token, the user, the arming
# stamp and a code constant), each added to close a hole the last had left,
# and the panel needed a paragraph to say which combination was in force. The
# commitment (above judge()) is what made the extras unnecessary: a day costs
# money only if it was sealed with a stake while armed AND is still armed when
# it settles, so no switch can reach a day it did not see coming.
#
# The token lives in CONFIG.JSON, never in the database: the db is dumped to
# backups and pushed off-box, and a bearer token that moves money does not
# belong in a backup set. The panel can verify it but not read it.
BEEMINDER_CHARGES_URL = 'https://www.beeminder.com/api/v1/charges.json'
BEEMINDER_ME_URL = 'https://www.beeminder.com/api/v1/users/me.json'


def _cfg():
    try:
        with open('config.json') as f:
            return json.load(f)
    except Exception:
        return {}


def charge_settings():
    # Defaults are the SAFE end of every axis: not armed, capped, cheapest.
    cfg = _cfg()
    st = storage.get_settings() or {}
    token = cfg.get('beeminder_auth_token') or ''
    user = cfg.get('beeminder_user') or ''
    armed_at = st.get('gate_charging_armed_at') or None
    return {
        'live': bool(armed_at and token and user),
        'armed_at': armed_at,
        'cap_cents': int(st.get('gate_weekly_cap_cents') or 2500),
        'default_cents': int(st.get('gate_charge_cents') or 200),
        # A fixed per-charge card fee the card provider takes on its own
        # (Privacy.com charges one per transaction). The STAKE stays the total
        # a failure costs; Beeminder is billed stake minus this, so the fee
        # never silently raises the price of failing above what was set.
        'fee_cents': int(st.get('gate_card_fee_cents') or 0),
        'token': token,
        'user': user,
    }


def node_charge_cents(node, settings):
    # NULL on the node means "use the default", never "free" — a gate with no
    # explicit stake still costs the default, or setting one to 0 by accident
    # would silently disarm it.
    v = node.get('charge_cents')
    return int(v) if v not in (None, '') else int(settings['default_cents'])


def beeminder_charge(settings, amount_cents, note, sender=None):
    """Returns (status, charge_id): succeeded, failed (NOTHING was sent) or unknown."""
    if not settings['token'] or not settings['user']:
        return 'failed', None            # nothing was sent
    dollars = '%.2f' % max(1.0, amount_cents / 100.0)   # their minimum is $1
    body = {'auth_token': settings['token'], 'user_id': settings['user'],
            'amount': dollars, 'note': note}
    send = sender or _http_post
    try:
        ok, data = send(BEEMINDER_CHARGES_URL, body)
    except Exception:
        # The request may have REACHED Beeminder and created the charge — only
        # the response was lost. 'unknown', never 'failed': a failed charge is
        # one the system may retry, and retrying one that went through is how
        # you get billed repeatedly. 'unknown' counts against the cap for the
        # same reason.
        return 'unknown', None
    if not ok:
        return 'failed', None
    return 'succeeded', _charge_id(data)


def _charge_id(data):
    # Beeminder returns Mongo extended JSON: id is {"$oid": "6a7b64..."}, not a
    # string. Storing the dict raised sqlite3.ProgrammingError inside
    # qr_settle_charge — AFTER the money had moved, so the charge succeeded and
    # the row stayed 'charging' forever. Anything unrecognised is stringified
    # rather than dropped: a charge reference is evidence, and evidence is worth
    # keeping in whatever shape it arrives.
    cid = (data or {}).get('id')
    if isinstance(cid, dict):
        cid = cid.get('$oid') or json.dumps(cid)
    return None if cid is None else str(cid)


def _http_post(url, body):
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(url, data, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        return 200 <= r.status < 300, json.loads(r.read() or b'{}')


def verify_token(sender=None):
    """Is the configured token usable, and who does it bill? Never returns it."""
    s = charge_settings()
    if not s['token']:
        return {'valid': False, 'reason': 'no token in config.json'}
    if not s['user']:
        return {'valid': False, 'reason': 'no beeminder_user in config.json'}
    send = sender or _http_get
    try:
        ok, data = send('%s?auth_token=%s' % (BEEMINDER_ME_URL,
                                              urllib.parse.quote(s['token'])))
    except Exception as e:
        return {'valid': False, 'reason': 'could not reach beeminder: %s' % e}
    if not ok:
        return {'valid': False, 'reason': 'beeminder rejected the token'}
    name = (data or {}).get('username')
    if name and s['user'] and name != s['user']:
        return {'valid': False, 'reason': 'token belongs to %s, not %s' % (name, s['user'])}
    return {'valid': True, 'username': name or s['user']}


def _http_get(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return 200 <= r.status < 300, json.loads(r.read() or b'{}')


def charge_for_failure(node, ymd, reason, staked_cents, sender=None, window=None,
                       hours=None):
    """The whole money path for one judged failure. Returns the status stored.

    `staked_cents` is what the day's SEALED commitment put at stake — None
    when nothing was (charging was not armed when the window opened). Money
    moves only for a staked day while charging is still armed; everything
    else lands 'would_fire', judged and priced.

    Reserve BEFORE charging, and only the tick that won the reservation may
    call Beeminder. Every early return still leaves a row, so the day is
    judged exactly once whatever happens to the money. A failure costs the
    WHOLE stake; credit_pct is stamped 0 because judged_outcome reads it.
    """
    storage.qr_ensure_charge_columns()
    s = charge_settings()
    amount = int(staked_cents) if staked_cents else node_charge_cents(node, s)
    spent = storage.qr_weekly_spent_cents(ymd)
    staked = bool(staked_cents) and s['live']
    capped = staked and (spent + amount) > s['cap_cents']
    will_charge = staked and not capped

    status = 'capped' if capped else ('charging' if will_charge else 'would_fire')
    won = storage.qr_reserve_judgment(
        node['id'], ymd, reason, status, amount if will_charge else None,
        window=window, credit_pct=0, hours=hours)
    if not won:
        return None          # another tick owns this day; do not touch money

    if not will_charge:
        return status

    # The card fee is part of the stake, not on top of it: bill Beeminder the
    # remainder. The cap and the log keep the FULL stake — that is what the
    # failure costs. Beeminder's own $1 floor still applies to the remainder,
    # so a stake under fee + $1 costs slightly more than it says; set stakes
    # at or above that line.
    bill = amount - s['fee_cents']
    final, charge_id = beeminder_charge(
        s, bill, '%s: %s on %s' % (node['label'], reason, ymd), sender)
    # 'failed' means nothing was sent, so it must not count against the cap.
    storage.qr_settle_charge(node['id'], ymd, final, charge_id,
                             None if final == 'failed' else amount)
    return final


# The entry point stays at the BOTTOM of the file, and that is load-bearing:
# `if __name__ == '__main__'` runs the moment the interpreter reaches it, so
# every function judge() calls has to be defined ABOVE it. It sat mid-file and
# the charging half was ported below it, which meant the timer's judge raised
# NameError: charge_for_failure — but only on a day that actually had an
# unjudged failure to charge for. Importing the module (every test does) defines
# everything first, so the whole suite passed while production crashed.
if __name__ == '__main__':
    # Before ANY date is read. The unit file sets WorkingDirectory to the data
    # dir; run by hand from elsewhere, PT_DATA_DIR is what stops storage from
    # opening an empty tracker.db beside the code and reporting a clean run.
    _data_dir = os.environ.get('PT_DATA_DIR')
    if _data_dir and os.path.isdir(_data_dir):
        os.chdir(_data_dir)
    storage.apply_timezone()
    found = judge(verbose=True)
    # Stamped so the panel can answer "is this actually running?" — the first
    # question about a judge on a timer, and one nothing else could answer: a
    # quiet week and a dead service produce the same empty log.
    storage.set_setting('gate_judge_last_run', datetime.now().isoformat(timespec='seconds'))
    print('qr-judge: %d failure(s) recorded %s' % (len(found), datetime.now().isoformat()))
    sys.exit(0)
