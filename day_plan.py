# A DAY'S PLAN, WRITTEN AS TEXT (2026-10-28, Quentin's design "Calendar
# Plan"; 2026-11-20, "Calendar To-dos" 9a). Pure: text in, blocks out, no db
# — storage.block_segments_for asks this and resolves names (area, location,
# colour) against the db, so every surface that draws a day draws the plan
# from that one answer.
#
#   12:40-2. COS333: A4
#     * Finish Q3 [2b1]
#     * ~~Submit on Gradescope~~ [2b2]
#   7:30-9. CWR201: Library
#     7:30-7:40. Walk to Firestone
#     7:40-9. Find book, read
#       7:40-8:15. Find book
#   6:15-6:45. Eat dinner @ Quad
#   3:45-6. @ STOKES.
#
# One line per block: a time range, an optional CATEGORY before a colon (the
# area it is filed under), then its title. `@ place` after a title names a
# location. An indented time line is a block NESTED in the one above, to any
# depth, and a parent stretches to cover its children. Anything else is
# reported as skipped, never guessed at.
#
# A `*` LINE IS A TASK (2026-11-20, Quentin's design "Calendar To-dos"): a
# real to-do item, on the nearest time line above it, carrying the item's id
# in hex at its end (`[2b1]`, 1-5 digits). storage._plan_sync mints the id
# and keeps the item, its placement and this text agreeing; nothing here
# touches the db. `* ~~words~~ [id]` is a task crossed out — done. A `*` line
# under a `!` gate is the gate's description, never a task (see _owner_ok).
#
# A LINE THAT IS ONLY `@ PLACE.` IS A FRAME (2026-11-20, the same design): a
# place you have to be, drawn as an outline over that stretch of the day. It
# can stand anywhere in the plan; it is read as DAYTIME (from 07:00, not from
# the line before) and moves no later line's reading. It is not a block: it
# takes no hours. A `*` line under it is a task on it.
#
# CROSSED OUT (2026-10-29, Quentin's instruction): `~~ … ~~`, on one line or
# across several, crosses lines out. A crossed-out block draws nothing.
# Crossing out a block crosses out what is nested in it and its tasks. Struck
# words inside a line that is not crossed out are simply dropped from it. An
# unclosed `~~` is just text, as in markdown, so a half-typed one hides
# nothing.
#
# A GATE (2026-10-30, Quentin's instruction): `!` before the time,
# `!12-12:10 Photo of problems 1-4 written out`, makes the line a block AND a
# PHOTO GATE on that block — the block takes its hours like any other, and
# the gate, described by the block's name, is drawn as a gate's dot at the
# block's close. The block's range is the window photos are sent in, and
# what Claude judges them against is the gate's task: the block's name, its
# `*` lines and the block it sits in. It is the money path: qr_judge
# commits, judges and charges it. The line LOCKS the moment its window opens
# (`locked_change`): until then it is text like any other.
#
# Times are 12-hour without am/pm, so each is read as the first reading at or
# after the line before it: 8:55 then 9:10 then 1 (13:00) then 3:30 (15:30).
# An hour over 12 is already 24-hour. Minutes from the date's midnight; a plan
# may run past it (end up to 2880), the day_block convention.

import re

LINE_RE = re.compile(r'^(\s*)(!?)\s*(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\.?\s*(.*)$')
TASK_RE = re.compile(r'^(\s*)[*•]\s+(.*)$')
TASK_ID_RE = re.compile(r'\s*\[([0-9a-fA-F]{1,5})\]\s*$')
STRUCK_TASK_RE = re.compile(r'^\s*[*•]\s+~~(.+?)~~\s*(?:\[[0-9a-fA-F]{1,5}\]\s*)?$')
TASK_PARTS_RE = re.compile(r'^(\s*[*•]\s+)(.*?)(\s*\[[0-9a-fA-F]{1,5}\]\s*)?$')
FRAME_RE = re.compile(r'^@\s*(.+?)\.?\s*$')
CAT_RE = re.compile(r'^([A-Za-z][\w&/+ -]{0,18}?):\s*(.*)$')
LOC_RE = re.compile(r'\s*@\s*(.+)$')
STRIKE_RE = re.compile(r'~~(.+?)~~', re.S)

