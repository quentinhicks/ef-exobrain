"""Tests for schedule.py. Run: python schedule_test.py

No framework, no dependencies — plain asserts, same constraints as the app and
as recurrence_test.py. This module earns its own tests for the same reason
recurrence.py does: the three constructors are closed over each other, so a
union of a derived source of a schedule has to work without anyone having
written that case down. What is checked here is what "looks right" cannot tell
you — per-member durations surviving a union, an offset reaching back across
midnight, a count bound counted from the set's own beginning rather than from
the window being drawn, and a cycle being refused instead of hanging.
"""

from datetime import date as D, datetime as DT, timedelta

import schedule as S

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


def rule(uid, start, duration=None, freq='weekly', days=None, **kw):
    r = {'frequency': freq}
    if days:
        r['byDay'] = [{'day': d} for d in days]
    r.update(kw.pop('rule', {}))
    return dict({
        '@type': 'Event', 'uid': uid, 'sf:kind': 'rule',
        'title': uid, 'start': start, 'timeZone': None,
        'duration': duration, 'recurrenceRules': [r],
    }, **kw)


STORE = {}


def resolve(uid):
    return STORE.get(uid)


def occ(uid, a, b):
    return [(s.isoformat(sep=' '), e.isoformat(sep=' '))
            for s, e in S.occurrences(STORE[uid], resolve, a, b)]


def starts(uid, a, b):
    return [s.isoformat(sep=' ') for s, _ in S.occurrences(STORE[uid], resolve, a, b)]


# ── durations round-trip ─────────────────────────────────────

eq('parse PT3H30M', S.parse_duration('PT3H30M'), timedelta(hours=3, minutes=30))
eq('parse -PT1H', S.parse_duration('-PT1H'), timedelta(hours=-1))
eq('parse P1DT2H', S.parse_duration('P1DT2H'), timedelta(days=1, hours=2))
eq('parse blank is a moment', S.parse_duration(''), None)
eq('format 3h30', S.format_duration(timedelta(hours=3, minutes=30)), 'PT3H30M')
eq('format zero', S.format_duration(timedelta(0)), 'PT0S')
eq('format negative', S.format_duration(timedelta(hours=-1)), '-PT1H')
eq('human 3h30', S.human_duration(timedelta(hours=3, minutes=30)), '3 hr 30')
eq('human 45min', S.human_duration(timedelta(minutes=45)), '45 min')

# ── JSCalendar rule → RRULE ──────────────────────────────────

eq('rrule: weekly byDay',
   S.rrule_string({'frequency': 'weekly', 'byDay': [{'day': 'mo'}, {'day': 'we'}]}),
   'FREQ=WEEKLY;BYDAY=MO,WE')
eq('rrule: interval + wkst only above 1',
   S.rrule_string({'frequency': 'weekly', 'interval': 2, 'firstDayOfWeek': 'mo',
                   'byDay': [{'day': 'tu'}]}),
   'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=MO')
eq('rrule: wkst dropped at interval 1',
   S.rrule_string({'frequency': 'weekly', 'firstDayOfWeek': 'mo'}),
   'FREQ=WEEKLY')
eq('rrule: nthOfPeriod -1 is the same field as a plain weekday',
   S.rrule_string({'frequency': 'monthly', 'byDay': [{'day': 'fr', 'nthOfPeriod': -1}]}),
   'FREQ=MONTHLY;BYDAY=-1FR')

# ── 1 · Rule ─────────────────────────────────────────────────

STORE['rule-mtwf'] = rule('rule-mtwf', '2026-08-10T09:00:00', 'PT3H30M',
                          days=['mo', 'tu', 'th', 'fr'])
eq('rule: a week of Mon/Tue/Thu/Fri',
   starts('rule-mtwf', D(2026, 8, 10), D(2026, 8, 16)),
   ['2026-08-10 09:00:00', '2026-08-11 09:00:00',
    '2026-08-13 09:00:00', '2026-08-14 09:00:00'])
eq('rule: the duration is on the interval',
   occ('rule-mtwf', D(2026, 8, 10), D(2026, 8, 10)),
   [('2026-08-10 09:00:00', '2026-08-10 12:30:00')])

