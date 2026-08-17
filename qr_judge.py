# The QR judge. Was a Cloudflare Worker cron (2026-08-08); now a systemd timer
# on the same box as the database, so it reads scans directly instead of over
# an authenticated HTTP hop.
#
# JUDGMENT IS PRESENCE-ONLY: a window is judged the moment it closes, and the
# test is a satisfying scan (geofence-passing where a geofence is set). The
# retired to-do gate is gone — a QR URL is location proof plus, where a routine
# is LINKED to the gate, that routine having been done (see routine_gate_for_node).
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
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override:
        # A day override is a deliberate decision about THIS day, so it stands as
        # written — the pawn does not shorten it further. Anything else and
        # dragging tonight's deadline would silently move again.
        return (override['window_start'], override['window_end'],
                override.get('window_end_offset_days') or 0)
    from_source = source_window_for(node, ymd)
    if from_source:
        return _less_pawned(node, ymd, from_source)
    weekly = weekly_window_for(node, ymd)
    if weekly:
        return _less_pawned(node, ymd, (weekly['window_start'], weekly['window_end'],
                                        weekly.get('window_end_offset_days') or 0))
    return _less_pawned(node, ymd, (node['window_start'], node['window_end'],
                                    node.get('window_end_offset_days') or 0))


def _less_pawned(node, ymd, window):
    """The window, minus the time pawned into the routine this gate gates.

    A step pushed onto a later routine takes its minutes with it, so that routine
    has more to do inside the same window and the DEADLINE comes earlier. This is
    a tightening, so it applies at once — every easing waits 24h, and nothing here
    can ever lengthen a window.

    Applied AFTER the source/weekly/default resolution but NOT after a date
    override: an override is a deliberate day-level decision about this gate, and
    the pawn is a consequence of what you moved, so the two compose — the override
    picks the window and the pawn shortens it. (Callers reaching the override
    branch return before this, which is the one case where they do not compose;
    see the note in resolve_window.)
    """
    minutes = storage.pawned_minutes_for_node(node['id'], ymd)
    if minutes <= 0:
        return window
    start, end, offset = window
    end_min = _hhmm_min(end) + int(offset or 0) * 24 * 60 - minutes
    start_min = _hhmm_min(start)
    # Never past the opening: a gate you could not satisfy at all is a broken
    # commitment, not a demanding one.
    if end_min <= start_min:
        end_min = start_min
    new_offset, rest = divmod(end_min, 24 * 60)
    return (start, f'{rest // 60:02d}:{rest % 60:02d}', new_offset)


def _hhmm_min(hhmm):
    h, m = str(hhmm).split(':')
    return int(h) * 60 + int(m)


def applies_on(node, ymd):
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


# ── Two deadlines, not one (2026-08-15) ───────────────────────────────────
#
# A gate is satisfied by a SCAN and, where a routine is linked, by that routine.
# They are two commitments with two clocks: the window on the node is the SCAN's
# deadline, and the routine has its own. Either one missed at ITS OWN deadline
# renders the day false — the judge no longer waits for the scan window to close
# before noticing that a 21:00 routine was not done.
#
# Mirrors flowDueMin in app.js: the routine's own window where it has one, else
# the deadline it is anchored to (`before_node_id` if set, otherwise the gate it
# gates) plus `offset_min`. One rule, two implementations that must agree — the
# app draws it and the judge charges for it.


def _flow_own_end(flow, ymd, resolve=None):
    uid = flow.get('source_uid')
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
    occ = next(((s, e) for s, e in occs if s.date() == day), None)
    return occ[1] if occ else None


def routine_deadline(node, flow, ymd, resolve=None):
    """When the linked routine is due on this date, as a local datetime."""
    own = _flow_own_end(flow, ymd, resolve)
    if own:
        return own
    anchor_id = flow.get('before_node_id') or flow.get('qr_node_id')
    if not anchor_id:
        return None
    anchor = node if (node and anchor_id == node['id']) else next(
        (n for n in storage.qr_get_nodes() if n['id'] == anchor_id), None)
    if not anchor:
        return None
    _, end, offset = resolve_window(anchor, ymd)
    due = _local_dt(_date_plus(ymd, 1) if offset else ymd, end)
    # A "before X" routine is due when X closes, full stop; the offset belongs
    # to the gate it gates, not to a deadline it merely points at.
    if not flow.get('before_node_id') and flow.get('offset_min'):
        due += timedelta(minutes=flow['offset_min'])
    return due