# Where the first line's reading starts: 6 means "8" is the morning, "1" is
# the afternoon. A frame is read from 07:00 whatever stands before it.
FIRST_REF = 6 * 60
FRAME_REF = 7 * 60


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


def _span(m, ref):
    s = _pick(int(m.group(3)), int(m.group(4) or 0), ref, False)
    if s is None:
        return None
    e = _pick(int(m.group(5)), int(m.group(6) or 0), s, True)
    if e is None or e <= s or s >= 1440 or e > 2880:
        return None
    return s, e


def _line(m, ref, n):
    span = _span(m, ref)
    if not span:
        return None
    rest, cat, loc = m.group(7).strip(), '', ''
    cm = CAT_RE.match(rest)
    if cm:
        cat, rest = cm.group(1).strip(), cm.group(2)
    lm = LOC_RE.search(rest)
    if lm:
        loc, rest = lm.group(1).strip(), rest[:lm.start()]
    return {'start': span[0], 'end': span[1], 'cat': cat, 'title': rest.strip(), 'loc': loc,
            'notes': [], 'tasks': [], 'kids': [], 'struck': False, 'gate': bool(m.group(2)),
            'line': n, 'indent': len(m.group(1).replace('\t', '  '))}


def _frame(m, n):
    fm = FRAME_RE.match(m.group(7).strip())
    span = fm and not m.group(2) and _span(m, FRAME_REF)
    if not span:
        return None
    return {'start': span[0], 'end': span[1], 'label': fm.group(1).strip(), 'tasks': [],
            'notes': [], 'kids': [], 'struck': False, 'gate': False, 'frame': True,
            'line': n, 'indent': len(m.group(1).replace('\t', '  '))}


# A `*` line as a task: its words (the id and any strike marks off), its id,
# and whether it is crossed out — the whole line inside `~~`, or its words.
def _task(clean, whole, orig, n):
    if not (TASK_RE.match(orig) or TASK_RE.match(clean)):
        return None
    sm = STRUCK_TASK_RE.match(orig)
    cm = TASK_RE.match(clean)
    body = sm.group(1) if sm else (cm.group(2) if cm else '')
    idm = TASK_ID_RE.search(orig) or TASK_ID_RE.search(clean)
    return {'text': TASK_ID_RE.sub('', body).strip(), 'id': int(idm.group(1), 16) if idm else None,
            'struck': bool(whole or sm), 'line': n}


# Each line as (text without its strike marks, crossed out?, as written). A
# line is crossed out when everything on it lies inside a `~~ … ~~`; a line
# only partly struck keeps what is outside the marks.
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
        out.append((''.join(c for c, i in cells if i not in drop), whole, raw))
    return out


def parse(text):
    items, frames, skipped = [], [], []
    ref = FIRST_REF
    last = None          # the block or frame a `*` line belongs to
    stack = []           # the blocks a deeper-indented line may nest in
    for n, (clean, struck, orig) in enumerate(_lines(text or ''), 1):
        if not clean.strip():
            continue
        task = (TASK_RE.match(orig) or (struck and TASK_RE.match(clean))) and _task(clean, struck, orig, n)
        if task and last is not None:
            if last['struck']:
                task['struck'] = True
            if task['text']:
                last['tasks'].append(task)
                if not task['struck']:
                    last['notes'].append(task['text'])
            continue
        m = LINE_RE.match(clean)
        fr = m and _frame(m, n)
        if fr:
            fr['struck'] = struck
            if not struck:
                frames.append(fr)
            last = fr
            continue
        ind = len(m.group(1).replace('\t', '  ')) if m else 0
        # The line it is read forward from: the one it follows at its own
        # depth, else the block it sits in, else the plan's last top line.
        prior = stack[-1][1]['start'] if m and ind and stack else ref
        while stack and stack[-1][0] >= ind:
            stack.pop()
        parent = stack[-1][1] if m and ind and stack else None
        it = m and _line(m, prior, n)
        if not it:
            if not struck:
                skipped.append({'n': n, 'text': clean.strip()[:60]})
            continue
        it['struck'] = struck or bool(parent and parent['struck'])
        if parent:
            it['cat'] = it['cat'] or parent['cat']
            parent['kids'].append(it)
        else:
            items.append(it)
            ref = it['start']
        stack.append((ind, it))
        last = it
    for it in items:
        _stretch(it)
    return {'items': items, 'frames': frames, 'skipped': skipped}


