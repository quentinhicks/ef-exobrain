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
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override:
        # A day override is a deliberate decision about THIS day, so it stands as
        # written — the pawn does not shorten it further. Anything else and
        # dragging tonight's deadline would silently move again.
        return (override['window_start'], override['window_end'],
                override.get('window_end_offset_days') or 0)
    return _less_pawned(node, ymd, base_window(node, ymd))


def base_window(node, ymd):
    """The gate's window BEFORE any pawn: source > weekly > node defaults.

    Named apart from resolve_window because two questions are asked of it —
    what the window IS (resolve_window, pawn applied) and what the pawn
    actually TOOK OFF it (pawn_giveback, which needs the before to subtract
    from the after). Re-deriving the ladder in the second place is the shape
    this codebase keeps banning.
    """
    from_source = source_window_for(node, ymd)
    if from_source:
        return from_source
    weekly = weekly_window_for(node, ymd)
    if weekly:
        return (weekly['window_start'], weekly['window_end'],
                weekly.get('window_end_offset_days') or 0)
    return (node['window_start'], node['window_end'],
            node.get('window_end_offset_days') or 0)


# ── WHAT A PAWN DOES TO A WINDOW (2026-08-25, Quentin's instruction) ─────────
#
# A step pushed onto a later routine takes its minutes with it, so that routine
# has more to do — and the three windows involved answer that differently. They
# are three rules, not one, which is exactly why each is named:
#
#   the SCAN moves Y earlier       (moved_earlier) — the price. A scan is the
#                                  claim that you are done, and carrying debt
#                                  into a night means being done sooner. The
#                                  whole window slides: its WIDTH is what the
#                                  commitment actually promised you, and a
#                                  price that ate it made a gate you could not
#                                  satisfy rather than one that demanded more
#                                  (2026-09-02, Quentin's instruction — it used
#                                  to pull the close in and leave the opening,
#                                  so a 60-minute window pawned 50 left ten
#                                  minutes to hit).
#   the ROUTINE opens Y earlier    (opened_earlier) — the room. More to do in
#                                  the same evening means starting sooner.
#   the ROUTINE'S DEADLINE stays   — by construction, not by exception: a
#                                  derived deadline is "X after the scan
#                                  closes", so on a pawned day it is X + Y
#                                  after a close that already moved Y in. The
#                                  arithmetic lands it exactly where it was.
#
# Each rule is written once and every window asks for it, so a future window
# kind gets this behaviour by asking rather than by remembering. What a caller
# supplies is only WHOSE minutes to use (pawn_shift / node_pawn_shift), which
# is the one thing that differs between them.
def pawn_shift(flow_id, ymd):
    """How many minutes earlier this routine has to open today. Never negative."""
    return max(0, storage.pawned_minutes_for_flow(flow_id, ymd))


def node_pawn_shift(node, ymd):
    """The same number for the gate that a routine gates."""
    return max(0, storage.pawned_minutes_for_node(node['id'], ymd))


def opened_earlier(start_min, end_min, minutes):
    """(start, end) with the OPENING pulled back by `minutes`. The close stays.

    Clamped at midnight of the day being asked about: a window is expressed in
    minutes from that midnight, and a start before it would be a statement about
    a day this window does not describe.
    """
    if not minutes:
        return start_min, end_min
    return max(0, start_min - minutes), end_min


def moved_earlier(start_min, end_min, minutes):
    """(start, end) with the WHOLE window slid earlier by `minutes`. Width kept.

    Pawning costs you TIME OF DAY, never room: the close comes in because a
    scan is the claim that you are done, and the opening comes with it because
    the width is what the commitment promised. Pulling only the close in made
    the price compound — a 60-minute window pawned 50 left ten minutes to hit,
    and pawned 60 left none, which is a gate you cannot satisfy rather than one
    that demands more.

    Clamped at midnight of the day being asked about, the same bound and the
    same reason as opened_earlier: a window is expressed in minutes from that
    midnight, so a start before it would describe a different day. The width
    survives the clamp — that is the whole point of it.
    """
    if not minutes:
        return start_min, end_min
    width = end_min - start_min
    start = max(0, start_min - minutes)
    return start, start + width


def _less_pawned(node, ymd, window):
    """The gate's SCAN window, slid earlier by the pawned minutes.

    This is the half that costs something, and it is meant to: the scan says
    you are done, so carrying work into the evening means being done sooner.
    The routine's own deadline does NOT move with it — see routine_deadline,
    which adds the same minutes back.

    Applied AFTER the source/weekly/default resolution but NOT after a date
    override: an override is a deliberate day-level decision about this gate and
    stands exactly as written, so resolve_window returns before reaching here.
    pawn_giveback answers the same question the other way round — what this took
    off — and returns 0 on an override for that reason.
    """
    minutes = node_pawn_shift(node, ymd)
    if minutes <= 0:
        return window
    start, end, offset = window
    start_min = _hhmm_min(start)
    end_min = _hhmm_min(end) + int(offset or 0) * 24 * 60
    start_min, end_min = moved_earlier(start_min, end_min, minutes)
    new_offset, rest = divmod(end_min, 24 * 60)
    return (f'{start_min // 60:02d}:{start_min % 60:02d}',
            f'{rest // 60:02d}:{rest % 60:02d}', new_offset)