# THE DEADLINE AS DATA (2026-08-17). app.js used to answer this itself in
# flowWindow/flowDueMin, and the two disagreed on every midnight-crossing
# window: day_intervals is CLIPPED and sorted by start, so a 23:00→07:00
# routine's from_previous tail ({'00:00','07:00'}) sorts first and the client
# took it — showing the routine due at 07:00 THIS morning, overdue all day,
# while the judge charged against 07:00 the NEXT. Display and the money path
# disagreeing is the one thing this codebase calls a cardinal sin, so the
# client is a reader now and this is the single implementation.
#
# Returns minutes from midnight of `ymd`, which may exceed 1440 — that is the
# whole point, and what the tail-clipping lost.
def flow_day_window(flow, ymd, resolve=None):
    """(open_min, due_min) for a routine on a date; either may be None."""
    open_min = None
    own = _flow_own_end(flow, ymd, resolve)
    if own and flow.get('source_uid'):
        if resolve is None:
            resolve, _ = storage.schedule_resolver()
        src = resolve(flow['source_uid'])
        day = date_cls.fromisoformat(ymd)
        try:
            occs = schedule.occurrences(src, resolve, day, day)
        except schedule.Cycle:
            occs = []
        # The occurrence STARTING on this day, never the tail of yesterday's.
        occ = next(((s, e) for s, e in occs if s.date() == day), None)
        if occ:
            open_min = occ[0].hour * 60 + occ[0].minute
    due = routine_deadline(None, flow, ymd, resolve)
    if due is None:
        return open_min, None
    base = date_cls.fromisoformat(ymd)
    due_min = ((due.date() - base).days * 1440) + due.hour * 60 + due.minute
    return open_min, due_min