# A parent stretches over the children it still draws; a crossed-out parent
# over all of them, since it clears all of their hours. Deepest first.
def _stretch(it):
    for k in it['kids']:
        _stretch(k)
    kids = [k for k in it['kids'] if it['struck'] or not k['struck']]
    if kids:
        it['start'] = min([it['start']] + [k['start'] for k in kids])
        it['end'] = max([it['end']] + [k['end'] for k in kids])


# What a block is called: its title, else its category, so `3:30-4:45 COS333:`
# reads COS333.
def label_of(it):
    return it['title'] or it['cat'] or 'Plan'


# Every block at every depth, each with the block it sits in.
def walk(items, parent=None):
    for it in items:
        yield it, parent
        yield from walk(it['kids'], it)


# ── THE TASKS, AS LINES (2026-11-20) ──
# Every `*` line that is a task, with what it is on (`owner`: a block or a
# frame) and its 0-based index in text.split('\n'). A `*` line under a gate,
# or under a block nested in one, is the gate's description and not here.
def tasks_of(text):
    P = parse(text)
    out = []

    def add(owner, gated):
        if gated:
            return
        out.extend(dict(t, idx=t['line'] - 1, owner=owner) for t in owner['tasks'])

    def visit(it, gated):
        gated = gated or it['gate']
        add(it, gated)
        for k in it['kids']:
            visit(k, gated)

    for it in P['items']:
        visit(it, False)
    for f in P['frames']:
        add(f, False)
    return out, P


def hex_id(item_id):
    return format(int(item_id), 'x')


def task_line(indent, content, item_id, struck=False):
    words = f'~~{content}~~' if struck else content
    return f"{' ' * indent}* {words} [{hex_id(item_id)}]"


def with_id(line, item_id):
    return f'{line.rstrip()} [{hex_id(item_id)}]'


def strike_line(line):
    m = TASK_PARTS_RE.match(line)
    if not m or STRUCK_TASK_RE.match(line):
        return line
    return f'{m.group(1)}~~{m.group(2)}~~{m.group(3) or ""}'


def unstrike_line(line):
    m = TASK_PARTS_RE.match(line)
    if not m or not STRUCK_TASK_RE.match(line):
        return line
    body = m.group(2)
    if body.startswith('~~') and body.endswith('~~') and len(body) > 4:
        body = body[2:-2]
    return f'{m.group(1)}{body}{m.group(3) or ""}'


def rename_line(line, content):
    m = TASK_PARTS_RE.match(line)
    if not m:
        return line
    body = f'~~{content}~~' if STRUCK_TASK_RE.match(line) else content
    return f'{m.group(1)}{body}{m.group(3) or ""}'


# Where a new task on `owner` goes: under its last task, else under its line,
# one step further in than the line it is on.
def task_insert_at(lines, owner):
    after = owner['tasks'][-1]['line'] - 1 if owner['tasks'] else owner['line'] - 1
    return after, owner.get('indent', 0) + 2


# Every live gate line, nested ones included, keyed by its window (start, end)
# in minutes from the date's midnight — the key a gate is stored under, so two
# gates may not share a window. A crossed-out `!` line is no gate. Each comes
# with the text Claude judges against: the line, its notes and its block.
def gate_lines(text):
    out = {}
    for g, parent in walk(parse(text)['items']):
        if g['gate'] and not g['struck']:
            out[(g['start'], g['end'])] = {'title': label_of(g), 'task': _gate_task(g, parent)}
    return out


def _gate_task(g, parent):
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