STORE['rule-moment'] = rule('rule-moment', '2026-08-10T21:00:00', None, freq='daily')
eq('rule: no duration is a moment, not a span',
   occ('rule-moment', D(2026, 8, 10), D(2026, 8, 10)),
   [('2026-08-10 21:00:00', '2026-08-10 21:00:00')])

# A rule starting later than the window asked about must not back-fill.
eq('rule: nothing before its start',
   starts('rule-mtwf', D(2026, 8, 1), D(2026, 8, 9)), [])

# ── overrides ────────────────────────────────────────────────

STORE['rule-ov'] = rule(
    'rule-ov', '2026-08-10T09:00:00', 'PT1H', freq='daily',
    **{'recurrenceOverrides': {
        '2026-08-11T09:00:00': {'excluded': True},
        '2026-08-12T09:00:00': {'start': '2026-08-12T10:00:00', 'duration': 'PT2H'},
    }})
eq('override: excluded day is gone, moved day moves',
   occ('rule-ov', D(2026, 8, 10), D(2026, 8, 12)),
   [('2026-08-10 09:00:00', '2026-08-10 10:00:00'),
    ('2026-08-12 10:00:00', '2026-08-12 12:00:00')])

# ── 2 · Schedule ─────────────────────────────────────────────
#
# The whole reason a schedule is a set of Events rather than a set of rules:
# Wednesday is SHORTER, and one Event cannot hold two durations.

STORE['rule-wed-short'] = rule('rule-wed-short', '2026-08-12T09:00:00', 'PT2H30M',
                               days=['we'])
STORE['sched-weekday-mornings'] = {
    '@type': 'Group', 'uid': 'sched-weekday-mornings', 'sf:kind': 'schedule',
    'title': 'Weekday mornings',
    'entries': ['rule-mtwf', 'rule-wed-short'], 'sf:ends': None,
}
eq('schedule: the union is ordered and each member keeps its own duration',
   occ('sched-weekday-mornings', D(2026, 8, 10), D(2026, 8, 14)),
   [('2026-08-10 09:00:00', '2026-08-10 12:30:00'),
    ('2026-08-11 09:00:00', '2026-08-11 12:30:00'),
    ('2026-08-12 09:00:00', '2026-08-12 11:30:00'),
    ('2026-08-13 09:00:00', '2026-08-13 12:30:00'),
    ('2026-08-14 09:00:00', '2026-08-14 12:30:00')])

# ── 3 · Derived ──────────────────────────────────────────────

STORE['sched-before-deep-work'] = {
    '@type': 'Event', 'uid': 'sched-before-deep-work', 'sf:kind': 'derived',
    'title': '1 hour before Deep work',
    'sf:follows': {'source': 'sched-weekday-mornings', 'relativeTo': 'start',
                   'offset': '-PT1H', 'extent': 'until-source-start'},
}
eq('derived: an hour before, ending when the source starts',
   occ('sched-before-deep-work', D(2026, 8, 12), D(2026, 8, 12)),
   [('2026-08-12 08:00:00', '2026-08-12 09:00:00')])
eq("derived: Wednesday's shorter block still gets the full hour",
   occ('sched-before-deep-work', D(2026, 8, 10), D(2026, 8, 12)),
   [('2026-08-10 08:00:00', '2026-08-10 09:00:00'),
    ('2026-08-11 08:00:00', '2026-08-11 09:00:00'),
    ('2026-08-12 08:00:00', '2026-08-12 09:00:00')])

# An offset that reaches back over midnight: the source is at 00:30, so the
# derived occurrence belongs to the PREVIOUS day and the range still finds it.
STORE['rule-early'] = rule('rule-early', '2026-08-10T00:30:00', 'PT1H', freq='daily')
STORE['derived-prev-day'] = {
    'uid': 'derived-prev-day', 'sf:kind': 'derived', 'title': 'before early',
    'sf:follows': {'source': 'rule-early', 'relativeTo': 'start',
                   'offset': '-PT2H', 'extent': 'until-source-start'},
}
# Both of these OVERLAP Aug 11 — one ends inside it, one starts inside it —
# and occurrences() is defined on overlap, not on start date. Asking only about
# starts would lose the window you are currently standing in at 00:15.
eq('derived: an offset across midnight lands on the day before',
   occ('derived-prev-day', D(2026, 8, 11), D(2026, 8, 11)),
   [('2026-08-10 22:30:00', '2026-08-11 00:30:00'),
    ('2026-08-11 22:30:00', '2026-08-12 00:30:00')])

