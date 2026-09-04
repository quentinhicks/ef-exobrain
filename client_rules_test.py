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
allowed by line and nowhere else.

NOT CHECKED, and worth saying plainly: "never order HH:MM strings" is a real
rule with no reliable pattern — a comparison of two variables that happen to
hold clock times looks like any other comparison. That one rests on review.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.join(HERE, 'static', 'app.js')

# pattern -> (what to use instead, the function allowed to contain it)
BANNED = [
    (re.compile(r'formatDateYMD\(new Date\(\)\)'),
     'wallDay() / viewDay() / runDay() — say WHICH day you mean',
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
]

# ── The day a RUN's work is filed under ──────────────────────
#
# Every endpoint here takes a DATE saying which day the fact belongs to, so a
# function naming one is answering "which day" — and inside the routine runner,
# or any surface the runner RAISES over itself, that answer is runDay(). The
# list is of ENDPOINTS, not of functions: nothing has to be remembered when a
# new caller appears, which is the same reason authority_test scans qr_judge
# instead of keeping a curated list.
DAY_FILING = [
    re.compile(r'/api/journal/'),
    re.compile(r'/api/metrics/entry'),
    re.compile(r'/api/habits/\$\{[^}]*\}/mark'),
    re.compile(r'/api/people/night'),
    re.compile(r'/api/people/\$\{[^}]*\}/interactions'),
    re.compile(r'/api/tag-daily/answer'),
    re.compile(r'/api/flows/\$\{[^}]*\}/run'),
]

# The one legitimate clock read in such a function, and why it is legitimate.
# WHICH day the run pins to has to be decided from the clock — that is exactly
# what flowRunDate answers (is yesterday's run still resumable?). Anything else
# reading the clock in a day-filing function is the bug above.
CLOCK_OK = [
    (re.compile(r'flowRunDate\('),
     "the pin itself is decided from the clock — flowRunDate asks whether "
     "yesterday's run is still resumable"),
]


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
    for registry in ('OBJECT_KINDS', 'SETTINGS_SHEETS'):
        m = re.search(r'const %s = \{(.*?)\n\};' % registry, body, re.S)
        if not m:
            out.append((0, 'const %s = {' % registry,
                        'the registry the object door reads has gone'))
            continue
        known = set(re.findall(r'^  ([a-z]+): \{', m.group(1), re.M))
        for kind in sorted(declared_kinds(body) - known):
            out.append((0, 'data-obj="%s:..."' % kind,
                        'add a `%s` entry to %s, or that door leads nowhere'
                        % (kind, registry)))
    return out


# ── A ROUTINE IS RUN TO THE END, WITHOUT LEAVING IT ──────────
#
# (2026-09-03, Quentin's instruction.) A step's own handlers may not close the
# run. Four of them did: both calendar passes, the clarify act and the mind
# sweep called closeFlowRun() and dropped you on the day screen with the
# routine gone — while its gate was still holding the day open — and the
# comment beside them said there was no way back. There is: openOverRunner
# raises the surface above #flow-run (165) and closing it lands you back on the
# step you left.
#
# Scoped to the STEP HANDLERS, not to the file: the runner still closes itself
# when the last step is credited, when the day it was pinned to settles, when
# there is nothing in it to run, and when you press ✕ or Esc. Those are the run
# ENDING. This bans the run being taken away mid-way by something a step asked
# you to do.
RUNNER_HANDLERS = 'function wireFlowStep('


def runner_eviction_fails(lines):
    start = next((i for i, l in enumerate(lines)
                  if l.startswith(RUNNER_HANDLERS)), None)
    if start is None:
        return [(0, RUNNER_HANDLERS, "the runner's step handlers have been "
                 'renamed — point this check at them again')]
    out = []
    for n in range(start + 1, len(lines)):
        line = lines[n]
        if re.match(r'^(async )?function ', line):
            break
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*'):
            continue
        if 'closeFlowRun' in line:
            out.append((n + 1, stripped[:88],
                        'openOverRunner(close, back) — a step may raise a '
                        'surface OVER the run, never in place of it'))
    return out


# ── A STEP'S CONTROL MUST BE ADDRESSED THE WAY IT IS WRITTEN ──
#
# (2026-09-03.) When the runner became a scroll every step's inputs became
# mounted at once, so `wireFlowStep` addresses each control by CLASS, scoped to
# its own section — an id could not stay unique across two steps of the same
# kind. The markup was left emitting ids. Eleven controls therefore matched
# nothing and did nothing: the CRM opener, the plan opener, the hours box, the
# experiment's start/keep/end/edit, the clarify act and the mind sweep. A dead
# button is the worst kind of missing feature, because it looks present.
#
# So: every class `wireFlowStep` asks for must exist as a class in the markup.
# Scanned, not curated — a control added tomorrow is covered the day it is
# written.
STEP_SELECTOR = re.compile(r"""sec\.querySelector(?:All)?\('\.([a-zA-Z-]+)'""")


def step_control_fails(body):
    out = []
    for cls in sorted(set(STEP_SELECTOR.findall(body))):
        if re.search(r'class="[^"]*(?<![\w-])%s(?![\w-])' % re.escape(cls), body):
            continue
        why = 'no markup carries class="%s"' % cls
        if 'id="%s"' % cls in body:
            why = 'the markup gives it an id="%s" instead — a step control is '                   'addressed by CLASS, because two steps of one kind mount at once' % cls
        out.append((0, ".%s" % cls, why))
    return out


def main():
    with open(APP_JS, encoding='utf-8') as f:
        body = f.read()
    lines = body.split(chr(10))
    with open(APP_JS, encoding='utf-8') as f:
        lines = f.read().split('\n')

    fails = object_door_fails(body)
    fails += runner_eviction_fails(lines)
    fails += step_control_fails(body)
    for n, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*'):
            continue                      # a comment may name what it bans
        for pattern, instead, allowed_in in BANNED:
            if not pattern.search(line):
                continue
            owner = owning_function(lines, n)
            # None: there is no legitimate use anywhere, so nothing is exempt.
            if allowed_in is not None and (allowed_in in owner or allowed_in in line):
                continue
            fails.append((n + 1, stripped[:88], instead))

    dated = day_filing_functions(lines)
    for name, start, end in dated:
        for n in range(start, end + 1):
            stripped = lines[n].strip()
            if stripped.startswith('//') or stripped.startswith('*'):
                continue
            if 'wallDay(' not in lines[n]:
                continue
            if any(p.search(lines[n]) for p, _why in CLOCK_OK):
                continue
            fails.append((n + 1, stripped[:88],
                          'runDay() — %s() files a dated fact, so its day is '
                          'the run that work belongs to' % name))

    if fails:
        fails.sort()
        print('%d use(s) of a banned pattern in static/app.js:\n' % len(fails))
        for lineno, text, instead in fails:
            print(f'  app.js:{lineno}')
            print(f'    {text}')
            print(f'    use: {instead}\n')
        print("""These are not style preferences — each one is the literal text of a bug that
shipped. See CLAUDE.md, "USE THE ABSTRACTIONS": a parallel implementation is a
bug even while it agrees, because agreeing is what it does right up until
midnight, a paused row, or a config change.""")
        return 1

    print('app.js uses the accessors.')
    print('  which day     wallDay / viewDay / runDay')
    print('  past midnight spanEndMin / windowEndMin / clockHHMM / DAY_MIN')
    print("  a run's day   %d function(s) file a dated fact, none from the clock"
          % len(dated))
    print('  money path    no gate is hidden through the view-dismissal store')
    print('  object door   %d kind(s) declared, all of them editable'
          % len(declared_kinds(body)))
    print("  the runner    no step handler closes the run you are sitting in")
    print('  step controls %d selector(s) in wireFlowStep, all of them live'
          % len(set(STEP_SELECTOR.findall(body))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
