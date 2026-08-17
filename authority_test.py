"""Everything the money path reads is accounted for. Run: python authority_test.py

Fifth tripwire. The others are about WHICH DAY; this one is about WHO DECIDES.

qr_judge charges real money. Every value it reads is therefore an authority —
if a client can set it, a client can decide what it costs. That is not
hypothetical: put_flow_run stored whatever `completed` it was sent, and the
only thing enforcing a hard metrics step was a DISABLED BUTTON driven by a
boolean the runner had cached when it opened. A stale tab, a second device or
a replayed PUT completed a gated run with metrics unanswered, and the gate
judged the day satisfied.

So the rule: ANYTHING THE MONEY PATH READS IS RECOMPUTED WHERE IT IS WRITTEN.
A client's flag is a request, never a verdict.

What makes this mechanical rather than a good intention: the list of things
the judge reads is not curated by hand, it is SCANNED out of qr_judge.py. Every
storage.* call it makes must be declared below with what guards it. The judge
reaching for something new fails this test until someone says who decides it.

Companions: resolution_test, ledger_test, dayrule_test, daybook_test.
"""

import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import storage          # noqa: E402

# storage function the judge calls -> who decides the value it returns.
#
# "written by the judge" and "config, not client data" are real answers. What
# is not an answer is silence, which is what this file exists to prevent.
READS = {
    # ── things a CLIENT can influence, and what re-decides them ──
    'gating_flow_for_node':
        'flow_run.completed_at — RECOMPUTED at the write: put_flow_run honours '
        'completed only after run_completion_ok re-checks today\'s day_steps '
        'and every hard metrics step (storage.run_completion_ok).',
    'pawned_minutes_for_node':
        'flow_step.pawned_date — shortens a gate deadline, so it is a money '
        'input. Guarded at the write by pawn_flow_step refusing a step with no '
        'destination; the DAY comes from the runner\'s pinned run day.',
    'qr_get_nodes':
        'qr_node — every field change goes through qr_judge.apply_node_patch, '
        'which PENDS anything it cannot prove tighter (24h).',
    'qr_get_override':
        'qr_override — guarded by qr_judge.override_locked: within 24h of the '
        'day\'s close it can no longer be created, moved OR removed.',
    'qr_overrides_between':
        'same rows, read for the ✓/✗ history.',
    'qr_scans_in_window':
        'qr_scan — written ONLY by qr_scan_server from a real scan; the QR '
        'token is the secret and the geofence is checked there. No app route '
        'writes it.',
    'qr_scans_between':
        'same rows, read for the ✓/✗ history.',
    'schedule_resolver':
        'schedule_source — a gated flow\'s source change runs through '
        'schedule.demands_less and pends if looser.',

    # ── a change dated forward (2026-08-17) ──
    'effective_date_for':
        'not data — the ONE rounding rule turning "when does this land" into '
        '"which day does it govern". Rounds UP off midnight, so a change '
        'landing mid-afternoon governs the NEXT day: overstating a loosening '
        'would show a gate as relaxed on a day still being judged.',
    'row_as_of':
        'not data — layers dated changes onto a row for a FUTURE day, which is '
        'how the calendar draws Wednesday. Past and today cannot be affected: '
        'anything effective by today has an apply_at that has already passed, '
        'so it is written into the row and there is nothing left to layer. The '
        'judge therefore reads exactly what it read before this existed.',
    'falsy':
        'not data — the one test for a switched-off flag, shared because a '
        'queued `active` arrives as the string "0", which is TRUE in Python. '
        'The projection has to read it exactly the way the judge does.',

    # ── things the judge writes itself, or config ──
    'qr_reserve_judgment': 'written BY the judge; the insert is the lock.',
    'qr_settle_charge': 'written BY the judge, after the API call.',
    'qr_judgment_exists': 'the judge\'s own rows — the anti-double-judge guard.',
    'qr_judgments_between': 'the judge\'s own rows — a closed day is read back.',
    'qr_last_judged_date': 'the judge\'s own rows — how far the backfill walks.',
    'qr_weekly_spent_cents': 'the judge\'s own rows — the cap.',
    'qr_apply_due_pending_changes': 'lands easings that already waited 24h.',
    'qr_ensure_charge_columns': 'schema, not data.',
    'get_settings': 'config: the four charging locks and the timezone.',
    'set_setting': 'writes gate_judge_last_run, so the panel can say it ran.',
    'apply_timezone': 'the clock the whole judgment runs on.',
    '_adopt_gate_schedules': 'schema adoption, additive.',
    'QR_NODE_FIELDS':
        'not data — the allowlist of node columns a pending may land on, and '
        'the set apply_node_patch classifies. A field added here waits 24h '
        'until someone writes its is_loosening branch (the fallthrough proves '
        'nothing tighter), which is the point of that inversion.',
}

CALL_RE = re.compile(r'storage\.([a-zA-Z_][a-zA-Z0-9_]*)')


def main():
    with open(os.path.join(HERE, 'qr_judge.py'), encoding='utf-8') as f:
        src = f.read()

    called = sorted({m for m in CALL_RE.findall(src) if m})
    fails = []

    for name in called:
        if name not in READS:
            fails.append(f'qr_judge calls storage.{name}, and nothing says who '
                         f'decides what it returns')
            continue
        if getattr(storage, name, None) is None:
            fails.append(f'storage.{name} is declared here but no longer exists')
            continue
        print(f'PASS  storage.{name}')

    for name in sorted(READS):
        if name not in called and getattr(storage, name, None) is not None:
            print(f'STALE storage.{name} — the judge no longer calls it')

    # The guard named in the completed_at entry has to be real: it is the one
    # that was missing entirely, and a comment claiming it would be worse than
    # nothing.
    if getattr(storage, 'run_completion_ok', None) is None:
        fails.append('storage.run_completion_ok is gone — nothing re-checks a '
                     'run the client claims is complete')

    if fails:
        print('\n%d unaccounted money-path read(s):' % len(fails))
        for f in fails:
            print('  FAIL  ' + f)
        print("""
qr_judge charges real money, so everything it reads is an AUTHORITY. Say who
decides the value: the judge itself, config, a surface that cannot be reached
by a client — or, if a client CAN set it, name the server-side recomputation
that re-decides it at the write. A client's flag is a request, never a
verdict.""")
        return 1

    print('\nEvery money-path read says who decides it.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
