"""Tests for recurrence.py. Run: python recurrence_test.py

No framework, no dependencies — plain asserts, same constraints as the app.
This module gets its own tests because it is the one place where "looks
right" and "is right" come apart: nth-weekday, negative ordinals, month-end,
leap years and interval phase are all easy to write plausibly and wrongly,
and everything that repeats is going to depend on it.
"""

from datetime import date as D

import recurrence as R

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


def occ(rule, dtstart, a, b):
    return R.between(rule, dtstart, a, b)


# ── the five the app was specced against ─────────────────────
eq('once a week',
   occ('FREQ=WEEKLY', D(2026, 1, 1), D(2026, 1, 1), D(2026, 1, 29)),
   [D(2026, 1, 1), D(2026, 1, 8), D(2026, 1, 15), D(2026, 1, 22), D(2026, 1, 29)])

eq('once per 10 days',
   occ('FREQ=DAILY;INTERVAL=10', D(2026, 1, 1), D(2026, 1, 1), D(2026, 2, 1)),
   [D(2026, 1, 1), D(2026, 1, 11), D(2026, 1, 21), D(2026, 1, 31)])

eq('first Sunday of the month',
   occ('FREQ=MONTHLY;BYDAY=1SU', D(2026, 1, 1), D(2026, 1, 1), D(2026, 4, 30)),
   [D(2026, 1, 4), D(2026, 2, 1), D(2026, 3, 1), D(2026, 4, 5)])

eq('first Sunday of the YEAR (ordinal spans the year, not the month)',
   occ('FREQ=YEARLY;BYDAY=1SU', D(2026, 1, 1), D(2026, 1, 1), D(2028, 12, 31)),
   [D(2026, 1, 4), D(2027, 1, 3), D(2028, 1, 2)])

eq('every other year, every Sunday',
   occ('FREQ=YEARLY;INTERVAL=2;BYDAY=SU', D(2026, 1, 1), D(2026, 1, 1), D(2026, 1, 31))
   + occ('FREQ=YEARLY;INTERVAL=2;BYDAY=SU', D(2026, 1, 1), D(2027, 1, 1), D(2027, 1, 31)),
   [D(2026, 1, 4), D(2026, 1, 11), D(2026, 1, 18), D(2026, 1, 25)])   # 2027 skipped

# ── ordinals, negative and otherwise ─────────────────────────
eq('last Friday of the month',
   occ('FREQ=MONTHLY;BYDAY=-1FR', D(2026, 1, 1), D(2026, 1, 1), D(2026, 3, 31)),
   [D(2026, 1, 30), D(2026, 2, 27), D(2026, 3, 27)])

eq('last weekday of the month (BYSETPOS over a BYDAY set)',
   occ('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', D(2026, 1, 1), D(2026, 5, 1), D(2026, 5, 31)),
   [D(2026, 5, 29)])

eq('second Tuesday of the month',
   occ('FREQ=MONTHLY;BYDAY=2TU', D(2026, 1, 1), D(2026, 1, 1), D(2026, 2, 28)),
   [D(2026, 1, 13), D(2026, 2, 10)])

eq('a month with five Sundays still gives ONE first Sunday',
   occ('FREQ=MONTHLY;BYDAY=1SU', D(2026, 3, 1), D(2026, 3, 1), D(2026, 3, 31)),
   [D(2026, 3, 1)])

# ── month-end and leap years ─────────────────────────────────
eq('the 31st skips months that have no 31st',
   occ('FREQ=MONTHLY;BYMONTHDAY=31', D(2026, 1, 31), D(2026, 1, 1), D(2026, 5, 31)),
   [D(2026, 1, 31), D(2026, 3, 31), D(2026, 5, 31)])

eq('last day of every month (BYMONTHDAY=-1)',
   occ('FREQ=MONTHLY;BYMONTHDAY=-1', D(2026, 1, 1), D(2026, 1, 1), D(2026, 4, 30)),
   [D(2026, 1, 31), D(2026, 2, 28), D(2026, 3, 31), D(2026, 4, 30)])

eq('Feb 29 only lands on leap years',
   occ('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', D(2024, 2, 29), D(2024, 1, 1), D(2029, 12, 31)),
   [D(2024, 2, 29), D(2028, 2, 29)])

eq('a bare monthly rule repeats DTSTART\'s day',
   occ('FREQ=MONTHLY', D(2026, 1, 14), D(2026, 1, 1), D(2026, 4, 30)),
   [D(2026, 1, 14), D(2026, 2, 14), D(2026, 3, 14), D(2026, 4, 14)])

eq('a bare yearly rule repeats DTSTART\'s month and day',
   occ('FREQ=YEARLY', D(2026, 6, 9), D(2026, 1, 1), D(2029, 12, 31)),
   [D(2026, 6, 9), D(2027, 6, 9), D(2028, 6, 9), D(2029, 6, 9)])