def _hhmm_min(hhmm):
    h, m = str(hhmm).split(':')
    return int(h) * 60 + int(m)


# WHAT THE CLOSE ACTUALLY LOST, which is not always what was pawned (fixed
# 2026-08-30). routine_deadline gives the pawned minutes back so the routine's
# deadline lands exactly where it stood unpawned — "X after a close that moved
# Y in, plus Y". That arithmetic only holds when the close really moved Y, and
# there are two live cases where it does not:
#
#   a DATE OVERRIDE stands as written and loses nothing (resolve_window returns
#   before _less_pawned), so the raw add-back pushed the routine's deadline Y
#   minutes PAST where it stood — pawning bought free time on the day you had
#   already dragged the window;
#   a cost larger than the DAY is only partly paid, because moved_earlier
#   clamps the slide at midnight — a 5000-minute step cannot move a 23:00 close
#   back more than the 1380 minutes there are before it, and giving back 5000
#   put the deadline four days later.
#
# Both are loosenings on the money path (the routine earns half the day's
# credit), and both are ONE cause: a second place re-deriving what the close
# did instead of asking. So it is asked here, once, and routine_deadline is
# now a reader.
def pawn_giveback(node, ymd, override=None):
    """Minutes the pawn took OFF this gate's close on this date. Never negative."""
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override:
        return 0
    minutes = node_pawn_shift(node, ymd)
    if minutes <= 0:
        return 0
    start, end, offset = base_window(node, ymd)
    start_min = _hhmm_min(start)
    end_min = _hhmm_min(end) + int(offset or 0) * 24 * 60
    _, closed = moved_earlier(start_min, end_min, minutes)
    return end_min - closed


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
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override and override.get('skipped'):
        return False
    # A ROUTINE GATE WITH NO ROUTINE DOES NOT RUN. Asked BEFORE the schedule
    # branches below, both of which RETURN — written after them once, where it
    # was reachable only by a gate with no source, so a gate that had lost its
    # routine went on being judged and charged. The schedule says which DAYS a
    # gate runs; this says whether there is anything for it to ask at all, and
    # a question with no subject is not a commitment. Lands 'n/a' by the same
    # road a non-run weekday does: judged, frozen, never charged.
    # Date-free on purpose (storage.gate_has_routine): whether a routine is
    # ATTACHED is a fact about the gate, not about this date, and the run is a
    # different question asked later by day_verdict.
    if is_routine_gate(node) and not storage.gate_has_routine(node['id']):
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


# A ROUTINE IS RESOLVED AS IT STOOD ON THAT DAY (2026-08-24, Quentin: "it
# changed the routine window settings in the past"). Its window fields are
# dated — storage.record_revision keeps what they held before each change — so
# every question about a DATE goes through here first and the day you already
# lived keeps the deadline it actually had.
#
# One hop, at the two doors that read those fields (_flow_own_end and
# routine_deadline), which is every path into flow_day_window as well.
def _flow_on(flow, ymd):
    return storage.flow_as_of(flow, ymd=ymd) or flow


