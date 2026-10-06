"""The client uses the abstractions. Run: python client_rules_test.py

Sixth tripwire, and the one that makes CLAUDE.md's "USE THE ABSTRACTIONS"
section a rule rather than a hope. The others check the server; app.js is
where most of these bugs actually lived.

Each banned pattern below is not a style preference — it is the literal text
of a bug that shipped:

  formatDateYMD(new Date())     answered "which day" with the wall clock in
                                places that meant the PINNED run day. Four
                                bugs, one of them moving a real-money gate
                                deadline onto the wrong day.
  formatDateYMD(state.currentDate)
                                the same question answered with the VIEWED
                                day, which is browsable to next Tuesday.
  a bare 1440                   27 of them, each re-deciding the midnight
                                wrap by hand. Three bugs, including a block
                                calendar that compared '23:00' < '01:00' as
                                strings and so was never active overnight.
  wallDay() where a dated fact
  is written                    the same question answered with the CLOCK in
                                a function whose subject is a RUN. A nightly
                                routine finished at 02:00 recorded its CRM
                                fill under the NEW day, so the step that
                                opened the fill went on saying it was
                                unfilled, and the night's entries landed on a
                                day that had not happened yet. Scanned, not
                                curated: a function counts because it names
                                one of the dated endpoints, so a new caller
                                is covered the day it is written.

The accessors' own definitions are the one legitimate use of each, so they are
allowed by line and nowhere else. They live in static/common.js since
2026-10-05, shared by every document — so the day and wrap bans scan EVERY
client script (SCANNED), not app.js alone: a rule that one file obeys can be
dodged by writing the same line in the next file, and the NOW panel had done
exactly that with its own `d += 1440`.

NOT CHECKED, and worth saying plainly: "never order HH:MM strings" is a real
rule with no reliable pattern — a comparison of two variables that happen to
hold clock times looks like any other comparison. That one rests on review.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.join(HERE, 'static', 'app.js')
# Every client script the banned patterns apply to. common.js holds the
# accessors themselves; the rest are the documents that ask them.
SCANNED = ['common.js', 'app.js', 'gates.js', 'panel.js', 'inbox.js']

# pattern -> (what to use instead, the function allowed to contain it)
BANNED = [
    (re.compile(r'formatDateYMD\(new Date\(\)\)'),
     'wallDay() / viewDay() — say WHICH day you mean',
     'function wallDay()'),
    (re.compile(r'formatDateYMD\(state\.currentDate\)'),
     'viewDay()',
     'function viewDay()'),
    (re.compile(r'(?<![\w.])1440(?![\w])'),
     'DAY_MIN, or spanEndMin / windowEndMin / clockHHMM',
     'const DAY_MIN = 1440;'),
    # THE VIEW STORE MAY NOT SWALLOW A MONEY-PATH OBJECT. hideTimelineItem
    # files a timeline_dismissal row — a view preference the judge has no
    # reason to read, and the right answer for a block or a fetched event,
    # neither of which can cost anything. A GATE went through it too, so
    # right-clicking one made the pill vanish for good while qr_judge charged
    # the day exactly as before: the calendar said the gate was gone and the
    # money said it was not. Calling a gate's day off is a real write now
    # (setGateSkip -> qr_override.skipped -> applies_on), and this bans the
    # literal text of the bug. A future surface that wants to hide a gate owes
    # the same question: does the judge see it?
    (re.compile(r"""hideTimelineItem\(\s*['"]qr['"]"""),
     "setGateSkip() — a gate's day is a fact the judge has to see, not a view "
     'preference',
     None),
    # ONE WEEK (2026-10-05). Eight weekday tables had grown — three
    # Monday-first, one Sunday-first, two of them spelling Thursday and Sunday
    # 'T' and 'S' so the app's MTWRFSU grammar was lost at exactly the places
    # a day key has one letter. common.js's WEEKDAYS is the one; its rows are
    # objects, so its own text never matches. getDay() is Sunday-first, and
    # the one translation into the grammar is jsDateToDayOfWeek.
    (re.compile(r"""['"](?:Sun|Mon|SUN|MON|M|MO)['"]\s*,\s*['"](?:Mon|Tue|MON|TUE|T|TU)['"]"""),
     'WEEKDAYS (common.js) — name / long / letter / rrule / nday',
     None),
    (re.compile(r'\.getDay\(\)'),
     'jsDateToDayOfWeek() / weekdayOf() — Monday-first, the app\'s grammar',
     'function jsDateToDayOfWeek('),
]