# ── interval phase ───────────────────────────────────────────
eq('biweekly keeps DTSTART\'s phase when the window starts mid-schedule',
   occ('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', D(2026, 1, 5), D(2026, 2, 1), D(2026, 3, 15)),
   [D(2026, 2, 2), D(2026, 2, 16), D(2026, 3, 2)])

eq('multi-day weekly with an interval',
   occ('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', D(2026, 1, 5), D(2026, 1, 1), D(2026, 1, 25)),
   [D(2026, 1, 5), D(2026, 1, 7), D(2026, 1, 9),
    D(2026, 1, 19), D(2026, 1, 21), D(2026, 1, 23)])

eq('quarterly',
   occ('FREQ=MONTHLY;INTERVAL=3', D(2026, 1, 15), D(2026, 1, 1), D(2026, 12, 31)),
   [D(2026, 1, 15), D(2026, 4, 15), D(2026, 7, 15), D(2026, 10, 15)])

# ── bounds ───────────────────────────────────────────────────
eq('COUNT caps the series',
   occ('FREQ=DAILY;COUNT=3', D(2026, 1, 1), D(2026, 1, 1), D(2026, 1, 31)),
   [D(2026, 1, 1), D(2026, 1, 2), D(2026, 1, 3)])

eq('COUNT is counted from DTSTART, not from the window',
   occ('FREQ=DAILY;COUNT=3', D(2026, 1, 1), D(2026, 1, 3), D(2026, 1, 31)),
   [D(2026, 1, 3)])

eq('UNTIL is inclusive',
   occ('FREQ=DAILY;UNTIL=20260103', D(2026, 1, 1), D(2026, 1, 1), D(2026, 1, 31)),
   [D(2026, 1, 1), D(2026, 1, 2), D(2026, 1, 3)])

eq('UNTIL with a UTC timestamp still bounds by date',
   occ('FREQ=DAILY;UNTIL=20260102T235959Z', D(2026, 1, 1), D(2026, 1, 1), D(2026, 1, 31)),
   [D(2026, 1, 1), D(2026, 1, 2)])

eq('nothing occurs before DTSTART',
   occ('FREQ=DAILY', D(2026, 6, 1), D(2026, 1, 1), D(2026, 6, 3)),
   [D(2026, 6, 1), D(2026, 6, 2), D(2026, 6, 3)])

# ── the predicate agrees with the enumeration ────────────────
def agrees(rule, dtstart, a, b):
    listed = set(R.between(rule, dtstart, a, b))
    probed, d = set(), a
    while d <= b:
        if R.occurs_on(rule, dtstart, d):
            probed.add(d)
        d = D.fromordinal(d.toordinal() + 1)
    return listed == probed


for label, rule, ds in [
    ('weekly', 'FREQ=WEEKLY;BYDAY=TU,TH', D(2026, 1, 1)),
    ('10-daily', 'FREQ=DAILY;INTERVAL=10', D(2026, 1, 1)),
    ('1st Sun of month', 'FREQ=MONTHLY;BYDAY=1SU', D(2026, 1, 1)),
    ('1st Sun of year', 'FREQ=YEARLY;BYDAY=1SU', D(2026, 1, 1)),
    ('biennial Sundays', 'FREQ=YEARLY;INTERVAL=2;BYDAY=SU', D(2026, 1, 1)),
    ('last weekday', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', D(2026, 1, 1)),
    ('month-end', 'FREQ=MONTHLY;BYMONTHDAY=-1', D(2026, 1, 1)),
    ('capped', 'FREQ=DAILY;COUNT=5', D(2026, 1, 1)),
    ('bounded', 'FREQ=WEEKLY;UNTIL=20260401', D(2026, 1, 1)),
]:
    eq(f'occurs_on agrees with between — {label}',
       agrees(rule, ds, D(2026, 1, 1), D(2027, 12, 31)), True)

# ── junk in, nothing out ─────────────────────────────────────
eq('empty rule matches nothing', R.occurs_on('', D(2026, 1, 1), D(2026, 1, 1)), False)
eq('unknown FREQ matches nothing',
   R.occurs_on('FREQ=FORTNIGHTLY', D(2026, 1, 1), D(2026, 1, 1)), False)
eq('an RRULE: prefix is tolerated',
   R.occurs_on('RRULE:FREQ=DAILY', D(2026, 1, 1), D(2026, 1, 5)), True)

# ── describe ─────────────────────────────────────────────────
eq('describe: monthly nth', R.describe('FREQ=MONTHLY;BYDAY=1SU'), 'every month on 1st Sun')
eq('describe: interval', R.describe('FREQ=DAILY;INTERVAL=10'), 'every 10 days')
eq('describe: last weekday',
   R.describe('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),
   'every month on Mon, Tue, Wed, Thu, Fri (last of those)')

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
