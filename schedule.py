"""The schedule model — one occurrence source, three constructors.

Ported from Claude Design (project 82343144-9c74-405a-8a03-5d1a2c5b82c7, file
`Schedule Model.dc.html`). Everything in this app that happens on a schedule
resolves through ONE interface:

    occurrences(source, resolve, start, end) -> [(start_dt, end_dt), ...]

Blocks, tasks and gates do not each get a scheduling model — they hold a
source uid and ask this module. Three constructors, closed over each other:

    rule      the atom: one pattern, one time of day, one duration
    schedule  a union of sources under one name; each member keeps its own
              duration, which is what "Wednesday is shorter" requires
    derived   one source transformed — shifted by an offset, cut to an extent.
              Resolves at READ time, so upstream edits are inherited.

Because union and transform are closed over the same type there are no depth
rules to enforce; only that the reference graph stays acyclic, which is checked
here (`Cycle`) as well as on save.

Stored as JSCalendar (RFC 8984) field names rather than a private vocabulary:
`start`, `duration`, `recurrenceRules` with `frequency`/`interval`/`byDay`,
`recurrenceOverrides`. Three `sf:` additions carry what the standard has no
field for: `sf:kind`, `sf:ends` (the SET's ending, so members need none) and
`sf:follows` (the derived constructor), whose field names are borrowed from
JSCalendar's OffsetTrigger because it already means "an hour before the thing
I am attached to".

DECIDED, so it doesn't get re-litigated (2026-08-11):

- **Rules are stored objects**, not synthesised from their schedule. Times
  lists them as rows with their own reach, and a task may point at one
  directly, so they need identity.
- **Floating time by default** (`timeZone: null`): 09:00 wherever you are. The
  app already has one global timezone setting; a per-source zone would be a
  second, competing answer. Force a zone only when a real door disagrees.
- **Skips propagate downstream.** If Deep work is excluded on a Tuesday, a
  gate that follows it has no occurrence that day.

PURE: no SQL, no I/O, no state — same contract as recurrence.py, which stays
the app's only implementation of the DAY question. This module converts a
JSCalendar RecurrenceRule into the RRULE string recurrence.py already reads
and adds the half it has no opinion about: time of day, duration, unions and
transforms. `resolve(uid)` is the caller's lookup, which is what keeps the
store out of here.
"""

from datetime import date as date_cls, datetime, time as time_cls, timedelta
from calendar import monthrange
import re

import recurrence

KINDS = ('rule', 'schedule', 'derived')

# JSCalendar spells days lowercase; recurrence.py (RFC 5545) uppercase.
_DAYS = ('mo', 'tu', 'we', 'th', 'fr', 'sa', 'su')
_FREQ = {'daily': 'DAILY', 'weekly': 'WEEKLY', 'monthly': 'MONTHLY', 'yearly': 'YEARLY'}

# A count-bounded set has to be expanded from its own beginning to know where
# it stops. This caps that walk; 2000 occurrences is ~5 years of a daily rule.
MAX_EXPAND = 2000

# How far back a count-bounded or derived source is expanded from. Sources are
# floating and personal, not historical records.
_WALK_YEARS = 12


class Cycle(Exception):
    """A source that (transitively) contains or follows itself."""


# ── Durations ────────────────────────────────────────────────

_DUR_RE = re.compile(
    r'^(?P<sign>-)?P(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?)?$')


def parse_duration(text):
    """ISO 8601 duration → timedelta. None/'' → None (a moment, not a span)."""
    if not text:
        return None
    m = _DUR_RE.match(text.strip())
    if not m:
        return None
    parts = {k: int(v) for k, v in m.groupdict().items() if k != 'sign' and v}
    delta = timedelta(days=parts.get('d', 0), hours=parts.get('h', 0),
                      minutes=parts.get('m', 0), seconds=parts.get('s', 0))
    return -delta if m.group('sign') else delta


def format_duration(delta):
    """timedelta → ISO 8601. Always the T form, so PT0S is a zero span."""
    if delta is None:
        return None
    sign = '-' if delta.total_seconds() < 0 else ''
    total = int(abs(delta).total_seconds())
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, seconds = divmod(rest, 60)
    out = f'{sign}P'
    if days:
        out += f'{days}D'
    out += 'T'
    if hours:
        out += f'{hours}H'
    if minutes:
        out += f'{minutes}M'
    if seconds or (not hours and not minutes):
        out += f'{seconds}S'
    return out