# ── The day a RUN's work is filed under ──────────────────────
#
# Every endpoint here takes a DATE saying which day the fact belongs to, so a
# function naming one is answering "which day" — and that answer is the day the
# SURFACE is about, sent explicitly, never the clock. (It was runDay(), the
# routine runner's pinned day, until the runner went on 2026-10-05.) The list
# is of ENDPOINTS, not of functions: nothing has to be remembered when a new
# caller appears, which is the same reason authority_test scans qr_judge
# instead of keeping a curated list.
DAY_FILING = [
    re.compile(r'/api/journal/'),
    re.compile(r'/api/metrics/entry'),
    re.compile(r'/api/habits/\$\{[^}]*\}/mark'),
    re.compile(r'/api/people/night'),
    re.compile(r'/api/people/\$\{[^}]*\}/interactions'),
    re.compile(r'/api/tag-daily/answer'),
]

# The legitimate clock reads in such a function, each with why. Empty since
# the runner went (2026-10-05): flowRunDate, which decided from the clock which
# day a run pinned to, was the only one.
CLOCK_OK = []


def owning_function(lines, i):
    """The nearest preceding definition line, so a use inside its own
    accessor can be told from a use anywhere else."""
    for j in range(i, max(-1, i - 6), -1):
        line = lines[j].strip()
        if line.startswith('function ') or line.startswith('const DAY_MIN'):
            return line
    return ''


def day_filing_functions(lines):
    """(name, start, end) for every top-level function whose body names one of
    the dated endpoints. Top-level functions close on a lone `}` in column 1 —
    all 400-odd of them are written that way."""
    out = []
    start, name = None, ''
    for n, line in enumerate(lines):
        m = re.match(r'(?:async )?function (\w+)', line)
        if m:
            start, name = n, m.group(1)
            continue
        if line == '}' and start is not None:
            body = '\n'.join(lines[start:n + 1])
            if any(p.search(body) for p in DAY_FILING):
                out.append((name, start, n))
            start = None
    return out


# -- THE OBJECT DOOR ------------------------------------------
#
# A drawn artifact declares itself `data-obj="kind:id"` and one delegated
# handler opens that kind's settings sheet. Nothing else wires it, which is the
# point - and also the risk: a mistyped or invented kind is a door that leads
# nowhere, on a surface nobody thinks to re-test. So every kind DECLARED in the
# markup must have both halves, and this is a SCAN rather than a list, so a
# door written next week is covered the day it is written.
OBJ_DECL = re.compile(r'data-obj="([a-z]+):')
OBJ_DECL_JS = re.compile(r'dataset\.obj = `([a-z]+):')


def declared_kinds(body):
    # Comments are skipped here for the same reason the banned-pattern loop
    # skips them: the doc comment above OBJECT_KINDS spells the attribute out
    # as `data-obj="kind:id"` to explain it, and a checker that reads prose as
    # code fails on its own documentation.
    code = chr(10).join(l for l in body.split(chr(10))
                        if not l.strip().startswith(('//', '*')))
    return set(OBJ_DECL.findall(code)) | set(OBJ_DECL_JS.findall(code))


def object_door_fails(body):
    out = []
    # A kind whose OBJECT_KINDS entry carries its own `opens:` needs no sheet:
    # its editor is another page, and `opens` is where the door leads
    # (2026-09-29: a gate is edited on /gates, the one editor, so it has no
    # SETTINGS_SHEETS entry on purpose — a second one is how they drift).
    # Declaring `opens` is still a door, so the kind still owes OBJECT_KINDS.
    ok = re.search(r'const OBJECT_KINDS = \{(.*?)\n\};', body, re.S)
    opens = set()
    if ok:
        for chunk in re.split(r'\n(?=  [a-z]+: \{)', ok.group(1)):
            head = re.match(r'\s*([a-z]+): \{', chunk)
            if head and re.search(r'\bopens:', chunk):
                opens.add(head.group(1))
    for registry in ('OBJECT_KINDS', 'SETTINGS_SHEETS'):
        m = re.search(r'const %s = \{(.*?)\n\};' % registry, body, re.S)
        if not m:
            out.append((0, 'const %s = {' % registry,
                        'the registry the object door reads has gone'))
            continue
        known = set(re.findall(r'^  ([a-z]+): \{', m.group(1), re.M))
        if registry == 'SETTINGS_SHEETS':
            known |= opens
        for kind in sorted(declared_kinds(body) - known):
            out.append((0, 'data-obj="%s:..."' % kind,
                        'add a `%s` entry to %s, or that door leads nowhere'
                        % (kind, registry)))
    return out