# Skips propagate: excluded upstream means no occurrence downstream.
STORE['derived-of-ov'] = {
    'uid': 'derived-of-ov', 'sf:kind': 'derived', 'title': 'after ov',
    'sf:follows': {'source': 'rule-ov', 'relativeTo': 'end',
                   'offset': 'PT0S', 'extent': 'PT30M'},
}
eq('derived: a skipped upstream day is skipped here too',
   starts('derived-of-ov', D(2026, 8, 11), D(2026, 8, 11)), [])
eq('derived: relativeTo end + an explicit extent',
   occ('derived-of-ov', D(2026, 8, 10), D(2026, 8, 10)),
   [('2026-08-10 10:00:00', '2026-08-10 10:30:00')])

# `only` narrows which of the upstream days produce anything.
STORE['derived-mondays'] = {
    'uid': 'derived-mondays', 'sf:kind': 'derived', 'title': 'mondays only',
    'sf:follows': {'source': 'rule-mtwf', 'relativeTo': 'start', 'offset': '-PT1H',
                   'extent': 'until-source-start', 'only': {'byDay': ['mo']}},
}
eq('derived: only-on narrows the upstream days',
   starts('derived-mondays', D(2026, 8, 10), D(2026, 8, 16)), ['2026-08-10 08:00:00'])

# ── closed: a schedule of a derived source, and vice versa ───

STORE['sched-mixed'] = {
    'uid': 'sched-mixed', 'sf:kind': 'schedule', 'title': 'Mixed',
    'entries': ['rule-wed-short', 'sched-before-deep-work'],
}
eq('closed: a schedule may contain a derived source',
   starts('sched-mixed', D(2026, 8, 12), D(2026, 8, 12)),
   ['2026-08-12 08:00:00', '2026-08-12 09:00:00'])

STORE['derived-of-sched'] = {
    'uid': 'derived-of-sched', 'sf:kind': 'derived', 'title': 'after mixed',
    'sf:follows': {'source': 'sched-mixed', 'relativeTo': 'end', 'offset': 'PT0S',
                   'extent': 'PT15M'},
}
eq('closed: a derived source may wrap a schedule holding a derived source',
   occ('derived-of-sched', D(2026, 8, 12), D(2026, 8, 12)),
   [('2026-08-12 09:00:00', '2026-08-12 09:15:00'),
    ('2026-08-12 11:30:00', '2026-08-12 11:45:00')])

# ── sf:ends — the SET's ending, counted from its own beginning ─

STORE['rule-daily-13'] = rule('rule-daily-13', '2026-08-10T09:00:00', 'PT1H', freq='daily',
                              **{'sf:ends': {'count': 13}})
eq('ends count: the 13th is the last one',
   starts('rule-daily-13', D(2026, 8, 20), D(2026, 8, 30)),
   ['2026-08-20 09:00:00', '2026-08-21 09:00:00', '2026-08-22 09:00:00'])
eq('ends count: counted from the beginning, not from the window',
   len(starts('rule-daily-13', D(2026, 8, 10), D(2026, 12, 31))), 13)

STORE['rule-until'] = rule('rule-until', '2026-08-10T09:00:00', 'PT1H', freq='daily',
                           **{'sf:ends': {'date': '2026-08-12'}})
eq('ends date: inclusive of the last day',
   len(starts('rule-until', D(2026, 8, 10), D(2026, 8, 31))), 3)

# A member's own end must not bound the set; the SET's does.
STORE['sched-ends'] = {
    'uid': 'sched-ends', 'sf:kind': 'schedule', 'title': 'Bounded set',
    'entries': ['rule-mtwf', 'rule-wed-short'], 'sf:ends': {'count': 3},
}
eq('ends count on a union: three occurrences across both members',
   starts('sched-ends', D(2026, 8, 10), D(2026, 8, 31)),
   ['2026-08-10 09:00:00', '2026-08-11 09:00:00', '2026-08-12 09:00:00'])

# ── skip: backward ───────────────────────────────────────────

