"""RFC 5545 RRULE — one recurrence grammar for everything in this app that repeats.

Pure stdlib, date-level, no dependencies (dateutil would break the stack rule
in CLAUDE.md). Two entry points:

    occurs_on(rule, dtstart, day)   -> bool     the PREDICATE
    between(rule, dtstart, a, b)    -> [date]   enumeration

The predicate is the primary one, because that is what the app actually asks:
"is this due today". Most of RRULE's difficulty lives in enumeration and
bounding, which only the calendar ingest needs.

Supported: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL,
BYDAY (with signed ordinals), BYMONTHDAY (incl. negative), BYMONTH,
BYSETPOS, WKST. Unsupported and ignored: BYYEARDAY, BYWEEKNO, BYHOUR and
below (this module is date-level), RDATE/EXDATE (those are siblings of RRULE
in the iCalendar object, not part of the rule string).

    FREQ=WEEKLY                          once a week
    FREQ=DAILY;INTERVAL=10               once per 10 days
    FREQ=MONTHLY;BYDAY=1SU               first Sunday of the month
    FREQ=YEARLY;BYDAY=1SU                first Sunday of the year
    FREQ=YEARLY;INTERVAL=2;BYDAY=SU      every other year, every Sunday
    FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1   last weekday of the month
"""

from calendar import monthrange
from datetime import date as date_cls, datetime, timedelta

DAYS = ('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU')
_DAY_NUM = {d: i for i, d in enumerate(DAYS)}


def parse(text):
    # Accepts "FREQ=..;.." with or without a leading "RRULE:".
    rule = {}
    if not text:
        return rule
    text = text.strip()
    if text.upper().startswith('RRULE:'):
        text = text[6:]
    for part in text.split(';'):
        if '=' not in part:
            continue
        k, v = part.split('=', 1)
        k = k.strip().upper()
        v = v.strip()
        if k in ('FREQ', 'WKST'):
            rule[k] = v.upper()
        elif k in ('INTERVAL', 'COUNT'):
            try:
                rule[k] = max(1, int(v))
            except ValueError:
                pass
        elif k == 'UNTIL':
            rule[k] = _parse_until(v)
        elif k in ('BYMONTHDAY', 'BYMONTH', 'BYSETPOS'):
            rule[k] = [int(x) for x in v.split(',') if x.strip().lstrip('+-').isdigit()]
        elif k == 'BYDAY':
            rule[k] = [_parse_byday(x) for x in v.split(',') if x.strip()]
            rule[k] = [x for x in rule[k] if x]
    return rule


def _parse_until(v):
    # UNTIL is a date or a UTC datetime; this module is date-level, so the
    # time is dropped and the bound stays INCLUSIVE either way.
    v = v.strip().rstrip('Z')
    try:
        return datetime.strptime(v[:8], '%Y%m%d').date()
    except ValueError:
        return None


def _parse_byday(tok):
    # "1SU" / "-1FR" / "MO" → (ordinal|None, weekday)
    tok = tok.strip().upper()
    day = tok[-2:]
    if day not in _DAY_NUM:
        return None
    ordinal = tok[:-2]
    if not ordinal or ordinal in ('+', '-'):
        return (None, _DAY_NUM[day])
    try:
        return (int(ordinal), _DAY_NUM[day])
    except ValueError:
        return (None, _DAY_NUM[day])


def _as_date(d):
    return d.date() if isinstance(d, datetime) else d


# ── Periods ──────────────────────────────────────────────────
#
# Everything is answered per PERIOD: find the period the day falls in, check
# the interval lands on it, build that period's candidate days from the BY*
# parts, apply BYSETPOS, and test membership. Doing it this way is what makes
# BYSETPOS ("last weekday of the month") fall out for free instead of being a
# special case — it needs the whole period's candidates anyway.

def _period_start(freq, day, wkst):
    if freq == 'WEEKLY':
        return day - timedelta(days=(day.weekday() - wkst) % 7)
    if freq == 'MONTHLY':
        return day.replace(day=1)
    if freq == 'YEARLY':
        return day.replace(month=1, day=1)
    return day                                   # DAILY


