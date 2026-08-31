"""Tests for pawning a routine step onto a later routine. Run: python pawn_test.py

Same shape as qr_charge_test.py — a temp database, no framework, each check
naming the failure it prevents.

This mechanic earns tests because it spans three things that are easy to get
individually right and jointly wrong: which routine owns a step TODAY, what the
receiving gate's window is, and the fact that both have to come back when the
step is taken back. The window change is derived rather than stored precisely
so that last part cannot rot, and that is what is asserted here.

2026-08-25, Quentin's instruction: pawned work moves the OPENING earlier and
never the close. It used to pull the deadline in, which punished you for moving
work — the same amount to do, in less time, on a gate that got harder every
time you rescheduled. Both ends are asserted below: the opening moves, the
deadline does not, and the routine's own window follows the identical rule
through the identical function (qr_judge.opened_earlier).
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
    # TODAY'S RUN — `day_steps`, which the server composes once. This fixture's
    # two routines only; every database also carries the seeded weekly review,
    # which has nothing to do with pawning.
    return {f['name']: [s['content'] for s in f['day_steps']]
            for f in storage.get_flows(date) if f['name'] in ('Morning', 'Night')}


def routine(date=TODAY):
    # THE ROUTINE ITSELF — what the editor shows. A pawn is local to one day and
    # must never appear here as a change to the list.
    return {f['name']: [s['content'] for s in f['steps']]
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
eq('pawned: the receiving gate CLOSES 10 minutes earlier — the scan is the price',
   window(), ('22:00', '22:50', 0))
eq('pawned: it is marked so the runner can say where it came from',
   [(s.get('pawned_in'), s.get('from_flow_id'))
    for f in storage.get_flows(TODAY) if f['name'] == 'Night'
    for s in f['day_steps'] if s['content'] == 'Tidy desk'],
   [(True, 101)])

# THE ROUTINE IS GLOBAL, THE PAWN IS LOCAL. This is the whole reason the two
# lists are separate fields: the editor edits the routine, and a step being
# carried elsewhere for one day may not add, remove or reorder anything there.
eq('pawned: the ROUTINE list is untouched — the step is still Morning\'s',
   routine(), {'Morning': ['Tidy desk', 'Meditate'], 'Night': ['Journal']})
eq('pawned: and nothing foreign is spliced into the receiving routine',
   [s['content'] for f in storage.get_flows(TODAY) if f['name'] == 'Night'
    for s in f['steps']],
   ['Journal'])
eq('pawned: the step says where it went, as a badge on its own row',
   [(s['content'], s.get('pawned_out'))
    for f in storage.get_flows(TODAY) if f['name'] == 'Morning'
    for s in f['steps']],
   [('Tidy desk', True), ('Meditate', None)])
eq('pawned: it is still DUE — it runs today, just somewhere else',
   [s['due'] for f in storage.get_flows(TODAY) if f['name'] == 'Morning'
    for s in f['steps'] if s['content'] == 'Tidy desk'],
   [True])

# With no date there is no day at all, so there is no day list to read.
eq('undated: the routine has no day_steps to confuse it with',
   [f.get('day_steps') for f in storage.get_flows() if f['name'] == 'Morning'],
   [None])

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

# A pawn can never invert a window: the opening stops at midnight and the close
# is not touched at all, so there is no arithmetic here that can cross them.
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


# THE PAWN'S DAY IS THE RUN'S DAY (2026-08-17). The route dropped the date
# parameter pawn_flow_step already took, so a run opened at 23:50 and continued
# past midnight stamped pawned_date with the NEW day: the step never arrived in
# tonight's receiving routine, tonight's gate was not shortened, and TOMORROW's
# deadline moved earlier for debt incurred tonight — a real-money shortening
# applied to the wrong day.
YDAY = (date_cls.fromisoformat(TODAY) - timedelta(days=1)).isoformat()
storage.pawn_flow_step(111, on=False)
storage.pawn_flow_step(112, on=False)
storage.pawn_flow_step(111, date=YDAY)
eq('a pawn filed under yesterday does not shorten TODAY\'s gate',
   window(), ('21:00', '21:30', 0))
eq('and the step is carried on the day it was pawned, not today',
   [s['content'] for s in storage.steps_pawned_into(102, YDAY)], ['Tidy desk'])
eq('…not on today', [s['content'] for s in storage.steps_pawned_into(102, TODAY)], [])

# ── THE ROUTINE'S OWN WINDOW obeys the same rule ─────────────────────────────
#
# The gate above is the scan window; this is the routine's own hours, which is
# what "the routine starts earlier" actually means. Both go through
# opened_earlier, so the pair cannot drift.
storage.pawn_flow_step(111, on=False)
storage.pawn_flow_step(112, on=False)
storage.update_flow_step(111, pawn_minutes=20)
src = storage.create_schedule_source(
    'rule', title='night hours', start=f'{TODAY}T21:00:00', duration='PT2H',
    recurrenceRules=[{'frequency': 'daily', 'interval': 1}])
storage.update_flow(102, source_uid=src['uid'])
night = [f for f in storage.get_flows() if f['id'] == 102][0]
eq('at rest: the routine runs its own hours',
   qr_judge.flow_day_window(night, TODAY), (21 * 60, 23 * 60))
storage.pawn_flow_step(111)
night = [f for f in storage.get_flows() if f['id'] == 102][0]
eq('pawned: it OPENS 20 minutes earlier and is due at the same minute',
   qr_judge.flow_day_window(night, TODAY), (20 * 60 + 40, 23 * 60))
storage.pawn_flow_step(111, on=False)
night = [f for f in storage.get_flows() if f['id'] == 102][0]
eq('taken back: the routine returns to its own hours',
   qr_judge.flow_day_window(night, TODAY), (21 * 60, 23 * 60))

# ── THE DEADLINE IS GIVEN BACK WHAT THE CLOSE LOST, never the raw minutes ────
#
# routine_deadline is "the gate's close, plus the offset, plus the minutes the
# pawn took off that close" — so the routine lands where it stood unpawned. It
# used to add the PAWNED minutes instead, which is the same number only when
# the close really moved by them. Two live cases where it did not, and both
# handed the routine free time on the money path (it earns half the day's
# credit): a date override, which stands as written and loses nothing, and a
# cost bigger than the window, which closed_earlier only pays down to the
# opening. One cause — a second place re-deriving what the close did — so
# pawn_giveback answers it once and this asserts the invariant, not the branch.
storage.pawn_flow_step(111, on=False)
storage.pawn_flow_step(112, on=False)
storage.update_flow_step(111, pawn_minutes=10)
storage.update_flow(102, source_uid=None)
conn = sqlite3.connect(storage.DB_PATH)
conn.execute('DELETE FROM qr_override')
# Raw, deliberately: lengthening the offset on a GATED routine is an easing and
# update_flow queues it for 24h (correctly). This test is about the pawn, not
# about the queue, so the offset is simply put there.
conn.execute('UPDATE flow SET offset_min = 60 WHERE id = 102')
conn.commit()
conn.close()


def deadline(date=TODAY):
    flow = [f for f in storage.get_flows() if f['id'] == 102][0]
    return qr_judge.routine_deadline(NODE, flow, date)


rest = deadline()
eq('at rest: the routine is due its offset after the gate closes',
   rest.strftime('%H:%M'), '00:00')
storage.pawn_flow_step(111)
eq('pawned: the gate closes 10 earlier and the deadline does not move',
   (window(), deadline()), (('22:00', '22:50', 0), rest))

storage.qr_set_override(9, TODAY, '21:00', '21:30', 0)
eq('override + pawn: the close lost nothing, so the deadline gains nothing —'
   ' pawning may not buy time on a day you already dragged',
   (window(), deadline().strftime('%H:%M')), (('21:00', '21:30', 0), '22:30'))
conn = sqlite3.connect(storage.DB_PATH)
conn.execute('DELETE FROM qr_override')
conn.commit()
conn.close()

storage.update_flow_step(111, pawn_minutes=5000)
eq('an absurd cost clamps BOTH ends together: the close stops at the opening'
   ' and the deadline is given back only what was actually taken',
   (window(), deadline()), (('22:00', '22:00', 0), rest))
storage.update_flow_step(111, pawn_minutes=10)
storage.pawn_flow_step(111, on=False)
eq('pawn_giveback is 0 with nothing pawned', qr_judge.pawn_giveback(NODE, TODAY), 0)
storage.pawn_flow_step(111)
eq('…and is what closed_earlier removed when there is',
   qr_judge.pawn_giveback(NODE, TODAY), 10)
storage.pawn_flow_step(111, on=False)


# The rule itself, in isolation — one function, so a new window kind gets this
# behaviour by asking rather than by remembering.
eq('opened_earlier moves only the start', qr_judge.opened_earlier(600, 700, 25), (575, 700))
eq('…and stops at midnight', qr_judge.opened_earlier(30, 700, 90), (0, 700))
eq('closed_earlier moves only the close', qr_judge.closed_earlier(600, 700, 25), (600, 675))
eq('…and stops at the opening', qr_judge.closed_earlier(600, 700, 5000), (600, 600))
eq('…and both do nothing with nothing pawned',
   (qr_judge.opened_earlier(600, 700, 0), qr_judge.closed_earlier(600, 700, 0)),
   ((600, 700), (600, 700)))

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