def _flow_own_end(flow, ymd, resolve=None):
    flow = _flow_on(flow, ymd)
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
    flow = _flow_on(flow, ymd)
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
    due = _local_dt(close_date_of(ymd, offset), end)
    # A "before X" routine is due when X closes, full stop; the offset belongs
    # to the gate it gates, not to a deadline it merely points at.
    if not flow.get('before_node_id'):
        # "X after the scan closes" — and on a pawned day that close has
        # already moved in (_less_pawned), so this adds back exactly what it
        # lost. The routine's deadline therefore lands where it stood unpawned:
        # the pawn buys the evening more room and charges the SCAN for it,
        # which is the whole shape of the mechanic (Quentin, 2026-08-25).
        # ASK what the close lost (pawn_giveback) rather than assuming it was
        # the pawned minutes — an override loses nothing and an absurd cost is
        # clamped, and both used to push this deadline past where it began.
        due += timedelta(minutes=(flow.get('offset_min') or 0)
                                 + pawn_giveback(anchor, ymd))
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
    flow = _flow_on(flow, ymd)
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
    # Work pawned IN opens the routine earlier and leaves its deadline alone —
    # the same call the gate makes, so the two cannot drift apart.
    if open_min is not None:
        open_min, due_min = opened_earlier(open_min, due_min,
                                           pawn_shift(flow.get('id'), ymd))
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
# The code had already argued this once. An hours gate refuses to be linked to
# the routine that hosts its entry step (see day_verdict), because entering the
# hours IS finishing that routine, so one act would have paid for two halves.
# That is this rule, one gate earlier.
#
# So a gate is cleared by exactly ONE kind of proof, named in proof_mode:
#
#   'link' / 'tag'  a scan inside the window          (scan_satisfies)
#   'hours'         a number that meets the day's bar (hours_satisfies)
#   'routine'       its linked routine, finished      (below)
#
# A routine gate has NO DEADLINE (Quentin, 2026-09-02): its commitment is the
# WALL DAY — done at all, on the day it was owed. `routine_deadline` still
# answers when the routine is DUE, and the runner still shows it, but nothing
# on the money path asks. What it costs to have no deadline is paid in the
# timing instead: the day cannot settle at any clock time inside it, so a
# routine gate settles at the wall day's end plus ROUTINE_GRACE_HOURS, which is
# the same instant a run stops being able to earn its day (run_settles_at).
#
# THERE IS NO PARTIAL CREDIT ANY MORE. credit_pct is still written — 100 on a
# pass, 0 on a fail — and judged_outcome still reads the 50s frozen into rows
# judged under the split, because a judged day is frozen and history says what
# it said. Nothing can write a 50 again.


def day_verdict(node, ymd, flow, scans, now=None, hours=None):
    """Did this gate's day pass? (ok, reason). THE one answer.

    `reason` is NULL on a pass — a row with no failure_reason is a judged
    success, which is what the freeze made a row mean (qr_reserve_judgment).
    """
    if is_hours_gate(node):
        # A number, not a scan. The routine that HOSTS the entry step is
        # deliberately not this gate's proof: entering the hours IS finishing
        # that routine, so making it clear the gate would credit one act twice.
        passed = (hours or hours_satisfies(node, ymd))[0]
        return (True, None) if passed else (False, 'hours_short')

    if is_routine_gate(node):
        # THE WALL DAY, with no deadline inside it. Late is not a failure here
        # and has no reason to be recorded as one, so there is no 'routine_late'
        # — the run either belongs to this day or it does not, and a run belongs
        # to the day it was OPENED on (flowRunView.date), not the clock at the
        # moment it was ticked.
        if flow is None:
            # No routine attached: there is nothing this gate could ask, so it
            # cannot be failed. applies_on already stops it running at all, and
            # the PATCH route refuses to leave a gate in this state — both
            # because a gate nothing can clear is not a commitment, it is a
            # daily charge. This is the third lock, on the safe end.
            return True, None
        return (True, None) if flow['completed_at'] else (False, 'routine_incomplete')

    return ((True, None) if any(scan_satisfies(node, sc) for sc in scans)
            else (False, 'absent'))


# HOW FAR PAST MIDNIGHT A ROUTINE CAN STILL EARN ITS DAY (2026-08-25,
# Quentin's instruction; it earned a HALF until 2026-09-02, and now earns the
# whole gate). Midnight alone contradicted a rule the app already
# had: a run belongs to the day it was OPENED on, and openFlowRun deliberately
# resumes yesterday's unfinished run — so a night routine finished at 00:05
# credits a day the judge, which settles at 00:00 and runs every five minutes,
# had already frozen. The day was earned and unearnable at the same time.
#
# Four hours, not twenty-four. A full day would keep Monday chargeable while
# Tuesday's routine was already running, so two money days would be open at
# once; this covers the finish-after-midnight case that actually happens and
# closes the day before the next one starts.
ROUTINE_GRACE_HOURS = 4


def settle_after(node, ymd, flow, window):
    """The moment this day can be judged without the answer still moving.

    A gate proved by a SCAN or by a NUMBER settles when its window closes:
    nothing about the day can change after that, which is what a window is.

    A ROUTINE gate has no deadline inside its day, so there is no clock time
    within the day at which its answer stops moving — it settles at the wall
    day's end plus the grace, the same instant a run stops being able to earn
    its day (run_settles_at). Judging earlier would charge for a routine that
    was about to be done, and a judged day is FROZEN, so there is no second
    look. This is the price of having no deadline, and it is paid here.

    `flow` is accepted and ignored for the scan kinds ON PURPOSE: a routine
    linked to a scan gate no longer delays or softens that gate's judgment
    (2026-09-02). The two are separate commitments now.
    """
    if is_routine_gate(node):
        return run_settles_at(ymd)
    start, end, offset = window
    return _local_dt(close_date_of(ymd, offset), end)


