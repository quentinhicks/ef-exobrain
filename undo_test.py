"""A gesture that WRITES ships its inverse. Run: python undo_test.py

Seventh tripwire, and the one that closes the hole the other six left open:
the undo rule was written for buttons — "register pushUndo(label, inverse) in
the same handler that mutates, or it isn't finished" — and the timeline's
gestures do not look like buttons, so three of them never did.

They are buttons. A drop is a commit, and on a surface where the input is a
five-pixel movement of a finger, the mis-drop is the LIKELIEST mistake, not
the least: dragging a gate wrote a day's window on the real-money path with no
way back, and dragging a block rewrote that day's hours the same way. Both
were found by using the app, which is the expensive way to find them.

So: every onPointerDrag site that reaches a mutating call must also reach a
pushUndo (directly, or through one of the undoable* helpers). A new drag that
writes FAILS this test until someone either gives it an inverse or says here,
in words, why it does not have one — the same bargain daybook_test strikes
with a new table.

What this deliberately does NOT check: every mutating call in app.js. Two
hundred of them are Settings fields, config surfaces and toggles that CLAUDE.md
already excludes from undo by name, and a test whose allowlist is longer than
its findings is a test nobody reads. The gestures are where the accidents are.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.join(HERE, 'static', 'app.js')

# A drag whose enclosing function writes nothing, or writes something that is
# not a fact about the user's data. Each needs a REASON, not just a name.
ALLOWED = {
    'onPointerDrag':
        'the helper itself — the definition, not a use of it',
}

MUTATING = re.compile(r"""apiSend\([^;]*?['"](POST|PATCH|PUT|DELETE)['"]""", re.S)
UNDO = re.compile(r'pushUndo\(|undoable[A-Z]\w*\(')
# Top-level function definitions: this file declares every one at column 0.
FUNC = re.compile(r'^(?:async\s+)?function\s+(\w+)', re.M)


def enclosing_functions(src):
    """(name, start, end) for every top-level function, in file order."""
    marks = [(m.group(1), m.start()) for m in FUNC.finditer(src)]
    out = []
    for i, (name, start) in enumerate(marks):
        end = marks[i + 1][1] if i + 1 < len(marks) else len(src)
        out.append((name, start, end))
    return out


def drag_block(src, pos):
    """The text of one onPointerDrag(...) call, by balanced parens.

    Scoped to the CALL, never to the function containing it: renderQrLayer is
    900 lines holding a drag, a hide and a tap, and pooling their text let one
    handler's undo vouch for another's write — which is how the first version
    of this test passed while the gate drag had no inverse at all.
    """
    i = src.index('(', pos)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == '(':
            depth += 1
        elif src[j] == ')':
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
    return src[i:]


def called_names(block):
    return set(re.findall(r'\b(\w+)\s*\(', block))


def writes(text):
    return bool(MUTATING.search(text))


def undoes(text):
    return bool(UNDO.search(text))


def main():
    src = open(APP_JS, encoding='utf-8').read()
    funcs = enclosing_functions(src)
    by_name = {n: src[a:b] for n, a, b in funcs}
    sites = [m.start() for m in re.finditer(r'onPointerDrag\(', src)]
    if not sites:
        print('FAIL  no onPointerDrag sites found — has the drag helper been renamed?')
        return 1

    failures = []
    checked = 0
    for pos in sites:
        owner = next((f for f in funcs if f[1] <= pos < f[2]), None)
        name = owner[0] if owner else '(top level)'
        if name in ALLOWED:
            continue
        checked += 1
        block = drag_block(src, pos)

        # A write IN THE DROP owes an inverse IN THE DROP. Not in a sibling
        # handler of the same function: renderQrLayer holds a drag, a hide and
        # a tap, and pooling their text let the hide's undo vouch for the
        # drag's write — which is how the gate drag went a day with no way
        # back while a first version of this test passed.
        if writes(block) and not undoes(block):
            failures.append((name, 'the drop writes, but registers no inverse'))
            continue

        # A drop that hands the write to a helper is fine either way round:
        # the inverse may live in the drop (saveReviewPhaseOrder, called again
        # in reverse) or in the helper itself (moveEvent, writeGateLine). What
        # is not fine is neither.
        for callee in sorted(by_name):
            if callee == name or not re.search(r'\b%s\s*\(' % re.escape(callee), block):
                continue
            if writes(by_name[callee]) and not undoes(by_name[callee]) and not undoes(block):
                failures.append((f'{name} -> {callee}()',
                                 'the write is here and the inverse is nowhere'))

    for where, why in failures:
        print(f'FAIL  {where}: {why}')
    if failures:
        print()
        print('Give the write an inverse (undoableGateWindow / undoableBlockOverride /')
        print('undoablePatch / pushUndo), or add the drag to ALLOWED with the reason.')
        return 1

    print(f'Every writing drag ships its inverse ({checked} checked, '
          f'{len(ALLOWED)} allowed by name).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
