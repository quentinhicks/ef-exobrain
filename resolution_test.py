"""Every global→day projection is DECLARED. Run: python resolution_test.py

The third tripwire, and the one that covers the whole bug class rather than a
corner of it. Same bargain as daybook_test's unclassified-table check.

A column like days_of_week, rrule, source_uid or defer_until says "this row
means something different on different days". Answering that — "what does this
standing thing mean on date D" — is the single most error-prone act in this
codebase. Every one of the eleven bugs fixed on 2026-08-17 was a second place
re-deriving an answer the first place already had, agreeing on the common case
and disagreeing at midnight, at a paused row, at a moved event.

The resolvers are individually fine. What did not exist was anything that knew
they are THE SAME KIND OF THING, so each new one re-made every decision from
scratch — which day key, whose clock, served or re-derived, cached where,
invalidated by what — and got some of them wrong.

So: a table that grows a day-projecting column FAILS THIS TEST until someone
says how it projects. The failure is the conversation. It also checks the named
resolvers still exist, so a rename cannot quietly orphan a declaration.

Companion tripwires: dayrule_test (which day a WRITE files under) and
daybook_test (which day a row is HISTORY for).
"""

import os
import sys
import tempfile

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import schedule         # noqa: E402
import qr_judge         # noqa: E402

# A column whose presence means the row projects onto days.
PROJECTING = (
    'days_of_week', 'day_of_week', 'rrule', 'recurrence_rules', 'recurrence_overrides',
    'source_uid', 'weekly_windows', 'defer_until', 'period', 'entries', 'follows',
    'match_text', 'pawn_to_flow_id', 'effective_date',
)

# table -> (resolver, how the answer reaches whoever needs it)
#
# The resolver is the ONE function that answers "what does this mean on date
# D". If a second place needs the answer it asks this, or reads what this
# served — it does not re-derive. That sentence is the entire point of the file.
RESOLUTIONS = {
    'recurring_block': (
        'storage.block_segments_for',
        'served: GET /api/blocks/day, and get_engage_day rows. Overrides applied, '
        'past-midnight wrapped, yesterday continuing at a NEGATIVE start.'),
    'recurring_task': (
        'storage._recurring_due',
        'evaluated server-side into the pool; recurrence.py answers the day.'),
    'qr_node': (
        'qr_judge.resolve_window',
        'served: node.day_windows, keyed by exact DATE (nodeWindowForDate reads '
        'it). date override > source > weekly > defaults — qr_override is an '
        'INPUT to that ladder, already day-keyed, so it projects nothing '
        'itself and is deliberately absent below.'),
    'flow': (
        'qr_judge.flow_day_window',
        'served: due_min / window_open_min, plus day_steps and period_key from '
        'get_flows(date). flowDueMin is a READER.'),
    'flow_step': (
        'storage.step_due_on',
        "served: s.due and day_steps. The client trusts the server's answer; "
        'pawned_date is per-day state on top (steps_pawned_into).'),
    'metric': (
        'storage.metrics_for_step',
        "a SECOND filter under the step's own days; served per step, paused "
        'metrics dropped.'),
    'inbox_item': (
        'storage._AVAILABLE',
        'the availability predicate (with _DEFERRED for the return list). A '
        'shared SQL fragment precisely so three copies cannot drift again.'),
    'occasion': (
        'storage.mint_occasions',
        'matches the day\'s events by title and mints once per (day, template); '
        '_retract_stale_mints reconciles when the event moves.'),
    'schedule_source': (
        'schedule.occurrences',
        'the occurrence engine everything above leans on; day_intervals clips it '
        'to a day, and looks back the source\'s own longest span.'),
    'tag_time': (
        'schedule.day_intervals',
        "served as each source's intervals on GET /api/schedules?date=. The DAY "
        'half is the server\'s; only the CLOCK comparison is the client\'s.'),
    'easing_pending': (
        'storage.row_as_of',
        'served: the row AS OF a day, which is what draws a future one — '
        'node.day_windows (with scheduled_change set on the days that differ) '
        'and block_segments_for. effective_date is the first day a queued '
        'change governs, rounded UP off midnight by effective_date_for. Days '
        'at or before today resolve identically to the plain row, because '
        'anything effective by today has already been applied to it.'),
    'time_preset': (
        None,
        'RETIRED. Kept as the migration source for schedule_source (the same '
        'reason gtd_review.steps is kept); nothing resolves it.'),
}


def resolve_name(dotted):
    mod, _, attr = dotted.partition('.')
    return getattr({'storage': storage, 'schedule': schedule,
                    'qr_judge': qr_judge}[mod], attr, None)


def main():
    storage.init_db()
    conn = storage.get_conn()
    tables = sorted(r['name'] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))

    projecting = {}
    for t in tables:
        cols = [r['name'] for r in conn.execute(f'PRAGMA table_info({t})')]
        hits = [c for c in PROJECTING if c in cols]
        if hits:
            projecting[t] = hits
    conn.close()

    fails = []
    for t, cols in sorted(projecting.items()):
        if t not in RESOLUTIONS:
            fails.append(f'{t} ({", ".join(cols)}) — no declared resolver')
            continue
        resolver, _note = RESOLUTIONS[t]
        if resolver is None:
            print(f'PASS  {t:<18} retired, nothing resolves it')
            continue
        if resolve_name(resolver) is None:
            fails.append(f'{t} declares {resolver}, which no longer exists')
            continue
        print(f'PASS  {t:<18} {resolver}')

    for t in sorted(RESOLUTIONS):
        if t not in projecting:
            print(f'STALE {t:<18} no longer projects onto days; drop it')

    if fails:
        print('\n%d table(s) project onto days without saying how:' % len(fails))
        for f in fails:
            print('  FAIL  ' + f)
        print("""
A column like days_of_week or source_uid means this row means something
DIFFERENT on different days. Name the ONE function that answers it, and say
how the answer reaches whoever else needs it — served as a field, or by
calling that function. What must not happen is a second implementation:
a client re-derivation is a bug even while it agrees, because it agrees
only until midnight, a pause, or a config change.""")
        return 1

    print('\nEvery day-projecting table declares its resolver.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