def human_duration(delta):
    """A duration as the picker says it: "3 hr 30", "45 min", "2 days"."""
    if delta is None:
        return 'no duration'
    total = int(delta.total_seconds())
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    if days and not hours and not minutes:
        return f'{days} day' + ('' if days == 1 else 's')
    bits = []
    if days:
        bits.append(f'{days}d')
    if hours:
        bits.append(f'{hours} hr')
    if minutes:
        bits.append(f'{minutes}' if hours else f'{minutes} min')
    return ' '.join(bits) or '0 min'


# ── JSCalendar RecurrenceRule → RRULE ────────────────────────
#
# The picker stores named fields, never an RRULE string (see the Schedule Model
# mapping table). recurrence.py reads RRULE, so the conversion lives here — one
# direction only, because the stored object is the source of truth.

def rrule_string(rule):
    if not rule:
        return ''
    freq = _FREQ.get(str(rule.get('frequency', '')).lower())
    if not freq:
        return ''
    parts = [f'FREQ={freq}']
    interval = int(rule.get('interval') or 1)
    if interval > 1:
        parts.append(f'INTERVAL={interval}')
    by_day = rule.get('byDay') or []
    if by_day:
        toks = []
        for d in by_day:
            day = str(d.get('day', '')).lower()
            if day not in _DAYS:
                continue
            nth = d.get('nthOfPeriod')
            toks.append(f'{nth}{day.upper()}' if nth else day.upper())
        if toks:
            parts.append('BYDAY=' + ','.join(toks))
    if rule.get('byMonthDay'):
        parts.append('BYMONTHDAY=' + ','.join(str(int(x)) for x in rule['byMonthDay']))
    if rule.get('byMonth'):
        parts.append('BYMONTH=' + ','.join(str(int(x)) for x in rule['byMonth']))
    # Only meaningful above interval 1, which is also the only time the picker
    # shows the control.
    if interval > 1 and rule.get('firstDayOfWeek'):
        wkst = str(rule['firstDayOfWeek']).lower()
        if wkst in _DAYS:
            parts.append('WKST=' + wkst.upper())
    return ';'.join(parts)


def rules_from_rrule(text):
    """RRULE string → a JSCalendar `recurrenceRules` array. Used ONCE, by the
    migration that turns the old time presets into rule sources; the stored
    object is the source of truth afterwards, so nothing else should need to
    read an RRULE back."""
    parsed = recurrence.parse(text or '')
    if not parsed.get('FREQ'):
        # No rule meant "every day" for a time preset, and the window was the
        # gate. Say that explicitly rather than storing an empty pattern.
        return [{'@type': 'RecurrenceRule', 'frequency': 'daily'}]
    inverse = {v: k for k, v in _FREQ.items()}
    rule = {'@type': 'RecurrenceRule', 'frequency': inverse.get(parsed['FREQ'], 'weekly')}
    if parsed.get('INTERVAL', 1) > 1:
        rule['interval'] = parsed['INTERVAL']
    if parsed.get('BYDAY'):
        rule['byDay'] = [
            dict({'@type': 'NDay', 'day': _DAYS[weekday]},
                 **({'nthOfPeriod': ordinal} if ordinal else {}))
            for ordinal, weekday in parsed['BYDAY']]
    if parsed.get('BYMONTHDAY'):
        rule['byMonthDay'] = parsed['BYMONTHDAY']
    if parsed.get('BYMONTH'):
        rule['byMonth'] = parsed['BYMONTH']
    if parsed.get('WKST'):
        wkst = parsed['WKST'].lower()
        if wkst in _DAYS:
            rule['firstDayOfWeek'] = wkst
    return [rule]


def _first_rule(src):
    rules = src.get('recurrenceRules') or []
    return rules[0] if rules else None


# ── Days ─────────────────────────────────────────────────────

def _rule_days(src, start, end):
    """The DATES a rule lands on, inside [start, end]. recurrence.py answers
    this for everything RRULE can say; `skip: "backward"` is the one case it
    can't, because "the 31st, or the last day in months that have no 31st"
    is not one RRULE."""
    rule = _first_rule(src)
    if not rule:
        return []
    dtstart = _start_dt(src).date()
    if str(rule.get('skip', '')).lower() == 'backward' and rule.get('byMonthDay'):
        return _clamped_month_days(rule, dtstart, start, end)
    text = rrule_string(rule)
    if not text:
        return []
    return recurrence.between(text, dtstart, start, end)