# (Two checks on the routine RUNNER lived here: no step handler may close the
# run, and every class wireFlowStep asks for must exist in the markup. Both
# went with the runner on 2026-10-05.)


# ONE COPY, ONE REFRESH (2026-09-23). A block added in Settings did not
# appear: the list was handed a FETCHED copy while it drew from state.blocks,
# which nothing had updated, and the day refreshed only when Settings closed.
# Two halves, both scanned. A renderer of a dataset that lives in state takes
# NO argument, so there is no second copy to pass it; and the two doors every
# sheet write goes through call the one refresh.
STATE_RENDERERS = ('renderBeAreas', 'renderBeDomains', 'renderBeBlocks',
                   'renderBeCalendars')
SETTINGS_DOORS = ('async function submitSeSheet()', 'async function removeSeItem()')


def settings_refresh_fails(lines):
    fails = []
    for n, line in enumerate(lines):
        for name in STATE_RENDERERS:
            m = re.search(r'\b%s\(([^)]*)\)' % name, line)
            if m and m.group(1).strip():
                fails.append((n + 1, line.strip()[:88],
                              '%s() — it reads state; refresh state instead '
                              '(reloadSettingsState)' % name))
    for door in SETTINGS_DOORS:
        start = next((i for i, l in enumerate(lines) if l.startswith(door)), None)
        if start is None:
            fails.append((0, door, 'the settings write door is missing'))
            continue
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith('}'))
        if not any('refreshAfterSettingsWrite()' in l for l in lines[start:end]):
            fails.append((start + 1, door,
                          'await refreshAfterSettingsWrite() after the write lands'))
    return fails


# A DOCKED SURFACE CARRIES ONE CLASS (2026-10-05, Quentin: the sheets and
# dangerous writing "overlay over the page instead of expanding the existing
# page"). Docking was a list of ids in style.css that moved each box to the
# right edge and told the page nothing, so every one covered the page's right
# column. `.dock-panel` now both places a panel and makes the page give up its
# width (style.css, the NO POPUPS block) — so a sheet or read-out without it
# would float over the page again. Scanned: every *-sheet / *-pop / *-session
# element in the shell.
INDEX_HTML = os.path.join(HERE, 'templates', 'index.html')
DOCKED = re.compile(r'<[a-z]+ id="([a-z-]+-(?:sheet|pop|session))"([^>]*)>')


def dock_panel_fails():
    with open(INDEX_HTML, encoding='utf-8') as f:
        html = f.read()
    return [(0, '#' + i, 'class="dock-panel" — a docked surface makes the page '
                         'give up its width; without it, it covers the page')
            for i, rest in DOCKED.findall(html)
            if not re.search(r'class="[^"]*(?<![\w-])dock-panel(?![\w-])', rest)]


# ONE SHEET LIFECYCLE (2026-10-05). Eight sheets each hand-wired their own
# backdrop and Esc rung; three re-wired the backdrop on every repaint, and the
# schedule picker had neither, so Esc closed the sheet UNDER it. A sheet is
# now `.sheet` in the shell and `defineSheet('<id>', …)` in app.js, which
# wires its `#<id>-backdrop` once and ranks its rung. Scanned, not listed: a
# sheet added to index.html without a definition would have no tap-off and no
# place on the ladder, which is the bug this replaced.
SHEET_EL = re.compile(r'<[a-z]+ id="([a-z-]+)"\s+class="([^"]*)"')


