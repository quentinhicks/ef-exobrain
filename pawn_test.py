"""Tests for pawning a routine step onto a later routine. Run: python pawn_test.py

Same shape as qr_charge_test.py — a temp database, no framework, each check
naming the failure it prevents.

This mechanic earns tests because it spans three things that are easy to get
individually right and jointly wrong: which routine owns a step TODAY, what the
receiving gate's window is, and the fact that both have to come back when the
step is taken back. The gate shortening is derived rather than stored precisely
so that last part cannot rot, and that is what is asserted here.
"""

import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import qr_judge         # noqa: E402

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


TODAY = date_cls.today().isoformat()
TOMORROW = (date_cls.today() + timedelta(days=1)).isoformat()

storage.init_db()
conn = sqlite3.connect(storage.DB_PATH)
conn.execute("""INSERT INTO qr_node (id, label, token, window_start, window_end,
                window_end_offset_days, days_of_week)
                VALUES (9, 'Night gate', 'tok9', '22:00', '23:00', 0, '0123456')""")
# Ids well clear of the seeded weekly-review routine (storage._seed_review_flow
# writes one into every fresh database).
conn.execute("INSERT INTO flow (id, name, position, qr_node_id) VALUES (101, 'Morning', 1, NULL)")
conn.execute("INSERT INTO flow (id, name, position, qr_node_id) VALUES (102, 'Night', 2, 9)")
conn.execute("""INSERT INTO flow_step (id, flow_id, position, content, requirement,
                pawn_to_flow_id, pawn_minutes)
                VALUES (111, 101, 1, 'Tidy desk', 'hard', 102, 10)""")
conn.execute("""INSERT INTO flow_step (id, flow_id, position, content, requirement)
                VALUES (112, 101, 2, 'Meditate', 'hard')""")
conn.execute("""INSERT INTO flow_step (id, flow_id, position, content, requirement)
                VALUES (113, 102, 1, 'Journal', 'hard')""")
conn.commit()
conn.close()
storage.init_db()          # the lazy ALTERs, again — they must be idempotent

NODE = storage.qr_get_nodes()[0]


def due(date=TODAY):
    # This fixture's two routines only — every database also carries the seeded
    # weekly review, which has nothing to do with pawning.
    return {f['name']: [s['content'] for s in f['steps'] if s['due']]
            for f in storage.get_flows(date) if f['name'] in ('Morning', 'Night')}


def window(date=TODAY):
    return qr_judge.resolve_window(NODE, date)


# ── at rest ──────────────────────────────────────────────────

eq('at rest: each routine has its own steps',
   due(), {'Morning': ['Tidy desk', 'Meditate'], 'Night': ['Journal']})
eq('at rest: the gate is its full length', window(), ('22:00', '23:00', 0))

# ── pawned ───────────────────────────────────────────────────

storage.pawn_flow_step(111)

eq('pawned: the step leaves the routine it was pawned FROM',
   due()['Morning'], ['Meditate'])
eq('pawned: and joins the one it was pawned TO, FIRST — carried debt is done'
   ' before the receiving routine\'s own steps, not against its deadline',
   due()['Night'], ['Tidy desk', 'Journal'])
eq('pawned: the receiving gate closes 10 minutes earlier',
   window(), ('22:00', '22:50', 0))
eq('pawned: it is marked so the runner can say where it came from',
   [(s.get('pawned_in'), s.get('from_flow_id'))
    for f in storage.get_flows(TODAY) if f['name'] == 'Night'
    for s in f['steps'] if s['content'] == 'Tidy desk'],
   [(True, 101)])

# A pawn is LOCAL to one day — that is the whole point of it being per-day state
# next to done_date rather than a setting.
eq('pawned: tomorrow is untouched',
   due(TOMORROW), {'Morning': ['Tidy desk', 'Meditate'], 'Night': ['Journal']})
eq("pawned: and tomorrow's gate is untouched", window(TOMORROW), ('22:00', '23:00', 0))

# ── taken back ───────────────────────────────────────────────

storage.pawn_flow_step(111, on=False)
eq('taken back: the step returns',
   due(), {'Morning': ['Tidy desk', 'Meditate'], 'Night': ['Journal']})
eq('taken back: and the gate is its full length again — the shortening is derived,'
   ' never stored, so nothing has to remember to undo it',
   window(), ('22:00', '23:00', 0))

# ── the rules ────────────────────────────────────────────────

try:
    storage.pawn_flow_step(112)
    eq('a step with no destination cannot be pawned', 'no error', 'ValueError')
except ValueError:
    eq('a step with no destination cannot be pawned', 'ValueError', 'ValueError')

# Clearing the destination has to un-pawn it too, or a step sits in a routine it
# can no longer be sent to and the gate stays short with nothing explaining why.
storage.pawn_flow_step(111)
storage.update_flow_step(111, pawn_to_flow_id=None)
eq('clearing the destination takes the step home', due()['Morning'], ['Tidy desk', 'Meditate'])
eq('clearing the destination restores the gate', window(), ('22:00', '23:00', 0))

# A pawn can never make a gate unsatisfiable: the deadline stops at the opening.
storage.update_flow_step(111, pawn_to_flow_id=102, pawn_minutes=5000)
storage.pawn_flow_step(111)
eq('an absurd cost clamps at the opening rather than inverting the window',
   window(), ('22:00', '22:00', 0))
storage.pawn_flow_step(111, on=False)
storage.update_flow_step(111, pawn_minutes=10)

# A gate with no routine pawned into it is unaffected by anyone else's pawn.
conn = sqlite3.connect(storage.DB_PATH)
conn.execute("""INSERT INTO qr_node (id, label, token, window_start, window_end,
                window_end_offset_days, days_of_week)
                VALUES (10, 'Desk gate', 'tok10', '09:00', '17:00', 0, '0123456')""")
conn.commit()
conn.close()
storage.init_db()
storage.pawn_flow_step(111)
other = [n for n in storage.qr_get_nodes() if n['id'] == 10][0]
eq('a gate with nothing pawned into it keeps its window',
   qr_judge.resolve_window(other, TODAY), ('09:00', '17:00', 0))

# A day override is a deliberate decision about that day, so the pawn does not
# shorten it further — otherwise dragging tonight's deadline would move again.
storage.qr_set_override(9, TODAY, '21:00', '21:30', 0)
eq('a day override stands as written, pawn or no pawn',
   window(), ('21:00', '21:30', 0))

# Two steps pawned onto the same routine arrive as a group, in the order they
# had where they came from — a pawned routine is not shuffled by being carried.
storage.update_flow_step(112, pawn_to_flow_id=102, pawn_minutes=5)
storage.pawn_flow_step(112)
eq('two pawned steps keep their own order, together at the front',
   due()['Night'], ['Tidy desk', 'Meditate', 'Journal'])

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
