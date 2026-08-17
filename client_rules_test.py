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
]


def owning_function(lines, i):
    """The nearest preceding definition line, so a use inside its own
    accessor can be told from a use anywhere else."""
    for j in range(i, max(-1, i - 6), -1):
        line = lines[j].strip()
        if line.startswith('function ') or line.startswith('const DAY_MIN'):
            return line
    return ''


def main():
    with open(APP_JS, encoding='utf-8') as f:
        lines = f.read().split('\n')

    fails = []
    for n, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*'):
            continue                      # a comment may name what it bans
        for pattern, instead, allowed_in in BANNED:
            if not pattern.search(line):
                continue
            owner = owning_function(lines, n)
            if allowed_in in owner or allowed_in in line:
                continue
            fails.append((n + 1, stripped[:88], instead))

    if fails:
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
    return 0


if __name__ == '__main__':
    sys.exit(main())
