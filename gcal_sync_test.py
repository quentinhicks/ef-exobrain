"""What Google says is gone leaves the calendar. Run: python gcal_sync_test.py

Quentin's report (2026-09-29): events he had deleted in Google Calendar stayed
in the app however often he refreshed. Four causes, each pinned here:

  - an occurrence deleted from a repeating series arrives as an EXDATE on the
    series, which the parser never read, so it expanded back every refresh;
  - a cancelled occurrence (RECURRENCE-ID + STATUS:CANCELLED) and a cancelled
    event were drawn like live ones;
  - an unbounded series was expanded to a year after its FIRST occurrence, so a
    weekly meeting older than a year vanished instead;
  - the sync only replaced today forward, so a past event deleted in Google was
    frozen in the app for good. Inside the read window the feed is the truth
    now — unless the feed publishes no past at all, when the past is kept.

Same shape as the other suites: a temp database, no framework.
"""

import os
import sys
import tempfile
from datetime import date as date_cls, datetime, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

storage.init_db()
# Importing app starts the backup thread; a stamped date keeps it from firing.
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import aggregator       # noqa: E402
import app              # noqa: E402

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


today = date_cls.today()
ical = lambda d: d.strftime('%Y%m%d')
# A weekly series that began two years ago, on today's weekday.
series_start = today - timedelta(weeks=104)
next_week = today + timedelta(weeks=1)
in_two = today + timedelta(weeks=2)
last_week = today - timedelta(weeks=1)

FEED = f"""BEGIN:VCALENDAR
BEGIN:VEVENT
UID:series
SUMMARY:Weekly
DTSTART:{ical(series_start)}T100000
DTEND:{ical(series_start)}T110000
RRULE:FREQ=WEEKLY
EXDATE:{ical(next_week)}T100000
END:VEVENT
BEGIN:VEVENT
UID:series
SUMMARY:Weekly
RECURRENCE-ID:{ical(in_two)}T100000
DTSTART:{ical(in_two)}T100000
DTEND:{ical(in_two)}T110000
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:gone
SUMMARY:Cancelled one-off
DTSTART:{ical(today + timedelta(days=3))}T090000
DTEND:{ical(today + timedelta(days=3))}T100000
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:kept
SUMMARY:Still on
DTSTART:{ical(today + timedelta(days=3))}T120000
DTEND:{ical(today + timedelta(days=3))}T130000
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR
"""

occ = app._build_occurrences(aggregator._parse_events(FEED))
starts = {(o['uid'], o['start'][:10]) for o in occ}

eq('an old unbounded series still reaches today', ('series', today.isoformat()) in starts, True)
eq('and still reaches a year ahead',
   ('series', (today + timedelta(weeks=50)).isoformat()) in starts, True)
eq('an EXDATE occurrence is not drawn', ('series', next_week.isoformat()) in starts, False)
eq('a cancelled occurrence of the series is not drawn', ('series', in_two.isoformat()) in starts, False)
eq('a cancelled one-off is not drawn', any(u == 'gone' for u, _ in starts), False)
eq('a confirmed one-off is drawn', any(u == 'kept' for u, _ in starts), True)

# ── the sync: the feed is the truth inside the read window ──────────────
src = storage.create_calendar_source('Test', 'http://example.invalid/feed.ics', '#98b9dd')
at = lambda d, hm: f'{d.isoformat()}T{hm}:00'
old = today - timedelta(days=storage.GCAL_DAYS_BACK + 5)   # outside the window
recent = today - timedelta(days=3)                          # inside it
for uid, d in [('ancient', old), ('deleted-later', recent), ('kept-past', recent)]:
    storage.insert_gcal_event(src['id'], uid, uid, at(d, '09:00'), at(d, '10:00'))

row = lambda uid, d: {'uid': uid, 'summary': uid, 'start': at(d, '09:00'),
                      'end': at(d, '10:00'), 'allday': 0}
# The feed now lists only 'kept-past' in the past: 'deleted-later' was deleted.
storage.replace_source_events(src['id'], [row('kept-past', recent), row('future', today)],
                              datetime.now().isoformat())


def uids():
    conn = storage.get_conn()
    got = {r[0] for r in conn.execute('SELECT uid FROM gcal_event WHERE source_id = ?', (src['id'],))}
    conn.close()
    return got


eq('a past event deleted in Google leaves, inside the window', 'deleted-later' in uids(), False)
eq('a past event the feed still has stays', 'kept-past' in uids(), True)
eq('beyond the read window the past is kept as recorded', 'ancient' in uids(), True)
eq('the future is replaced as before', 'future' in uids(), True)

# A feed with NO past at all may not publish the past: keep it.
storage.insert_gcal_event(src['id'], 'deleted-later', 'x', at(recent, '09:00'), at(recent, '10:00'))
storage.replace_source_events(src['id'], [row('future', today)], datetime.now().isoformat())
eq('a future-only feed does not wipe the last month', {'kept-past', 'deleted-later'} <= uids(), True)

# "Delete this and following" ends a series with a UTC INSTANT just before the
# first deleted occurrence (2026-09-30). recurrence.py keeps UNTIL's DATE
# inclusive, so the deleted day came back until the time half was checked.
from datetime import timezone   # noqa: E402
cut = today + timedelta(days=7)
until = (datetime.combine(cut, datetime.min.time()).replace(hour=17).astimezone()
         - timedelta(seconds=1)).astimezone(timezone.utc)
starts = [s for s, _ in aggregator.expand_rrule(
    f"FREQ=DAILY;UNTIL={until.strftime('%Y%m%dT%H%M%SZ')}",
    datetime.combine(today, datetime.min.time()).replace(hour=17), timedelta(hours=1))]
eq('a UTC UNTIL just before an occurrence drops that occurrence',
   f'{cut.isoformat()}T17:00:00' in starts, False)
eq('...and keeps the one before it', f'{(cut - timedelta(days=1)).isoformat()}T17:00:00' in starts, True)
starts = [s for s, _ in aggregator.expand_rrule(
    f'FREQ=DAILY;UNTIL={ical(cut)}',
    datetime.combine(today, datetime.min.time()).replace(hour=17), timedelta(hours=1))]
eq('a date-only UNTIL is still inclusive', f'{cut.isoformat()}T17:00:00' in starts, True)

# A feed Google refuses keeps its last copy, and the refresh SAYS which.
real_fetch = app.fetch_gcal
def refuse(url):
    raise OSError('HTTP Error 429: Too Many Requests')
app.fetch_gcal = refuse
failed = app._rebuild_source_safe({'id': src['id'], 'name': 'Personal', 'url': 'x'})
app.fetch_gcal = real_fetch
eq('a refused feed is reported by name', failed and failed['name'], 'Personal')
eq('...with the reason Google gave', '429' in (failed or {}).get('error', ''), True)
eq('...and its events are kept', 'future' in uids(), True)

print()
if fails:
    print(f'{len(fails)} failure(s)')
    sys.exit(1)
print('What Google says is gone leaves the calendar.')
