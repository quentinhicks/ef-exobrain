import csv
import io
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import recurrence




def _parse_dt(val, tzid=None):
    val = val.strip()
    if val.endswith('Z'):
        dt = datetime.strptime(val, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        return dt.astimezone().replace(tzinfo=None)
    if 'T' in val:
        dt = datetime.strptime(val[:15], '%Y%m%dT%H%M%S')
        if tzid:
            try:
                dt = dt.replace(tzinfo=ZoneInfo(tzid)).astimezone().replace(tzinfo=None)
            except ZoneInfoNotFoundError:
                pass
        return dt
    return datetime.strptime(val[:8], '%Y%m%d')


def _fmt(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S')


def expand_rrule(rrule_str, dtstart, duration):
    """Occurrences of an iCalendar RRULE, as (start, end) local strings.

    Delegates the rule grammar to recurrence.py — the same module the app's
    own recurring things use, so a Google Calendar rule and a locally-defined
    one can never disagree about what "first Sunday of the month" means. The
    hand-rolled version this replaced ignored BYDAY under MONTHLY (so
    "1SU" expanded as "the same date each month") and handled no YEARLY rule
    at all, which silently dropped every annual event.
    """
    rule = recurrence.parse(rrule_str)
    if not rule:
        return []
    # Unbounded rules are capped at a year out, as before — this feeds a
    # calendar view, not an archive.
    end = rule.get('UNTIL') or (dtstart.date() + timedelta(days=365))
    days = recurrence.between(rule, dtstart.date(), dtstart.date(), end)
    out = []
    for d in days:
        start = datetime.combine(d, dtstart.time())
        out.append((_fmt(start), _fmt(start + duration)))
    return out

def _download(url):
    with urllib.request.urlopen(url) as response:
        return response.read().decode('utf-8')


def _parse_events(unfolded):
    events = []
    in_event = False
    current = {}
    for line in unfolded.splitlines():
        if line == 'BEGIN:VEVENT':
            in_event = True
            current = {}
        elif line == 'END:VEVENT':
            in_event = False
            dtstart = current.get('dtstart')
            dtend = current.get('dtend')
            if dtstart:
                events.append({
                    'uid': current.get('uid', ''),
                    'summary': current.get('summary', ''),
                    'dtstart': dtstart,
                    'dtend': dtend or dtstart,
                    'rrule': current.get('rrule'),
                    'allday': current.get('allday', False),
                    'recurrence_id': current.get('recurrence_id'),
                })
        elif in_event:
            if line.startswith('DTSTART'):
                tzid = re.search(r'TZID=([^;:]+)', line)
                val = line.split(':', 1)[-1]
                current['allday'] = 'T' not in val
                current['dtstart'] = _parse_dt(val, tzid.group(1) if tzid else None)
            elif line.startswith('DTEND'):
                tzid = re.search(r'TZID=([^;:]+)', line)
                val = line.split(':', 1)[-1]
                current['dtend'] = _parse_dt(val, tzid.group(1) if tzid else None)
            elif line.startswith('RECURRENCE-ID'):
                tzid = re.search(r'TZID=([^;:]+)', line)
                val = line.split(':', 1)[-1]
                current['recurrence_id'] = _parse_dt(val, tzid.group(1) if tzid else None)
            elif line.startswith('SUMMARY:'):
                current['summary'] = line[8:]
            elif line.startswith('UID:'):
                current['uid'] = line[4:]
            elif line.startswith('RRULE:'):
                current['rrule'] = line[6:]
    return events


def fetch_gcal(url):
    unfolded = re.sub(r'\r?\n[ \t]', '', _download(url))
    return _parse_events(unfolded)


def fetch_gcal_named(url):
    text = _download(url)
    if 'BEGIN:VCALENDAR' not in text:
        raise ValueError('not an iCalendar feed')
    unfolded = re.sub(r'\r?\n[ \t]', '', text)
    name = None
    m = re.search(r'^X-WR-CALNAME:(.*)$', unfolded, re.MULTILINE)
    if m:
        name = m.group(1).strip()
    return name, _parse_events(unfolded)


# ── Calendar WRITES (2026-08-11) ──────────────────────────────
#
# Reads stay on the iCal feed; creates go through the Calendar API with a
# service account (the calendar must be shared with the service account's
# email, "Make changes to events"). Google stays the source of truth — the
# app also inserts the created event locally (see insert_gcal_event) only
# because the iCal feed is cached server-side for hours, and a write that
# doesn't show up reads as a write that failed. The next feed refresh
# re-asserts the same row (same uid), so the optimistic copy is never load-
# bearing for more than one refresh cycle.
#
# google-auth is imported lazily: the feature is config-gated and the app
# must keep running (and the exe keep building) where it isn't installed.

GCAL_API = 'https://www.googleapis.com/calendar/v3/calendars'


def _gcal_session(creds_path):
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    creds = service_account.Credentials.from_service_account_file(
        creds_path, scopes=['https://www.googleapis.com/auth/calendar.events'])
    return AuthorizedSession(creds)


def create_gcal_event(creds_path, calendar_id, summary, start, end):
    # start/end are naive LOCAL datetimes (the app's one convention);
    # astimezone() stamps the process TZ's offset for that date, so DST
    # can't shift a winter event written in summer.
    body = {'summary': summary,
            'start': {'dateTime': start.astimezone().isoformat()},
            'end': {'dateTime': end.astimezone().isoformat()}}
    sess = _gcal_session(creds_path)
    resp = sess.post(
        f'{GCAL_API}/{urllib.parse.quote(calendar_id)}/events',
        json=body, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    # The iCal feed's UID is the API's iCalUID — that match is what lets the
    # next refresh replace the optimistic row instead of duplicating it.
    return {'event_id': data['id'],
            'uid': data.get('iCalUID') or data['id'] + '@google.com'}


def delete_gcal_event(creds_path, calendar_id, event_id):
    # Only ever called to undo a create this app made. 404/410 count as done:
    # the event is gone, which is what undo promised.
    sess = _gcal_session(creds_path)
    resp = sess.delete(
        f'{GCAL_API}/{urllib.parse.quote(calendar_id)}/events/{urllib.parse.quote(event_id)}',
        timeout=15)
    if resp.status_code not in (200, 204, 404, 410):
        resp.raise_for_status()


def _parse_bool(val):
    return str(val).strip().upper() in ('TRUE', '1', 'YES', 'Y')


def fetch_sheets(url):
    with urllib.request.urlopen(url) as response:
        text = response.read().decode('utf-8')
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        title = row.get('title', '').strip()
        rows.append({
            'title': title,
            'name': title,
            'due_date': row.get('due_date', '').strip(),
            'due_time': row.get('due_time', '').strip() or None,
            'course': row.get('course', '').strip(),
            'done': _parse_bool(row.get('done', 'false')),
            'due_yes': _parse_bool(row.get('due_yes', 'false')),
        })
    return rows