def _periods_apart(freq, a, b, wkst):
    # How many whole periods from a's period to b's.
    if freq == 'DAILY':
        return (b - a).days
    if freq == 'WEEKLY':
        return (_period_start('WEEKLY', b, wkst) - _period_start('WEEKLY', a, wkst)).days // 7
    if freq == 'MONTHLY':
        return (b.year - a.year) * 12 + (b.month - a.month)
    return b.year - a.year                        # YEARLY


def _days_in(freq, start):
    if freq == 'DAILY':
        return [start]
    if freq == 'WEEKLY':
        return [start + timedelta(days=i) for i in range(7)]
    if freq == 'MONTHLY':
        return [start.replace(day=i + 1) for i in range(monthrange(start.year, start.month)[1])]
    out = []
    for m in range(1, 13):
        for i in range(monthrange(start.year, m)[1]):
            out.append(date_cls(start.year, m, i + 1))
    return out


def _nth_matches(days, ordinal, weekday):
    # The ordinal in BYDAY counts within the PERIOD — so 1SU under MONTHLY is
    # the first Sunday of the month, and under YEARLY (with no BYMONTH) the
    # first Sunday of the YEAR. That difference is the whole reason ordinals
    # can't be resolved without knowing the frequency.
    hits = [d for d in days if d.weekday() == weekday]
    if not hits:
        return []
    if ordinal is None:
        return hits
    idx = ordinal - 1 if ordinal > 0 else len(hits) + ordinal
    return [hits[idx]] if 0 <= idx < len(hits) else []


def _candidates(rule, dtstart, period_start):
    freq = rule.get('FREQ', 'DAILY')
    days = _days_in(freq, period_start)
    byday = rule.get('BYDAY')
    bymonthday = rule.get('BYMONTHDAY')
    bymonth = rule.get('BYMONTH')

    if bymonth:
        days = [d for d in days if d.month in bymonth]

    # With no BY* part, the rule repeats DTSTART's own position in the period
    # (RFC 5545 §3.3.10). This is what makes bare "FREQ=MONTHLY" mean "the 14th
    # of every month" when it started on the 14th.
    if not byday and not bymonthday:
        if freq == 'WEEKLY':
            byday = [(None, dtstart.weekday())]
        elif freq == 'MONTHLY':
            bymonthday = [dtstart.day]
        elif freq == 'YEARLY':
            if not bymonth:
                days = [d for d in days if d.month == dtstart.month]
            bymonthday = [dtstart.day]

    # No narrowing left after the defaults — every day of the period counts.
    # In practice this is DAILY, whose period IS the day: the INTERVAL check
    # in _on_schedule has already decided it, and BY* parts (if any) only
    # filter from here.
    if not byday and not bymonthday:
        return sorted(days)

    picked = set()
    if bymonthday:
        for d in days:
            last = monthrange(d.year, d.month)[1]
            if d.day in bymonthday or (d.day - last - 1) in bymonthday:
                picked.add(d)
    if byday:
        # A YEARLY rule that also names months resolves its ordinals within
        # each month, not across the year — "1SU in Jan and Jun", not "the
        # first Sunday of the year".
        groups = [days]
        if freq == 'YEARLY' and bymonth:
            groups = [[d for d in days if d.month == m] for m in sorted(set(bymonth))]
        elif freq == 'MONTHLY':
            groups = [days]
        for g in groups:
            for ordinal, weekday in byday:
                picked.update(_nth_matches(g, ordinal, weekday))

    out = sorted(picked)
    setpos = rule.get('BYSETPOS')
    if setpos and out:
        chosen = []
        for p in setpos:
            idx = p - 1 if p > 0 else len(out) + p
            if 0 <= idx < len(out):
                chosen.append(out[idx])
        out = sorted(set(chosen))
    return out


def _on_schedule(rule, dtstart, day):
    """Ignores COUNT/UNTIL — the pure cadence test."""
    freq = rule.get('FREQ')
    if freq not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'):
        return False
    if day < dtstart:
        return False
    interval = rule.get('INTERVAL', 1)
    wkst = _DAY_NUM.get(rule.get('WKST', 'MO'), 0)

    apart = _periods_apart(freq, dtstart, day, wkst)
    if apart < 0 or apart % interval:
        return False
    # DAILY's period IS the day, so the interval check above already decided
    # it; the BY* parts then act as a filter on that day.
    return day in _candidates(rule, dtstart, _period_start(freq, day, wkst))