def run_settles_at(ymd):
    """The moment a RUN opened on `ymd` stops being able to earn that day.

    The runner pins its day (`flowRunView.date`) so a night routine ticked at
    00:05 credits the night it started — but the pin has to end somewhere, or
    every later write in the session files under a day that closed hours ago.
    That end is the same grace the money path already uses: past it the day is
    settled, judged and frozen, so nothing more can be earned on it.

    Served to the client rather than mirrored there (`get_flows`), because a
    client re-derivation of a rule the judge charges against is a bug even
    while it agrees. No node and no window: this is the ROUTINE half's outer
    bound, and settle_after IS this for a routine gate, so a routine's day
    ends at the same instant whether you ask the runner or the judge.
    """
    return (_local_dt(_date_plus(ymd, 1), '00:00')
            + timedelta(hours=ROUTINE_GRACE_HOURS))


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
            close_date = close_date_of(ymd, offset)

            # ONLY a routine gate asks about a routine (2026-09-02). A routine
            # linked to a SCAN gate is a separate commitment with its own gate
            # and its own stake, so it neither softens this day nor delays it.
            flow = (storage.gating_flow_for_node(node['id'], ymd)
                    if is_routine_gate(node) else None)
            if now < settle_after(node, ymd, flow, (start, end, offset)):
                continue
            if storage.qr_judgment_exists(node['id'], ymd):
                continue

            scans = storage.qr_scans_in_window(
                node['id'], _utc_iso(ymd, start), _utc_iso(close_date, end))
            # Resolved ONCE and stamped on whichever row this day lands in. The
            # bucket is a running total, so re-deriving it later would let a
            # correction to last Tuesday rewrite what Wednesday was judged
            # against — the credit_pct rule, for the same reason.
            hrs = hours_satisfies(node, ymd) if is_hours_gate(node) else None
            stamp = (hrs[2], hrs[1], hrs[3]) if hrs else None
            _ok, reason = day_verdict(node, ymd, flow, scans, now, hours=hrs)
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
                                            window=(start, end, offset),
                                            credit_pct=100, hours=stamp)
                continue

            if not money_reach:
                # Judged, frozen, never charged — see _days_to_judge.
                if storage.qr_reserve_judgment(node['id'], ymd, reason, 'stale', None,
                                               window=(start, end, offset),
                                               credit_pct=0, hours=stamp):
                    lines.append('X   %s (%s): %s -> stale (backfill)'
                                 % (node['label'], ymd, reason))
                continue

            status = charge_for_failure(node, ymd, reason, window=(start, end, offset),
                                        hours=stamp)
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
            if not applies_on(node, ymd, overrides.get((node['id'], ymd))):
                ymd = _date_plus(ymd, 1)
                continue
            start, end, offset = resolve_window(
                node, ymd, overrides.get((node['id'], ymd)))
            close_date = close_date_of(ymd, offset)
            open_iso = _utc_iso(ymd, start)
            close_iso = _utc_iso(close_date, end)
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
            elif now >= _local_dt(close_date, end):
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


def is_routine_gate(node):
    return (node.get('proof_mode') or 'link') == 'routine'


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
    if field == 'active':
        # Switching a gate OFF is the purest loosening there is. The dedicated
        # /disable route always queued it 24h; this predicate had no branch for
        # it, so the generic PATCH {'active': false} went through at once —
        # 20:55, five minutes before a 21:00 deadline, and tonight is not
        # judged. Turning one back ON is tightening and applies immediately.
        return _falsy(nxt) and not _falsy(current)
    if field == 'proof_mode':
        # ONE provable tightening, and everything else waits (2026-09-02, when
        # 'routine' joined 'link', 'tag' and 'hours'). link -> tag is the only
        # move that unambiguously demands MORE: the gate stops accepting a URL
        # you can open from bed and starts needing the object in your hand. It
        # applies at once, but only where a live tag exists to clear it with,
        # which app.py refuses at the door rather than pending.
        #
        # Every other move swaps one kind of proof for a DIFFERENT kind, and
        # there is no scale on which a scan and a routine and a number can be
        # compared — so none of them is proven tighter, and the allowlist rule
        # says they wait. This branch used to read `current == 'tag'`, which
        # was blacklist-shaped: link -> hours and link -> routine both fell
        # through as tightenings and applied instantly on the money path.
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


def charge_for_failure(node, ymd, reason, sender=None, window=None, hours=None):
    """The whole money path for one judged failure. Returns the status stored.

    Reserve BEFORE charging, and only the tick that won the reservation may
    call Beeminder. Every early return still leaves a row, so the day is
    judged exactly once whatever happens to the money.

    A failure costs the WHOLE stake. There is no fractional amount any more
    (2026-09-02): a gate has one proof and one verdict, so the only two prices
    are the stake and nothing. credit_pct is still stamped — 0 here — because
    the rows judged under the split carry 50 and judged_outcome reads it.
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