def _clamped_month_days(rule, dtstart, start, end):
    """Monthly by-month-day with skip=backward: a month too short for the
    requested day uses its last day instead. ("omit" is RRULE's own default —
    the day simply doesn't exist — so it needs nothing here.)"""
    interval = max(1, int(rule.get('interval') or 1))
    wanted = sorted({int(d) for d in rule['byMonthDay'] if int(d) > 0})
    out = []
    months = (end.year - dtstart.year) * 12 + (end.month - dtstart.month)
    for n in range(0, months + 1, interval):
        y, m = divmod(dtstart.month - 1 + n, 12)
        y += dtstart.year
        m += 1
        last = monthrange(y, m)[1]
        for d in wanted:
            day = date_cls(y, m, min(d, last))
            if day >= dtstart and start <= day <= end:
                out.append(day)
    return sorted(set(out))


# ── Occurrences ──────────────────────────────────────────────

def _start_dt(src):
    raw = src.get('start')
    if not raw:
        return datetime.combine(date_cls.today(), time_cls(0, 0))
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return datetime.combine(date_cls.fromisoformat(raw[:10]), time_cls(0, 0))


def _as_date(d):
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, str):
        return date_cls.fromisoformat(d[:10])
    return d


def occurrences(src, resolve, start, end, _seen=None):
    """Intervals of `src` overlapping [start, end] (dates, inclusive).

    Returns a sorted list of (start_datetime, end_datetime) in floating local
    time. A source with no duration yields zero-length intervals — a moment,
    which is what a reminder or a scan point is.
    """
    if not src:
        return []
    start = _as_date(start)
    end = _as_date(end)
    seen = set(_seen or ())
    uid = src.get('uid')
    if uid:
        if uid in seen:
            raise Cycle(uid)
        seen.add(uid)

    kind = src.get('sf:kind') or src.get('kind') or 'rule'
    if kind == 'schedule':
        ivals = []
        for entry in src.get('entries') or []:
            member = resolve(entry)
            if member:
                ivals += occurrences(member, resolve, start, end, seen)
    elif kind == 'derived':
        ivals = _derived(src, resolve, start, end, seen)
    else:
        ivals = _rule_occurrences(src, resolve, start, end)

    # The count walk re-expands THIS source from its own beginning, so it must
    # not see its own uid in the guard set — that is the outer walk's marker,
    # not a cycle.
    ivals = _apply_ends(src, resolve, ivals, seen - ({uid} if uid else set()))
    return sorted(ivals)


def _rule_occurrences(src, resolve, start, end):
    base = _start_dt(src)
    dur = parse_duration(src.get('duration'))
    overrides = src.get('recurrenceOverrides') or {}
    out = []
    for day in _rule_days(src, start, end):
        s = datetime.combine(day, base.time())
        # Overrides are keyed by the ORIGINAL local start, which is what makes
        # "skip this one" survive an edit to the time of day.
        ov = overrides.get(s.isoformat())
        if ov is None:
            ov = overrides.get(s.isoformat(timespec='seconds'))
        this_dur = dur
        if ov:
            if ov.get('excluded'):
                continue
            if ov.get('start'):
                s = datetime.fromisoformat(ov['start'])
            if 'duration' in ov:
                this_dur = parse_duration(ov['duration'])
        out.append((s, s + this_dur if this_dur else s))
    return out


def _derived(src, resolve, start, end, seen):
    """One source shifted and cut. The window is widened before asking
    upstream: an occurrence that starts the day before can still land inside
    the range once the offset moves it."""
    follows = src.get('sf:follows') or src.get('follows') or {}
    target = resolve(follows.get('source'))
    if not target:
        return []
    offset = parse_duration(follows.get('offset')) or timedelta(0)
    pad = timedelta(days=abs(offset.days) + 2)
    base = occurrences(target, resolve, start - pad, end + pad, seen)

    only = follows.get('only') or {}
    only_days = {str(d).lower() for d in (only.get('byDay') or [])}

    extent = follows.get('extent') or 'until-source-start'
    relative_to = follows.get('relativeTo') or 'start'
    out = []
    for b_start, b_end in base:
        anchor = b_end if relative_to == 'end' else b_start
        s = anchor + offset
        if only_days and _DAYS[s.weekday()] not in only_days:
            continue
        if extent == 'until-source-start':
            e = b_start
        elif extent == 'until-source-end':
            e = b_end
        elif extent == 'same-as-source':
            e = s + (b_end - b_start)
        else:
            e = s + (parse_duration(extent) or timedelta(0))
        if e < s:
            e = s
        if start <= s.date() <= end or start <= e.date() <= end:
            out.append((s, e))
    return out