def occurs_on(rule, dtstart, day):
    if isinstance(rule, str):
        rule = parse(rule)
    if not rule:
        return False
    dtstart, day = _as_date(dtstart), _as_date(day)
    until = rule.get('UNTIL')
    if until and day > until:
        return False
    if not _on_schedule(rule, dtstart, day):
        return False
    count = rule.get('COUNT')
    if count:
        # COUNT is the one part that cannot be answered locally — it needs to
        # know how many occurrences came before this one.
        seen = 0
        for d in _iter(rule, dtstart, dtstart, day):
            seen += 1
            if seen > count:
                return False
        return seen <= count
    return True


def _iter(rule, dtstart, start, end):
    freq = rule.get('FREQ')
    wkst = _DAY_NUM.get(rule.get('WKST', 'MO'), 0)
    interval = rule.get('INTERVAL', 1)
    cur = _period_start(freq, max(dtstart, start), wkst)
    # Step back to a period that is on-interval, so a window starting
    # mid-schedule still lines up with DTSTART's phase.
    guard = 0
    while _periods_apart(freq, dtstart, cur, wkst) % interval and guard < 400:
        cur -= timedelta(days=1)
        cur = _period_start(freq, cur, wkst)
        guard += 1
    while cur <= end and guard < 100000:
        guard += 1
        for d in _candidates(rule, dtstart, cur):
            if d < dtstart or d < start:
                continue
            if d > end:
                return
            yield d
        cur = _advance(freq, cur, interval, wkst)


def _advance(freq, period_start, interval, wkst):
    if freq == 'DAILY':
        return period_start + timedelta(days=interval)
    if freq == 'WEEKLY':
        return period_start + timedelta(weeks=interval)
    if freq == 'MONTHLY':
        m = period_start.month - 1 + interval
        return date_cls(period_start.year + m // 12, m % 12 + 1, 1)
    return date_cls(period_start.year + interval, 1, 1)


def between(rule, dtstart, start, end):
    """Every occurrence in [start, end], honouring COUNT and UNTIL."""
    if isinstance(rule, str):
        rule = parse(rule)
    if not rule or rule.get('FREQ') not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'):
        return []
    dtstart, start, end = _as_date(dtstart), _as_date(start), _as_date(end)
    until = rule.get('UNTIL')
    if until:
        end = min(end, until)
    count = rule.get('COUNT')
    if not count:
        return list(_iter(rule, dtstart, start, end))
    # With COUNT the window has to be walked from DTSTART, since the cap is
    # counted from there rather than from the window.
    out = []
    for i, d in enumerate(_iter(rule, dtstart, dtstart, end)):
        if i >= count:
            break
        if d >= start:
            out.append(d)
    return out


def describe(rule):
    """Human-readable, for a UI that has to show what was configured."""
    if isinstance(rule, str):
        rule = parse(rule)
    if not rule:
        return ''
    freq = rule.get('FREQ', '')
    n = rule.get('INTERVAL', 1)
    unit = {'DAILY': 'day', 'WEEKLY': 'week', 'MONTHLY': 'month', 'YEARLY': 'year'}.get(freq, '')
    base = f'every {unit}' if n == 1 else f'every {n} {unit}s'
    bits = [base]
    if rule.get('BYDAY'):
        names = []
        for ordinal, wd in rule['BYDAY']:
            d = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')[wd]
            if ordinal is None:
                names.append(d)
            elif ordinal == -1:
                names.append(f'last {d}')
            else:
                names.append(f'{_ord(ordinal)} {d}')
        bits.append('on ' + ', '.join(names))
    if rule.get('BYMONTHDAY'):
        bits.append('on day ' + ', '.join(str(x) for x in rule['BYMONTHDAY']))
    if rule.get('BYMONTH'):
        months = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')
        bits.append('in ' + ', '.join(months[m - 1] for m in rule['BYMONTH'] if 1 <= m <= 12))
    if rule.get('BYSETPOS'):
        bits.append('(' + ', '.join(f'{_ord(p)} of those' if p > 0 else 'last of those'
                                    for p in rule['BYSETPOS']) + ')')
    if rule.get('COUNT'):
        bits.append(f"{rule['COUNT']} times")
    if rule.get('UNTIL'):
        bits.append(f"until {rule['UNTIL'].isoformat()}")
    return ' '.join(bits)


def _ord(n):
    return f'{n}{"th" if 11 <= abs(n) % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(abs(n) % 10, "th")}'
