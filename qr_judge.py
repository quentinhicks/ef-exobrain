# The QR judge. Was a Cloudflare Worker cron (2026-08-08); now a systemd timer
# on the same box as the database, so it reads scans directly instead of over
# an authenticated HTTP hop.
#
# JUDGMENT IS PRESENCE-ONLY: a window is judged the moment it closes, and the
# test is a satisfying scan (geofence-passing where a geofence is set). The
# retired to-do gate and the routine gate are both gone — a QR URL is location
# proof again, and the routine surfaces live in-app as flows.
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
from datetime import datetime, timedelta

import storage

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


def resolve_window(node, ymd, override=None):
    # date override > weekly window > node defaults. This ordering is mirrored
    # in the timeline, the engage day and the QR manager; changing it here
    # without changing them makes the app disagree with the judge.
    if override is None:
        override = storage.qr_get_override(node['id'], ymd)
    if override:
        return (override['window_start'], override['window_end'],
                override.get('window_end_offset_days') or 0)
    weekly = weekly_window_for(node, ymd)
    if weekly:
        return (weekly['window_start'], weekly['window_end'],
                weekly.get('window_end_offset_days') or 0)
    return (node['window_start'], node['window_end'],
            node.get('window_end_offset_days') or 0)


def applies_on(node, ymd):
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

            reason = None if satisfied else 'absent'
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

            storage.qr_reserve_judgment(node['id'], ymd, reason, 'would_fire')
            lines.append('X   %s%s: %s -> would_fire' % (node['label'], tag, reason))

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


if __name__ == '__main__':
    found = judge(verbose=True)
    print('qr-judge: %d failure(s) recorded %s' % (len(found), datetime.now().isoformat()))
    sys.exit(0)