def _apply_ends(src, resolve, ivals, seen):
    """`sf:ends` is the SET's own ending — null, a date, or a count. Members
    carry none, which is why this is applied once, here, after the union."""
    ends = src.get('sf:ends') if 'sf:ends' in src else src.get('ends')
    if not ends:
        return ivals
    if ends.get('date'):
        last = _as_date(ends['date'])
        return [i for i in ivals if i[0].date() <= last]
    count = ends.get('count')
    if not count:
        return ivals
    cutoff = _nth_start(src, resolve, int(count), seen)
    if cutoff is None:
        return ivals
    return [i for i in ivals if i[0] <= cutoff]


def _nth_start(src, resolve, count, seen):
    """The start of the count-th occurrence, walked from the source's own
    beginning. Needed because "after 13 times" can only be answered by
    counting from the first one, not from the window being drawn."""
    if count < 1:
        return None
    origin = _origin_date(src, resolve, set(seen))
    if origin is None:
        return None
    # Ask for whole years at a time rather than one day at a time: a yearly
    # rule bounded at 13 needs 13 years of range before it can answer.
    span = timedelta(days=366)
    frm = origin
    found = []
    bare = dict(src)
    bare.pop('sf:ends', None)
    bare.pop('ends', None)
    for _ in range(_WALK_YEARS):
        found = occurrences(bare, resolve, origin, frm + span, set(seen))
        if len(found) >= count or len(found) >= MAX_EXPAND:
            break
        frm += span
    return found[count - 1][0] if len(found) >= count else None


def _origin_date(src, resolve, seen):
    """The earliest date this source could produce anything on."""
    uid = src.get('uid')
    if uid:
        if uid in seen:
            return None
        seen.add(uid)
    kind = src.get('sf:kind') or src.get('kind') or 'rule'
    if kind == 'schedule':
        dates = []
        for entry in src.get('entries') or []:
            member = resolve(entry)
            if member:
                d = _origin_date(member, resolve, seen)
                if d:
                    dates.append(d)
        return min(dates) if dates else None
    if kind == 'derived':
        follows = src.get('sf:follows') or src.get('follows') or {}
        target = resolve(follows.get('source'))
        return _origin_date(target, resolve, seen) if target else None
    return _start_dt(src).date()


def day_intervals(src, resolve, day):
    """The intervals covering one date, as wall-clock strings, clipped to it.

    This is the half a phone can answer for itself — "am I inside the window
    now" — so it is what the client is given instead of a rule. An occurrence
    that began yesterday appears as its tail (`from_previous`), because a
    window you are currently inside is exactly the case that matters.
    """
    day = _as_date(day)
    out = []
    for s, e in occurrences(src, resolve, day - timedelta(days=1), day):
        if s.date() > day or e.date() < day:
            continue
        # An occurrence that ended the instant this day began is yesterday's,
        # not a zero-length window at 00:00 today.
        if s.date() < day and e.date() == day and e.time() == time_cls(0, 0):
            continue
        out.append({
            'start': s.strftime('%H:%M') if s.date() == day else '00:00',
            'end': e.strftime('%H:%M') if e.date() == day else '24:00',
            'from_previous': s.date() < day,
            'into_next': e.date() > day,
        })
    return sorted(out, key=lambda i: i['start'])


def occurs_on(src, resolve, day):
    return bool(day_intervals(src, resolve, day))


# ── Description ──────────────────────────────────────────────
#
# The sentence at the foot of the picker, and the row's own subtitle in Times.
# It is the only feedback the picker gives, so it says the whole rule.

_DAY_NAMES = {'mo': 'Mon', 'tu': 'Tue', 'we': 'Wed', 'th': 'Thu',
              'fr': 'Fri', 'sa': 'Sat', 'su': 'Sun'}
_FREQ_NOUN = {'daily': 'day', 'weekly': 'week', 'monthly': 'month', 'yearly': 'year'}


def _ordinal(n):
    if n == -1:
        return 'last'
    return {1: '1st', 2: '2nd', 3: '3rd'}.get(n, f'{n}th')


