import csv
import io
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


_DAY_MAP = {'MO': 0, 'TU': 1, 'WE': 2, 'TH': 3, 'FR': 4, 'SA': 5, 'SU': 6}


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
    params = {}
    for part in rrule_str.split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            params[k] = v

    freq = params.get('FREQ', '')
    interval = int(params.get('INTERVAL', 1))
    count = int(params['COUNT']) if 'COUNT' in params else None

    until = None
    if 'UNTIL' in params:
        u = params['UNTIL']
        if u.endswith('Z'):
            until = datetime.strptime(u, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
        elif 'T' in u:
            until = datetime.strptime(u[:15], '%Y%m%dT%H%M%S')
        else:
            until = datetime.strptime(u[:8], '%Y%m%d')

    # cap at 1 year if no explicit bound
    cap = until or (dtstart + timedelta(days=365))

    byday = [_DAY_MAP[d.strip()[-2:]] for d in params['BYDAY'].split(',')] if 'BYDAY' in params else []

    results = []

    if freq == 'WEEKLY':
        week_anchor = dtstart - timedelta(days=dtstart.weekday())
        cur = week_anchor
        for _ in range(500):
            if cur > cap:
                break
            for dow in (byday or [dtstart.weekday()]):
                candidate = cur + timedelta(days=dow)
                if candidate < dtstart or candidate > cap:
                    continue
                results.append((_fmt(candidate), _fmt(candidate + duration)))
                if count and len(results) >= count:
                    return results
            cur += timedelta(weeks=interval)

    elif freq == 'DAILY':
        cur = dtstart
        for _ in range(500):
            if cur > cap:
                break
            results.append((_fmt(cur), _fmt(cur + duration)))
            if count and len(results) >= count:
                break
            cur += timedelta(days=interval)

    elif freq == 'MONTHLY':
        cur = dtstart
        for _ in range(200):
            if cur > cap:
                break
            results.append((_fmt(cur), _fmt(cur + duration)))
            if count and len(results) >= count:
                break
            month = cur.month - 1 + interval
            year = cur.year + month // 12
            month = month % 12 + 1
            try:
                cur = cur.replace(year=year, month=month)
            except ValueError:
                break

    return results


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