def _completed_local(iso):
    """flow_run.completed_at (UTC, tz-aware) as a naive LOCAL datetime."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return datetime.fromtimestamp(dt.timestamp()) if dt.tzinfo else dt


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


def judge(now=None, verbose=False):
    now = now or datetime.now()
    today = now.date().isoformat()
    lines = []

    applied = storage.qr_apply_due_pending_changes(now.isoformat())
    for a in applied:
        lines.append('applied pending %s on node %s' % (a['field'], a['node_id']))

    for node in storage.qr_get_nodes(active_only=True):
        # Yesterday as well as today: a window with offset_days=1 closes on the
        # day AFTER its date, so it can only be judged on the following tick-day.
        # This also backfills one missed day if the timer was down at close time.
        #
        # BEYOND those two the judge still walks back to the last day it judged
        # (bounded at BACKFILL_MAX_DAYS), so a timer down for three days does
        # not leave three days permanently underivable once the freeze means a
        # day is read from its row. Those older days are judged WITHOUT MONEY:
        # charging for a day you could not have known was being judged is the
        # thing every rail in this file exists to prevent. They land as
        # 'stale', which the cap ignores exactly like 'would_fire'.
        for ymd in _days_to_judge(node, today):
            if not applies_on(node, ymd):
                # A PAST day the gate did not run on is frozen too, as 'n/a'.
                # Freezing only the days that were judged left the retroactive
                # hole wide open: a skipped day has no row, so adding a run-day
                # later (a tightening, immediate) made the next tick judge a
                # day that was never a commitment and charge for it. Today is
                # NOT frozen this way — the day is still running, and tightening
                # onto it mid-day is exactly what tightening is allowed to do.
                if ymd < today:
                    storage.qr_reserve_judgment(node['id'], ymd, None, 'n/a', None)
                continue
            if storage.qr_judgment_exists(node['id'], ymd):
                continue
            money_reach = ymd >= _date_plus(today, -1)
            start, end, offset = resolve_window(node, ymd)
            close_date = _date_plus(ymd, 1) if offset == 1 else ymd
            scan_close = _local_dt(close_date, end)

            # The routine's own clock, which can run out well before the scan
            # window closes — and when it does, that alone decides the day.
            flow = storage.gating_flow_for_node(node['id'], ymd)
            r_due = routine_deadline(node, flow, ymd) if flow else None
            r_late = (flow is not None and r_due is not None and now >= r_due
                      and not (_completed_local(flow['completed_at'])
                               and _completed_local(flow['completed_at']) <= r_due))

            if now < scan_close and not r_late:
                continue  # both clocks still running
            if storage.qr_judgment_exists(node['id'], ymd):
                continue

            reason = None
            if now >= scan_close:
                scans = storage.qr_scans_in_window(
                    node['id'], _utc_iso(ymd, start), _utc_iso(close_date, end))
                satisfied = any(
                    node.get('geofence_lat') is None or s.get('geofence_pass') == 1
                    for s in scans)
                # Order matters when both clocks have run out: no scan at all is
                # the more basic failure, so it wins the reason — "routine not
                # done" on a day you were never there would send you to fix the
                # wrong thing.
                if not satisfied:
                    reason = 'absent'
                elif r_late:
                    reason = 'routine_incomplete'
            elif r_late:
                # The scan still has time; the routine does not. Judging now is
                # the point of the change — the day is already lost, and saying
                # so at 21:00 rather than at 23:00 is the honest answer.
                reason = 'routine_incomplete'
            tag = '' if ymd == today else ' (%s)' % ymd
            if reason is None:
                # A ROW ON SUCCESS TOO (2026-08-17) — the FREEZE, reversing
                # "NO ROW ON SUCCESS". A satisfied day used to stay DERIVED
                # from its scans, which meant a closed day was re-resolved
                # under whatever the configuration said later: add a weekend
                # day to a weekday gate on Sunday (a tightening, so immediate)
                # and the next tick judged Saturday — a day that was never a
                # commitment when it closed — and charged for it. Stamping the
                # resolved window makes the judgment answerable on its own
                # terms. What this costs is what the old comment defended: a
                # scan that lands AFTER its window was judged no longer flips
                # the day back to success. Presence is a deadline; late proof
                # is not proof.
                storage.qr_reserve_judgment(node['id'], ymd, None, 'ok', None,
                                            window=(start, end, offset))
                continue

            if not money_reach:
                # Judged, frozen, never charged — see _days_to_judge.
                if storage.qr_reserve_judgment(node['id'], ymd, reason, 'stale', None,
                                               window=(start, end, offset)):
                    lines.append('X   %s (%s): %s -> stale (backfill)'
                                 % (node['label'], ymd, reason))
                continue

            status = charge_for_failure(node, ymd, reason, window=(start, end, offset))
            if status is None:
                continue          # another tick reserved it first
            lines.append('X   %s%s: %s -> %s' % (node['label'], tag, reason, status))

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
            if not applies_on(node, ymd):
                ymd = _date_plus(ymd, 1)
                continue
            start, end, offset = resolve_window(
                node, ymd, overrides.get((node['id'], ymd)))
            close_date = _date_plus(ymd, 1) if offset == 1 else ymd
            open_iso = _utc_iso(ymd, start)
            close_iso = _utc_iso(close_date, end)
            j = judged.get((node['id'], ymd))
            if j and j['charge_status'] == 'n/a':
                # Frozen as "the gate did not run that day" — neutral, exactly
                # as an applies_on miss is, even if it would apply now.
                ymd = _date_plus(ymd, 1)
                continue
            if j:
                out.append({'node_id': node['id'], 'date': ymd,
                            'outcome': 'failed' if j['failure_reason'] else 'success'})
            elif now >= _local_dt(close_date, end):
                ok = any(
                    open_iso <= s['scanned_at'] <= close_iso
                    and (node.get('geofence_lat') is None or s.get('geofence_pass') == 1)
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
    if field == 'active':
        # Switching a gate OFF is the purest loosening there is. The dedicated
        # /disable route always queued it 24h; this predicate had no branch for
        # it, so the generic PATCH {'active': false} went through at once —
        # 20:55, five minutes before a 21:00 deadline, and tonight is not
        # judged. Turning one back ON is tightening and applies immediately.
        return _falsy(nxt) and not _falsy(current)
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
    # from the pending store as both types.
    return v in (None, '', 0, False, '0', 'false', 'False')


def override_locked(node, ymd, now=None):
    # A day's deadline locks once its effective close is within 24h: the
    # override can no longer be created, moved OR removed. Removal is included
    # on purpose — deleting an override that made a day harder would otherwise
    # be a loophole straight back to the slacker default.
    now = now or datetime.now()
    start, end, offset = resolve_window(node, ymd)
    close_date = _date_plus(ymd, 1) if offset == 1 else ymd
    return _local_dt(close_date, end) <= now + timedelta(hours=LOOSEN_DELAY_H)


# The only fields a change to cannot make the gate easier to satisfy. Anything
# not named here has to be PROVEN tighter by is_loosening to apply at once.
QR_IMMEDIATE_FIELDS = ('label',)


def apply_node_patch(node, fields, now=None):
    # Splits a patch into what applies now and what has to wait. Returns
    # (immediate, pending) as {field: value}; the caller writes them.
    now = now or datetime.now()
    immediate, pending = {}, {}
    for field, value in fields.items():
        if field not in storage.QR_NODE_FIELDS:
            continue
        if field in QR_IMMEDIATE_FIELDS or not is_loosening(field, node.get(field),
                                                            value, node):
            immediate[field] = value
        else:
            pending[field] = value
    return immediate, pending

# ── Charging ─────────────────────────────────────────────────
#
# Ported from the Worker 2026-08-11 (see storage.qr_settle_charge for the
# rails and why each exists). Four independent locks, all default-off, so a
# half-finished setup cannot move money:
#
#   1. gate_charging_live setting is '0'
#   2. gate_charge_dryrun setting is '1'
#   3. beeminder_auth_token absent from config.json
#   4. beeminder_user absent from config.json
#
# The token lives in CONFIG.JSON, never in the database: it is the local
# equivalent of a Worker secret — a file on the box, gitignored, invisible to
# the API and to any surface the app renders. The Gates panel can therefore
# verify it but not read or set it, which was the deliberate choice.
BEEMINDER_CHARGES_URL = 'https://www.beeminder.com/api/v1/charges.json'
BEEMINDER_ME_URL = 'https://www.beeminder.com/api/v1/users/me.json'


def _cfg():
    try:
        with open('config.json') as f:
            return json.load(f)
    except Exception:
        return {}


def charge_settings():
    # There is no get_setting(); settings arrive as one dict. Defaults here are
    # the SAFE end of every axis: not live, dry, capped, cheapest.
    cfg = _cfg()
    st = storage.get_settings() or {}
    return {
        'live': st.get('gate_charging_live') == '1',
        'dryrun': st.get('gate_charge_dryrun', '1') != '0',
        'cap_cents': int(st.get('gate_weekly_cap_cents') or 2500),
        'default_cents': int(st.get('gate_charge_cents') or 200),
        # A fixed per-charge card fee the card provider takes on its own
        # (Privacy.com charges one per transaction). The STAKE stays the total
        # a failure costs; Beeminder is billed stake minus this, so the fee
        # never silently raises the price of failing above what was set.
        'fee_cents': int(st.get('gate_card_fee_cents') or 0),
        'token': cfg.get('beeminder_auth_token') or '',
        'user': cfg.get('beeminder_user') or '',
    }


def node_charge_cents(node, settings):
    # NULL on the node means "use the default", never "free" — a gate with no
    # explicit stake still costs the default, or setting one to 0 by accident
    # would silently disarm it.
    v = node.get('charge_cents')
    return int(v) if v not in (None, '') else int(settings['default_cents'])


def beeminder_charge(settings, amount_cents, note, sender=None):
    """Returns (status, charge_id). Statuses mirror the Worker exactly."""
    if not settings['token'] or not settings['user']:
        return 'failed', None            # nothing was sent
    dollars = '%.2f' % max(1.0, amount_cents / 100.0)   # their minimum is $1
    body = {'auth_token': settings['token'], 'user_id': settings['user'],
            'amount': dollars, 'note': note}
    if settings['dryrun']:
        body['dryrun'] = '1'
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
    return ('dryrun' if settings['dryrun'] else 'succeeded'), _charge_id(data)


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


def charge_for_failure(node, ymd, reason, sender=None, window=None):
    """The whole money path for one judged failure. Returns the status stored.

    Reserve BEFORE charging, and only the tick that won the reservation may
    call Beeminder. Every early return still leaves a row, so the day is
    judged exactly once whatever happens to the money.
    """
    storage.qr_ensure_charge_columns()
    s = charge_settings()
    amount = node_charge_cents(node, s)
    spent = storage.qr_weekly_spent_cents(ymd)
    capped = s['live'] and (spent + amount) > s['cap_cents']
    will_charge = s['live'] and not capped

    status = 'capped' if capped else ('charging' if will_charge else 'would_fire')
    won = storage.qr_reserve_judgment(
        node['id'], ymd, reason, status, amount if will_charge else None,
        window=window)
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
