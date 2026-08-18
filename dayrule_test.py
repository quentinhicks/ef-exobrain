"""Which day a write is filed under is a DECISION. Run: python dayrule_test.py

Same bargain as daybook_test's unclassified-table check, applied to the second
thing that kept going wrong silently.

A READ may default its date — "the day you didn't name is today" is a sensible
answer to a question. A WRITE may not, quietly: the fact being stored belongs
to a specific day, and `or date_cls.today()` answers that with the SERVER'S
WALL CLOCK, which is not the same as the day the surface was pinned to. That
gap is where the pawn stamped tomorrow's date and shortened the wrong gate,
where habit marks made after midnight landed on a day that had not started,
and where tag answers filed against a day the user was not answering about.

So every write route that defaults its date is listed here, with why. A new
one FAILS THIS TEST until someone adds it deliberately — which is the whole
point: the failure is the conversation.

The client-side half of the same rule is app.js's wallDay() / viewDay() /
runDay(), which exist so a call site shows which day it means.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Route -> why it is allowed to fall back to the server's today.
#
# "client sends it" means every caller now passes an explicit date and the
# default is only a fallback for a malformed request. Those are the ones that
# were actually wrong; they are kept rather than made strict so a stale tab
# fails soft instead of 400-ing mid-routine.
ALLOWED = {
    ('POST', '/api/engage/placements'):
        'placing something on a day you are looking at; the client sends the day',
    ('DELETE', '/api/engage/placements/<int:item_id>'):
        'unplacing from the day it is placed on',
    ('PUT', '/api/metrics/entry'):
        'client sends it — the runner passes its pinned run day',
    ('POST', '/api/social/specs'):
        'a plan is made for a day; the client sends it',
    ('POST', '/api/social/reps'):
        'a rep is logged when it happens — the clock IS the answer here',
    ('POST', '/api/habits/<int:id>/mark'):
        'client sends it — runDay(), so a mark after midnight files under the night',
    ('PUT', '/api/flows/<int:id>/run'):
        'client sends it — flowRunView.date, pinned when the runner opened',
    ('POST', '/api/tag-daily/answer'):
        'client sends it — an answer is a statement about a particular day',
    ('POST', '/api/people/night'):
        'client sends it — the routine states the night it is filling',

    # These do not file a fact under a day at all — they stamp a CREATION or
    # read a window forward from now. The clock is the honest answer.
    ('POST', '/api/habits'):
        'started_on: a habit begins the day you commit to it',
    ('POST', '/api/habit-experiments'):
        'started_on: same — an experiment begins when you start it',
    ('POST', '/api/blocks/export-ics'):
        'reads an 8-week window forward from now; writes a file, not a day',
    ('POST', '/api/accountability/nodes'):
        'the GET half of the same handler builds today\'s payload',
    ('POST', '/api/arrival'):
        'an arrival IS happening now — there is no earlier surface holding a '
        'pinned day, and the phone must not send one: a device in another zone '
        'would file under the wrong day, while the server\'s local date already '
        'follows the timezone lever. It files no dated fact either — the only '
        'writes are two status strings in `setting`',
}

WRITE_METHODS = ('POST', 'PUT', 'PATCH', 'DELETE')

# What "defaulting the day" looks like. Kept narrow on purpose: this is a
# tripwire, not a linter.
DEFAULTS = ('date_cls.today()', 'datetime.now().date()')

ROUTE_RE = re.compile(r"@app\.route\(\s*'([^']+)'(?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?")


def routes(src):
    """(methods, path, body) per route.

    The body is the HANDLER'S OWN function and nothing else. Slicing to the
    next decorator instead swallows the module-level helpers that sit between
    routes — _build_ics and _daily_backup both mention today, and reading them
    as part of a neighbouring route is how a tripwire earns a reputation for
    crying wolf.
    """
    lines = src.split('\n')
    out = []
    for i, line in enumerate(lines):
        m = ROUTE_RE.search(line)
        if not m:
            continue
        # Skip stacked decorators to the def, then take its indented block.
        j = i + 1
        while j < len(lines) and not lines[j].startswith('def '):
            if lines[j] and not lines[j].startswith(('@', ' ', '\t')):
                break                      # not a handler after all
            j += 1
        if j >= len(lines) or not lines[j].startswith('def '):
            continue
        k = j + 1
        while k < len(lines) and (not lines[k].strip()
                                  or lines[k].startswith((' ', '\t'))):
            k += 1
        methods = [x.strip().strip("'\"").upper()
                   for x in (m.group(2) or 'GET').split(',') if x.strip()]
        out.append((methods, m.group(1), '\n'.join(lines[j:k])))
    return out


def main():
    with open(os.path.join(HERE, 'app.py'), encoding='utf-8') as f:
        src = f.read()

    found, fails = set(), []
    for methods, path, body in routes(src):
        if not any(d in body for d in DEFAULTS):
            continue
        for method in methods:
            if method not in WRITE_METHODS:
                continue
            found.add((method, path))
            if (method, path) not in ALLOWED:
                fails.append(f'{method} {path}')

    for key in sorted(ALLOWED):
        if key not in found:
            print(f'STALE  {key[0]} {key[1]} — no longer defaults its date; '
                  f'drop it from ALLOWED')

    for key in sorted(found):
        if key in ALLOWED:
            print(f'PASS  {key[0]} {key[1]} — {ALLOWED[key]}')

    if fails:
        print('\n%d write route(s) default the day without saying why:'
              % len(fails))
        for f_ in fails:
            print('  FAIL  ' + f_)
        print('\nA write files a fact under a DAY. Send it explicitly from the '
              '\nsurface that knows which day it means (runDay() in a runner, '
              '\nthe viewed day on the timeline) — or add the route to ALLOWED '
              '\nabove with the reason the clock really is the right answer.')
        return 1

    print('\nAll write routes account for their day.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
