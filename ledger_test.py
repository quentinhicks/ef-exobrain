"""A ledger declares how it is kept honest. Run: python ledger_test.py

Fourth tripwire, same bargain as the others.

A LEDGER here is a table that MEMOIZES a projection: a row saying "this
already happened for that day", written so the thing it produced can be
finished, edited or deleted without the projection running again. That is a
genuinely good pattern — occasion_mint outliving the item it minted is the
only reason completing a minted action does not re-mint it forever.

It has two failure modes, and every ledger in this codebase has had both:

  1. NOTHING RECONCILES IT when the source moves. occasion_mint's own comment
     promised "an event that moved to another day takes its actions with it".
     It did not, for months: the old day kept orphaned actions and the new day
     minted a SECOND set. A comment is not a mechanism.
  2. NOTHING CLEARS IT when its owner is deleted. delete_flow left
     flow_task_seed rows and pawn_to_flow_id pointers behind.

So each ledger names three things, and each named function has to exist. A
ledger with no reconcile must say WHY — "frozen on purpose" is a real answer
and qr_charge_log gives it — rather than leaving the question unasked.

Candidates are found by NAME (_mint, _seed, _log, …), which is a heuristic and
not a proof: a ledger called something else will not be caught. The other
classifications here are exact, and this one is the honest weak spot.

Companions: resolution_test (what a rule MEANS on a day), dayrule_test (which
day a WRITE files under), daybook_test (which day a row is HISTORY for).
"""

import os
import sys
import tempfile

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

SUFFIXES = ('_mint', '_seed', '_log', '_cache', '_ledger', '_sync', '_seen',
            '_push', '_run')

# table -> (write, reconcile, cascade_on_delete, what the reconcile actually does)
#
# The note is not decoration. Naming a function is too easy to fake — pointing
# at the function that WRITES and calling it the reconcile would pass a check
# that only resolves names, and "the comment claimed a reconcile that did not
# exist" is the exact bug this file exists to prevent. The note says which part
# of the named function retracts, and against what, so the claim can be read
# against the code.
#
# reconcile may be None only with a reason in RECONCILE_WAIVED below.
LEDGERS = {
    'occasion_mint': (
        'storage.mint_occasions',
        'storage._retract_stale_mints',
        'storage.delete_occasion',
        'each mint pass drops mints whose occasion no longer matches an event '
        'that day — item and placement, ledger row included so the event '
        'returning mints afresh. A mint whose item is already GONE was '
        'finished by hand and its row stands.'),
    'flow_task_seed': (
        'storage.seed_flow_tasks',
        'storage.seed_flow_tasks',
        'storage._delete_flow_rows',
        "the completed-run branch: a routine already done for its period has "
        "its seeded action and placement deleted rather than left in the pool "
        "looking outstanding. update_flow also clears the ledger when as_task "
        "goes off, so switching it back on asks again today."),
    'qr_charge_log': (
        'storage.qr_reserve_judgment',
        None,
        'storage.qr_delete_node',
        ''),
    'sheets_item_seed': (
        'storage.seed_sheets_items',
        'storage.seed_sheets_items',
        'storage.clear_sheets_seeds',
        'the retract loop at the end of the seeding pass: a key the tab no '
        'longer offers as outstanding - ticked in the sheet, G||B&&!BLACK gone '
        'false, or the row deleted - has its seeded ITEM deleted and its '
        'ledger row dropped with it, so the row coming back in the sheet seeds '
        'afresh instead of being remembered as already handled. The cascade is '
        'per TAB, because the row numbers this table stores are addresses into '
        'one tab and mean nothing once the app is pointed at another.'),
}

RECONCILE_WAIVED = {
    'qr_charge_log':
        'FROZEN ON PURPOSE. A judged day is decided when it closes and does '
        'not get a second opinion from a config that moved since — that is '
        'the whole point of writing the row, and reconciling it would undo it.',
}

# Ledger-shaped by name, but not a memo of a projection.
NOT_LEDGERS = {
    'flow_run': 'the run itself — user data, not a memo of anything',
    'social_log': 'a rep as it was logged, price stamped; user data',
    'gcal_recurring_seen': 'a fetch cache, rebuilt freely (daybook SKIPs it)',
    'todo_sync': 'retired sync marker (daybook SKIPs it)',
    'qr_todo_push': 'retired with the to-do gate (daybook SKIPs it)',
}


def resolve_name(dotted):
    mod, _, attr = dotted.partition('.')
    return getattr({'storage': storage}[mod], attr, None)


def main():
    storage.init_db()
    conn = storage.get_conn()
    tables = sorted(r['name'] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    conn.close()

    candidates = [t for t in tables if any(t.endswith(s) for s in SUFFIXES)]
    fails = []

    for t in candidates:
        if t in NOT_LEDGERS:
            print(f'PASS  {t:<22} not a ledger — {NOT_LEDGERS[t]}')
            continue
        if t not in LEDGERS:
            fails.append(f'{t} — ledger-shaped, but says nothing about how it '
                         f'is kept honest')
            continue
        write, reconcile, cascade, note = LEDGERS[t]
        missing = [n for n in (write, cascade) if n and resolve_name(n) is None]
        if missing:
            fails.append(f'{t} names {", ".join(missing)}, which no longer exist')
            continue
        if reconcile and not note.strip():
            fails.append(f'{t} names a reconcile but does not say what it '
                         f'retracts — a name alone is not a mechanism')
            continue
        if reconcile is None:
            if t not in RECONCILE_WAIVED:
                fails.append(f'{t} has no reconcile and no reason given')
                continue
            print(f'PASS  {t:<22} write+cascade; reconcile waived')
        elif resolve_name(reconcile) is None:
            fails.append(f'{t} names reconcile {reconcile}, which no longer exists')
            continue
        else:
            print(f'PASS  {t:<22} write, reconcile, cascade all present')

    for t in sorted(set(LEDGERS) | set(NOT_LEDGERS)):
        if t not in candidates:
            print(f'STALE {t:<22} no longer exists; drop it')

    if fails:
        print('\n%d ledger(s) undeclared:' % len(fails))
        for f in fails:
            print('  FAIL  ' + f)
        print("""
A table that remembers "this already happened for that day" owes three
answers, because it will otherwise drift from the thing it is remembering:

  write     what puts a row in
  reconcile what retracts a row whose SOURCE has moved or gone — or the
            reason it is deliberately frozen instead
  cascade   what clears rows when their OWNER is deleted

Add it to LEDGERS, or to NOT_LEDGERS if it is user data rather than a memo.""")
        return 1

    print('\nEvery ledger declares how it is kept honest.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
