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
# CROSSED OUT (2026-10-29, Quentin's instruction): `~~ … ~~`, on one line or
# across several, crosses lines out. A crossed-out block draws nothing but
# still takes its hours, so what was under it — the week's blocks, one-offs,
# the events it overlaps — is hidden too; the hours read as cleared. Crossing
# out a block crosses out what is nested in it and its `*` notes. Struck words
# inside a line that is not crossed out are simply dropped from it. An unclosed
# `~~` is just text, as in markdown, so a half-typed one hides nothing.
#
# A GATE (2026-10-30, Quentin's instruction): `!` before the time,
# `!12-12:10 Photo of problems 1-4 written out`, makes the line a PHOTO GATE
# and NOT A BLOCK — it takes no hours, stretches no parent and covers no
# event; the app draws it as a gate, a dot at its window's close. Its range is
# the window photos are sent in, and what Claude judges them against is the
# gate's task: the line, its `*` notes and the block it sits in. It is the
# money path: qr_judge commits, judges and charges it. The line LOCKS the
# moment its window opens (`locked_change`): until then it is text like any
# other.
#
# Times are 12-hour without am/pm, so each is read as the first reading at or
# after the line before it: 8:55 then 9:10 then 1 (13:00) then 3:30 (15:30).
# An hour over 12 is already 24-hour. Minutes from the date's midnight; a plan
# may run past it (end up to 2880), the day_block convention.

import re

LINE_RE = re.compile(r'^(\s*)(!?)\s*(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\.?\s*(.*)$')
NOTE_RE = re.compile(r'^\s*[*•]\s+(.+)$')
CAT_RE = re.compile(r'^([A-Za-z][\w&/+ -]{0,18}?):\s*(.*)$')
LOC_RE = re.compile(r'\s*@\s*(.+)$')
STRIKE_RE = re.compile(r'~~(.+?)~~', re.S)

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
    s = _pick(int(m.group(3)), int(m.group(4) or 0), ref, False)
    if s is None:
        return None
    e = _pick(int(m.group(5)), int(m.group(6) or 0), s, True)
    if e is None or e <= s or s >= 1440 or e > 2880:
        return None
    rest, cat, loc = m.group(7).strip(), '', ''
    cm = CAT_RE.match(rest)
    if cm:
        cat, rest = cm.group(1).strip(), cm.group(2)
    lm = LOC_RE.search(rest)
    if lm:
        loc, rest = lm.group(1).strip(), rest[:lm.start()]
    return {'start': s, 'end': e, 'cat': cat, 'title': rest.strip(), 'loc': loc,
            'notes': [], 'kids': [], 'struck': False, 'gate': bool(m.group(2))}


# Each line as (text without its strike marks, crossed out?). A line is
# crossed out when everything on it lies inside a `~~ … ~~`; a line only
# partly struck keeps what is outside the marks.
def _lines(text):
    struck, marks = set(), set()
    for m in STRIKE_RE.finditer(text):
        struck.update(range(*m.span()))
        marks.update((m.start(), m.start() + 1, m.end() - 2, m.end() - 1))
    out, pos = [], 0
    for raw in text.split('\n'):
        cells = [(c, pos + j) for j, c in enumerate(raw)]
        pos += len(raw) + 1
        whole = any(c.strip() for c, _ in cells) and \
            all(i in struck or not c.strip() for c, i in cells)
        drop = marks if whole else struck
        out.append((''.join(c for c, i in cells if i not in drop), whole))
    return out


def parse(text):
    items, skipped = [], []
    ref = FIRST_REF
    last = None          # the block a `*` note belongs to
    for n, (raw, struck) in enumerate(_lines(text or ''), 1):
        if not raw.strip():
            continue
        note = NOTE_RE.match(raw)
        if note and last is not None:
            if not (struck or last['struck']):
                last['notes'].append(note.group(1).strip())
            continue
        m = LINE_RE.match(raw)
        nested = bool(m and m.group(1)) and bool(items)
        parent = items[-1] if nested else None
        it = m and _line(m, (parent['kids'][-1]['start'] if parent['kids'] else parent['start'])
                         if parent else ref)
        if not it:
            if not struck:
                skipped.append({'n': n, 'text': raw.strip()[:60]})
            continue
        it['struck'] = struck or bool(parent and parent['struck'])
        if parent:
            it['cat'] = it['cat'] or parent['cat']
            parent['kids'].append(it)
        else:
            items.append(it)
            ref = it['start']
        last = it
    # A parent stretches over the children it still draws; a crossed-out
    # parent over all of them, since it clears all of their hours. A gate is
    # no block, so it stretches nothing.
    for it in items:
        kids = [k for k in it['kids'] if not k['gate'] and (it['struck'] or not k['struck'])]
        if kids:
            it['start'] = min([it['start']] + [k['start'] for k in kids])
            it['end'] = max([it['end']] + [k['end'] for k in kids])
    return {'items': items, 'skipped': skipped}


# What a block is called: its title, else its category, so `3:30-4:45 COS333:`
# reads COS333.
def label_of(it):
    return it['title'] or it['cat'] or 'Plan'


# Every live gate line, nested ones included, keyed by its window (start, end)
# in minutes from the date's midnight — the key a gate is stored under, so two
# gates may not share a window. A crossed-out `!` line is no gate. Each comes
# with the text Claude judges against: the line, its notes and its block.
def gate_lines(text):
    out = {}
    for it in parse(text)['items']:
        for g, parent in [(it, None)] + [(k, it) for k in it['kids']]:
            if g['gate'] and not g['struck']:
                out[(g['start'], g['end'])] = {'title': label_of(g), 'task': _task(g, parent)}
    return out


def _task(g, parent):
    named = lambda it: ': '.join(x for x in (it['cat'], it['title']) if x) or 'Plan'
    lines = [named(g)] + ['- ' + n for n in g['notes']]
    if parent:
        lines.append('Inside the block: ' + named(parent))
        lines += ['- ' + n for n in parent['notes']]
    return '\n'.join(lines)


# THE LOCK: a gate line whose window has opened (start <= now_min, minutes
# from the date's midnight) may not be added, removed, crossed out, moved or
# reworded. Returns the first one a save would touch, or None. Comparing the
# PARSED lines, not the text, so editing any other line stays free — unless it
# changes how a locked line's times read, which moves that gate and is refused.
def locked_change(old, new, now_min):
    before, after = gate_lines(old), gate_lines(new)
    for key in sorted(set(before) | set(after)):
        if key[0] <= now_min and before.get(key) != after.get(key):
            return (before.get(key) or after.get(key))['title']
    return None
