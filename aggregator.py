import csv
import io
import json
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


# A property may carry PARAMETERS before its value — DESCRIPTION;ALTREP="…":
# is the common one, and Google sends LANGUAGE= on some calendars. The value is
# everything after the first colon that is not inside a quoted parameter, so a
# blind split(':', 1) would cut an ALTREP URL in half.
def _prop_value(line):
    quoted = False
    for i, ch in enumerate(line):
        if ch == '"':
            quoted = not quoted
        elif ch == ':' and not quoted:
            return line[i + 1:]
    return ''


# RFC 5545 escaping, and the reason DESCRIPTION cannot be sliced like SUMMARY
# is: a Google description is a paragraph, so its line breaks arrive as the two
# characters backslash-n, and every comma and semicolon in it arrives
# backslashed. The pair is read left to right, so an escaped backslash sitting
# in front of an n is not then mistaken for a line break.
_ICAL_ESCAPES = {'n': '\n', 'N': '\n', '\\': '\\', ',': ',', ';': ';'}


def _ical_text(val):
    out, i = [], 0
    while i < len(val):
        ch = val[i]
        if ch == '\\' and i + 1 < len(val):
            nxt = val[i + 1]
            out.append(_ICAL_ESCAPES.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return ''.join(out).strip() or None


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
                    'location': current.get('location'),
                    'description': current.get('description'),
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
            elif line.startswith('LOCATION'):
                current['location'] = _ical_text(_prop_value(line))
            elif line.startswith('DESCRIPTION'):
                current['description'] = _ical_text(_prop_value(line))
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


# --- Geocoding: an address instead of typed coordinates ------
#
# Nominatim (OpenStreetMap): no API key, no billing, no account — which is why
# it is the one that fits. Plain urllib, like every other fetch in this file.
#
# Its usage policy asks two things and BOTH are load-bearing: a descriptive
# User-Agent (the stdlib default is blocked outright, which is the same lesson
# the QR admin API taught) and roughly one request a second, which is why the
# caller debounces rather than searching per keystroke.
#
# This READS ONLY. It returns candidates and writes nothing — picking one is a
# separate, deliberate act that creates the location row.
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
GEOCODE_LIMIT = 6


def geocode(query, user_agent, limit=GEOCODE_LIMIT):
    query = (query or '').strip()
    if not query:
        return []
    if not (user_agent or '').strip():
        # Refused rather than sent with the default UA: Nominatim would block
        # it, and a 403 read as "no results for that address" would be a lie.
        raise ValueError('geocode_user_agent is not set')
    url = NOMINATIM_URL + '?' + urllib.parse.urlencode({
        'q': query, 'format': 'jsonv2', 'limit': max(1, min(int(limit), 20)),
        'addressdetails': 0,
    })
    req = urllib.request.Request(url, headers={
        'User-Agent': user_agent.strip(),
        'Accept': 'application/json',
        'Accept-Language': 'en',
    })
    with urllib.request.urlopen(req, timeout=15) as response:
        rows = json.loads(response.read().decode('utf-8'))
    out = []
    for r in rows:
        try:
            lat, lng = float(r['lat']), float(r['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        label = (r.get('display_name') or '').strip()
        out.append({
            'label': label,
            # The first comma-separated part is what a human would call it, and
            # it is only a SUGGESTED name — the field stays editable, because
            # "Anamika's" is not what OSM will ever call her building.
            'name': label.split(',')[0].strip(),
            'lat': lat,
            'lng': lng,
            'kind': r.get('type') or r.get('category') or '',
        })
    return out


# --- Outbound notification: ntfy or Pushover ------
#
# Two transports because the choice is genuinely the user's and neither is
# obviously right: ntfy costs nothing and needs no account, but its topic name
# is the ONLY thing protecting it, so treat the text as semi-public. Pushover
# costs $5 once, and its retry-until-acknowledged priority is the one thing
# that fits a deadline you must not miss.
#
# `kind` is explicit rather than sniffed from the URL — guessing a transport
# from a hostname is the sort of cleverness that fails silently the day the
# hostname changes.
#
# Raises on failure. The caller decides whether a failed send is worth
# surfacing; it must never be swallowed here, because silence is also what
# SUCCESS looks like for this feature.
def notify(kind, url, message, title=None, token=None, user=None, priority=None):
    kind = (kind or 'ntfy').strip().lower()
    url = (url or '').strip()
    if not url:
        raise ValueError('notify_url is not set')
    if kind == 'pushover':
        if not token or not user:
            raise ValueError('pushover needs notify_token and notify_user')
        body = urllib.parse.urlencode({
            'token': token, 'user': user, 'message': message,
            **({'title': title} if title else {}),
            **({'priority': str(priority)} if priority is not None else {}),
        }).encode()
        req = urllib.request.Request(url, data=body, method='POST')
    elif kind == 'ntfy':
        headers = {'Content-Type': 'text/plain; charset=utf-8'}
        if title:
            # ntfy reads its metadata from headers, and a header cannot carry a
            # newline or a non-latin-1 byte — so the title is flattened, and
            # anything exotic falls back to the message body rather than
            # throwing at the socket.
            flat = ' '.join(str(title).split())
            try:
                flat.encode('latin-1')
                headers['Title'] = flat
            except UnicodeEncodeError:
                message = f'{flat}\n{message}'
        if priority is not None:
            headers['Priority'] = str(priority)
        req = urllib.request.Request(url, data=message.encode('utf-8'),
                                     headers=headers, method='POST')
    else:
        raise ValueError(f'unknown notify_kind: {kind}')
    with urllib.request.urlopen(req, timeout=15) as response:
        return response.status