def _day_phrase(by_day):
    names = []
    for d in by_day:
        day = str(d.get('day', '')).lower()
        if day not in _DAY_NAMES:
            continue
        nth = d.get('nthOfPeriod')
        names.append(f'{_ordinal(nth)} {_DAY_NAMES[day]}' if nth else _DAY_NAMES[day])
    if not names:
        return ''
    # Mon–Fri reads better than Mon, Tue, Wed, Thu, Fri, but only when the run
    # really is consecutive and unordinal.
    plain = [str(d.get('day', '')).lower() for d in by_day if not d.get('nthOfPeriod')]
    if len(plain) == len(names) >= 3:
        idx = sorted(_DAYS.index(d) for d in plain if d in _DAYS)
        if idx == list(range(idx[0], idx[-1] + 1)):
            return f'{_DAY_NAMES[_DAYS[idx[0]]]}–{_DAY_NAMES[_DAYS[idx[-1]]]}'
    return ', '.join(names)


def describe_rule(src):
    rule = _first_rule(src) or {}
    freq = str(rule.get('frequency', 'weekly')).lower()
    interval = max(1, int(rule.get('interval') or 1))
    bits = []
    day_part = _day_phrase(rule.get('byDay') or [])
    if rule.get('byMonthDay'):
        days = ', '.join(_ordinal(int(d)) for d in rule['byMonthDay'])
        day_part = f'the {days}'
    if interval > 1:
        every = f'every {interval} {_FREQ_NOUN.get(freq, freq)}s'
        bits.append(f'{day_part} {every}' if day_part else every)
    elif day_part:
        bits.append(day_part)
    else:
        bits.append({'daily': 'Every day', 'weekly': 'Every week',
                     'monthly': 'Every month', 'yearly': 'Every year'}.get(freq, freq))
    at = _start_dt(src).strftime('%H:%M')
    dur = parse_duration(src.get('duration'))
    bits.append(f'at {at}' + (f' for {human_duration(dur)}' if dur else ''))
    return ' '.join(bits)


def describe(src, resolve=None):
    """One sentence for any source. `resolve` is only needed to name what a
    derived source follows and to read a schedule's members."""
    if not src:
        return ''
    resolve = resolve or (lambda uid: None)
    kind = src.get('sf:kind') or src.get('kind') or 'rule'

    if kind == 'derived':
        follows = src.get('sf:follows') or src.get('follows') or {}
        target = resolve(follows.get('source'))
        name = (target or {}).get('title') or 'it'
        offset = parse_duration(follows.get('offset'))
        rel = 'ends' if (follows.get('relativeTo') == 'end') else 'starts'
        if not offset or not offset.total_seconds():
            when = f'When {name} {rel}'
        elif offset.total_seconds() < 0:
            when = f'{human_duration(-offset)} before {name} {rel}'
        else:
            when = f'{human_duration(offset)} after {name} {rel}'
        extent = follows.get('extent') or 'until-source-start'
        if extent == 'until-source-start':
            until = f'until {name} starts'
        elif extent == 'until-source-end':
            until = f'until {name} ends'
        elif extent == 'same-as-source':
            until = f'for as long as {name} runs'
        else:
            until = f'for {human_duration(parse_duration(extent))}'
        return f'{when}, {until}'

    if kind == 'schedule':
        members = [resolve(e) for e in (src.get('entries') or [])]
        members = [m for m in members if m]
        if not members:
            return 'no rules yet'
        head = describe_rule(members[0])
        if len(members) == 1:
            return _with_ends(head, src)
        rest = ', '.join(describe_rule(m) for m in members[1:])
        return _with_ends(f'{head}, except {rest}', src)

    return _with_ends(describe_rule(src), src)


def _with_ends(text, src):
    ends = src.get('sf:ends') if 'sf:ends' in src else src.get('ends')
    if not ends:
        return text
    if ends.get('date'):
        return f'{text}, until {ends["date"]}'
    if ends.get('count'):
        return f'{text}, {ends["count"]} times'
    return text


# ── Validation ───────────────────────────────────────────────

def check_acyclic(uid, src, resolve):
    """Raises Cycle if saving `src` as `uid` would close a loop. Called on
    save, which is the only place a reference can be created."""
    def walk(node, seen):
        if not node:
            return
        node_uid = node.get('uid')
        if node_uid:
            if node_uid in seen:
                raise Cycle(node_uid)
            seen = seen | {node_uid}
        kind = node.get('sf:kind') or node.get('kind') or 'rule'
        if kind == 'schedule':
            for entry in node.get('entries') or []:
                walk(resolve(entry), seen)
        elif kind == 'derived':
            follows = node.get('sf:follows') or node.get('follows') or {}
            walk(resolve(follows.get('source')), seen)

    walk(dict(src, uid=uid), set())