STORE['rule-31st'] = rule('rule-31st', '2026-01-31T09:00:00', 'PT1H', freq='monthly',
                          rule={'byMonthDay': [31], 'skip': 'backward'})
eq('skip backward: a short month uses its last day',
   starts('rule-31st', D(2026, 1, 1), D(2026, 4, 30)),
   ['2026-01-31 09:00:00', '2026-02-28 09:00:00',
    '2026-03-31 09:00:00', '2026-04-30 09:00:00'])

STORE['rule-31st-omit'] = rule('rule-31st-omit', '2026-01-31T09:00:00', 'PT1H',
                               freq='monthly', rule={'byMonthDay': [31], 'skip': 'omit'})
eq('skip omit: the month is skipped instead',
   starts('rule-31st-omit', D(2026, 1, 1), D(2026, 4, 30)),
   ['2026-01-31 09:00:00', '2026-03-31 09:00:00'])

# ── cycles are refused, not hung on ──────────────────────────

STORE['cyc-a'] = {'uid': 'cyc-a', 'sf:kind': 'schedule', 'title': 'A', 'entries': ['cyc-b']}
STORE['cyc-b'] = {'uid': 'cyc-b', 'sf:kind': 'schedule', 'title': 'B', 'entries': ['cyc-a']}
try:
    S.occurrences(STORE['cyc-a'], resolve, D(2026, 8, 10), D(2026, 8, 11))
    eq('cycle: occurrences refuses', 'no error', 'Cycle')
except S.Cycle:
    eq('cycle: occurrences refuses', 'Cycle', 'Cycle')

try:
    S.check_acyclic('cyc-a', {'sf:kind': 'schedule', 'entries': ['cyc-b']}, resolve)
    eq('cycle: check_acyclic refuses on save', 'no error', 'Cycle')
except S.Cycle:
    eq('cycle: check_acyclic refuses on save', 'Cycle', 'Cycle')

eq('acyclic: a legitimate graph passes',
   S.check_acyclic('sched-weekday-mornings', STORE['sched-weekday-mornings'], resolve), None)

# ── the day half a phone can answer ──────────────────────────

eq('day_intervals: wall clock for one date',
   S.day_intervals(STORE['sched-weekday-mornings'], resolve, D(2026, 8, 12)),
   [{'start': '09:00', 'end': '11:30', 'from_previous': False, 'into_next': False}])
eq('day_intervals: a span across midnight is clipped at both edges of the day',
   S.day_intervals(STORE['derived-prev-day'], resolve, D(2026, 8, 11)),
   [{'start': '00:00', 'end': '00:30', 'from_previous': True, 'into_next': False},
    {'start': '22:30', 'end': '24:00', 'from_previous': False, 'into_next': True}])
eq('occurs_on: the predicate', S.occurs_on(STORE['rule-mtwf'], resolve, D(2026, 8, 12)), False)

# ── the sentence at the foot of the picker ───────────────────

eq('describe: a consecutive run reads as a range',
   S.describe(STORE['rule-mtwf'], resolve), 'Mon, Tue, Thu, Fri at 09:00 for 3 hr 30')
eq('describe: Mon–Fri',
   S.describe(rule('r', '2026-08-10T09:00:00', 'PT3H30M',
                   days=['mo', 'tu', 'we', 'th', 'fr']), resolve),
   'Mon–Fri at 09:00 for 3 hr 30')
eq('describe: a schedule states the variation',
   S.describe(STORE['sched-weekday-mornings'], resolve),
   'Mon, Tue, Thu, Fri at 09:00 for 3 hr 30, except Wed at 09:00 for 2 hr 30')
eq('describe: derived',
   S.describe(STORE['sched-before-deep-work'], resolve),
   '1 hr before Weekday mornings starts, until Weekday mornings starts')
eq('describe: the last Friday of the month',
   S.describe(rule('r', '2026-08-28T17:00:00', 'PT1H', freq='monthly',
                   rule={'byDay': [{'day': 'fr', 'nthOfPeriod': -1}]}), resolve),
   'last Fri at 17:00 for 1 hr')
eq('describe: an ending is stated',
   S.describe(STORE['rule-daily-13'], resolve), 'Every day at 09:00 for 1 hr, 13 times')

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
