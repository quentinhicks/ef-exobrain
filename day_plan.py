# A DAY'S PLAN, WRITTEN AS TEXT (2026-10-28, Quentin's design "Calendar
# Plan"). Pure: text in, blocks out, no db — storage.block_segments_for asks
# this and resolves names (area, location, colour) against the db, so every
# surface that draws a day draws the plan from that one answer.
#
#   8:55-9:10. Daily to-do list
#   9:10-9:40 COS333: Miscellaneous tasks
#   * Send task assignments email
#   3:30-4:45. COS333:
#     3:30-4:45. A3
#     4:45-5:30. Meeting with Angelina Ji
#   6:15-6:45. Eat dinner @ Quad
#
# One line per block: a time range, an optional CATEGORY before a colon (the
# area it is filed under), then its title. `@ place` names a location. A `*`
# line is a note written inside the block above it. An indented time line is a
# block NESTED in the one above, and the parent stretches to cover its
# children. Anything else is reported as skipped, never guessed at.
#
# Times are 12-hour without am/pm, so each is read as the first reading at or
# after the line before it: 8:55 then 9:10 then 1 (13:00) then 3:30 (15:30).
# An hour over 12 is already 24-hour. Minutes from the date's midnight; a plan
# may run past it (end up to 2880), the day_block convention.

import re

LINE_RE = re.compile(r'^(\s*)(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\.?\s*(.*)$')
NOTE_RE = re.compile(r'^\s*[*•]\s+(.+)$')
CAT_RE = re.compile(r'^([A-Za-z][\w&/+ -]{0,18}?):\s*(.*)$')
LOC_RE = re.compile(r'\s*@\s*(.+)$')

# Where the first line's reading starts: 6 means "8" is the morning, "1" is
# the afternoon.
FIRST_REF = 6 * 60


def _pick(h, m, after, strict):
    if h > 23 or m > 59:
        return None
    base = (h if h > 12 else h % 12) * 60 + m
    # 0 is only ever midnight: this one, opening the plan, else the next.
    if h == 0:
        if not strict and after <= FIRST_REF:
            return base
        return base if base > after else base + 1440
    cands = [base] if h > 12 else [base, base + 720, base + 1440]
    for c in cands:
        if (c > after) if strict else (c >= after):
            return c
    return cands[-1]


def _line(m, ref):
    s = _pick(int(m.group(2)), int(m.group(3) or 0), ref, False)
    if s is None:
        return None
    e = _pick(int(m.group(4)), int(m.group(5) or 0), s, True)
    if e is None or e <= s or s >= 1440 or e > 2880:
        return None
    rest, cat, loc = m.group(6).strip(), '', ''
    cm = CAT_RE.match(rest)
    if cm:
        cat, rest = cm.group(1).strip(), cm.group(2)
    lm = LOC_RE.search(rest)
    if lm:
        loc, rest = lm.group(1).strip(), rest[:lm.start()]
    return {'start': s, 'end': e, 'cat': cat, 'title': rest.strip(), 'loc': loc,
            'notes': [], 'kids': []}


def parse(text):
    items, skipped = [], []
    ref = FIRST_REF
    last = None          # the block a `*` note belongs to
    for n, raw in enumerate((text or '').split('\n'), 1):
        if not raw.strip():
            continue
        note = NOTE_RE.match(raw)
        if note and last is not None:
            last['notes'].append(note.group(1).strip())
            continue
        m = LINE_RE.match(raw)
        nested = bool(m and m.group(1)) and bool(items)
        parent = items[-1] if nested else None
        it = m and _line(m, (parent['kids'][-1]['start'] if parent['kids'] else parent['start'])
                         if parent else ref)
        if not it:
            skipped.append({'n': n, 'text': raw.strip()[:60]})
            continue
        if parent:
            it['cat'] = it['cat'] or parent['cat']
            parent['kids'].append(it)
        else:
            items.append(it)
            ref = it['start']
        last = it
    for it in items:
        if it['kids']:
            it['start'] = min([it['start']] + [k['start'] for k in it['kids']])
            it['end'] = max([it['end']] + [k['end'] for k in it['kids']])
    return {'items': items, 'skipped': skipped}


# What a block is called: its title, else its category, so `3:30-4:45 COS333:`
# reads COS333.
def label_of(it):
    return it['title'] or it['cat'] or 'Plan'