def sheet_registry_fails(body):
    with open(INDEX_HTML, encoding='utf-8') as f:
        html = f.read()
    ids = {i for i, cls in SHEET_EL.findall(html) if 'sheet' in cls.split()}
    backs = {i for i, cls in SHEET_EL.findall(html) if 'sheet-backdrop' in cls.split()}
    defined = set(re.findall(r"defineSheet\('([a-z-]+)'", body))
    out = []
    for i in sorted(ids - defined):
        out.append((0, '#' + i, "defineSheet('%s', {rank, isOpen, close}) — or it "
                                'has no tap-off and no Esc rung' % i))
    for i in sorted(ids):
        if i + '-backdrop' not in backs:
            out.append((0, '#' + i, '<div id="%s-backdrop" class="sheet-backdrop '
                                    'hidden"> — defineSheet wires it' % i))
    for i in sorted(defined - ids):
        out.append((0, "defineSheet('%s'" % i, 'no .sheet element with that id '
                                               'in index.html'))
    return out, len(ids)


def main():
    with open(APP_JS, encoding='utf-8') as f:
        body = f.read()
    lines = body.split(chr(10))
    with open(APP_JS, encoding='utf-8') as f:
        lines = f.read().split('\n')

    fails = [('app.js',) + f for f in object_door_fails(body)]
    fails += [('app.js',) + f for f in settings_refresh_fails(lines)]
    fails += [('app.js',) + f for f in dock_panel_fails()]
    sheet_fails, n_sheets = sheet_registry_fails(body)
    fails += [('app.js',) + f for f in sheet_fails]
    dated = []
    for fname in SCANNED:
        path = os.path.join(HERE, 'static', fname)
        if not os.path.exists(path):
            fails.append((fname, 0, 'missing', 'the script this test scans'))
            continue
        with open(path, encoding='utf-8') as f:
            flines = f.read().split('\n')
        for n, line in enumerate(flines):
            stripped = line.strip()
            if stripped.startswith('//') or stripped.startswith('*'):
                continue                      # a comment may name what it bans
            for pattern, instead, allowed_in in BANNED:
                if not pattern.search(line):
                    continue
                owner = owning_function(flines, n)
                # None: there is no legitimate use anywhere, so nothing is exempt.
                if allowed_in is not None and (allowed_in in owner or allowed_in in line):
                    continue
                fails.append((fname, n + 1, stripped[:88], instead))

        fdated = day_filing_functions(flines)
        dated += fdated
        for name, start, end in fdated:
            for n in range(start, end + 1):
                stripped = flines[n].strip()
                if stripped.startswith('//') or stripped.startswith('*'):
                    continue
                if 'wallDay(' not in flines[n]:
                    continue
                if any(p.search(flines[n]) for p, _why in CLOCK_OK):
                    continue
                fails.append((fname, n + 1, stripped[:88],
                              'the surface\'s own day — %s() files a dated fact, so '
                              'it sends the day it is about, never the clock' % name))

    if fails:
        fails.sort()
        print('%d use(s) of a banned pattern in static/:\n' % len(fails))
        for fname, lineno, text, instead in fails:
            print(f'  {fname}:{lineno}')
            print(f'    {text}')
            print(f'    use: {instead}\n')
        print("""These are not style preferences — each one is the literal text of a bug that
shipped. See CLAUDE.md, "USE THE ABSTRACTIONS": a parallel implementation is a
bug even while it agrees, because agreeing is what it does right up until
midnight, a paused row, or a config change.""")
        return 1

    print('%s use the accessors.' % ', '.join(SCANNED))
    print('  which day     wallDay / viewDay')
    print('  past midnight spanEndMin / windowEndMin / clockHHMM / DAY_MIN')
    print('  which weekday WEEKDAYS / jsDateToDayOfWeek / weekdayOf')
    print('  a dated write %d function(s) file a dated fact, none from the clock'
          % len(dated))
    print('  money path    no gate is hidden through the view-dismissal store')
    print('  object door   %d kind(s) declared, all of them editable'
          % len(declared_kinds(body)))
    print('  settings      %d list(s) read state, both write doors refresh'
          % len(STATE_RENDERERS))
    print('  docked panels %d in the shell, each one makes the page give up its width'
          % len(DOCKED.findall(open(INDEX_HTML, encoding='utf-8').read())))
    print('  sheets        %d in the shell, each defined once (tap-off + Esc rung)'
          % n_sheets)
    return 0


if __name__ == '__main__':
    sys.exit(main())
