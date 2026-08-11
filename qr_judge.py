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
import sys
import time
import urllib.parse
import urllib.request
from datetime import date as date_cls, datetime, timedelta

import storage
import schedule

# The process runs in the app's timezone (app.py's _apply_timezone sets TZ from
# the setting), so naive local datetimes are correct here — same convention as
# every other date in this codebase.
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
        for ymd in (_date_plus(today, -1), today):
            if not applies_on(node, ymd):
                continue
            start, end, offset = resolve_window(node, ymd)
            close_date = _date_plus(ymd, 1) if offset == 1 else ymd
            if now < _local_dt(close_date, end):
                continue  # window still open
            if storage.qr_judgment_exists(node['id'], ymd):
                continue

            scans = storage.qr_scans_in_window(
                node['id'], _utc_iso(ymd, start), _utc_iso(close_date, end))
            satisfied = any(
                node.get('geofence_lat') is None or s.get('geofence_pass') == 1
                for s in scans)

            # A LINKED routine is the second half of the test. Order matters:
            # no scan at all is the more basic failure, so it wins the reason —
            # "routine not done" on a day you were never there would send you
            # to fix the wrong thing.
            routine_done = storage.routine_gate_for_node(node['id'], ymd)
            reason = None
            if not satisfied:
                reason = 'absent'
            elif routine_done is False:
                reason = 'routine_incomplete'
            tag = '' if ymd == today else ' (%s)' % ymd
            if reason is None:
                # NO ROW ON SUCCESS — qr_charge_log is a FAILURE log, and
                # outcomes() treats the presence of a row as 'failed'. It also
                # means a satisfied day stays DERIVED from its scans, so a scan
                # logged late still flips the day to success. Writing a row
                # here would freeze the wrong answer and paint every good day
                # red. The cost is re-evaluating closed-and-satisfied windows
                # each tick, which is what the Worker did too.
                continue

            status = charge_for_failure(node, ymd, reason)
            if status is None:
                continue          # another tick reserved it first
            lines.append('X   %s%s: %s -> %s' % (node['label'], tag, reason, status))

    if verbose:
        for line in lines:
            print(line)
    return lines


def outcomes(from_date, to_date, now=None):
    # The ✓/✗ the app paints on QR hairlines. DERIVED, not stored: a
    # qr_charge_log row means failed, otherwise the window is recomputed from
    # its scans. Windows that have not closed yet are omitted entirely —
    # neutral, not failed, which is why an un-judged QR renders plain.
    now = now or datetime.now()
    charged = {(c['node_id'], c['date'])
               for c in storage.qr_charges_between(from_date, to_date)}
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
            if now >= _local_dt(close_date, end):
                if (node['id'], ymd) in charged:
                    out.append({'node_id': node['id'], 'date': ymd, 'outcome': 'failed'})
                else:
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
    return False


def override_locked(node, ymd, now=None):
    # A day's deadline locks once its effective close is within 24h: the
    # override can no longer be created, moved OR removed. Removal is included
    # on purpose — deleting an override that made a day harder would otherwise
    # be a loophole straight back to the slacker default.
    now = now or datetime.now()
    start, end, offset = resolve_window(node, ymd)
    close_date = _date_plus(ymd, 1) if offset == 1 else ymd
    return _local_dt(close_date, end) <= now + timedelta(hours=LOOSEN_DELAY_H)


def apply_node_patch(node, fields, now=None):
    # Splits a patch into what applies now and what has to wait. Returns
    # (immediate, pending) as {field: value}; the caller writes them.
    now = now or datetime.now()
    immediate, pending = {}, {}
    for field, value in fields.items():
        if field not in storage.QR_NODE_FIELDS:
            continue
        if is_loosening(field, node.get(field), value, node):
            pending[field] = value
        else:
            immediate[field] = value
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


def charge_for_failure(node, ymd, reason, sender=None):
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
        node['id'], ymd, reason, status, amount if will_charge else None)
    if not won:
        return None          # another tick owns this day; do not touch money

    if not will_charge:
        return status

    final, charge_id = beeminder_charge(
        s, amount, '%s: %s on %s' % (node['label'], reason, ymd), sender)
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
    found = judge(verbose=True)
    # Stamped so the panel can answer "is this actually running?" — the first
    # question about a judge on a timer, and one nothing else could answer: a
    # quiet week and a dead service produce the same empty log.
    storage.set_setting('gate_judge_last_run', datetime.now().isoformat(timespec='seconds'))
    print('qr-judge: %d failure(s) recorded %s' % (len(found), datetime.now().isoformat()))
    sys.exit(0)
