"""Tests for occasions — the actions a KIND of event always brings with it.
Run: python occasion_test.py

Same shape as pawn_test.py: a temp database, no framework, each check naming the
failure it prevents.

This earns tests because it writes into `inbox_item`, the one table every lens
reads. Two things have to hold and neither is visible from the surface that
configures them: a TEMPLATE must be invisible to every availability predicate
(or you get phantom actions in the pool that no clarify ever produced), and a
mint must happen exactly once per day per template (or finishing the action
re-mints it, forever).
"""

import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


TODAY = date_cls.today().isoformat()
TOMORROW = (date_cls.today() + timedelta(days=1)).isoformat()
YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()

storage.init_db()
conn = sqlite3.connect(storage.DB_PATH)
conn.execute("INSERT INTO domain (id, name) VALUES (7, 'Work')")
conn.execute("""INSERT INTO calendar_source (id, name, url, color, active)
                VALUES (1, 'Personal', 'http://x', '#888', 1)""")
conn.execute("""INSERT INTO calendar_source (id, name, url, color, active)
                VALUES (2, 'Muted', 'http://y', '#888', 0)""")
conn.execute("""INSERT INTO area (id, name, domain_id, active, type)
                VALUES (7, 'Clients', 7, 1, 'standard')""")


def add_event(summary, day, hhmm, source=1):
    conn.execute(
        """INSERT INTO gcal_event (uid, summary, start, end, allday, source_id)
           VALUES (?, ?, ?, ?, 0, ?)""",
        (f'{summary}-{day}-{hhmm}@t', summary, f'{day}T{hhmm}:00', f'{day}T{hhmm}:00', source))
    conn.commit()


# Two separately-booked meetings, different days, different times, different
# uids — the case a recurring-series rule cannot see. Only the title is shared.
add_event('1:1 with Dave', TODAY, '14:00')
add_event('Dave 1:1 (moved)', TOMORROW, '17:00')
add_event('Standup', TODAY, '09:30')

occ = storage.create_occasion('Dave 1:1', 'dave')
storage.add_occasion_item(occ['id'], 'Pull last week numbers', area_id=7)
storage.add_occasion_item(occ['id'], 'Write up actions', area_id=7)

eq('an occasion reports its template actions', 2, len(storage.get_occasion(occ['id'])['items']))


# ── A template is not an action ──────────────────────────────────
# Every one of these lenses reads inbox_item. None may show a template.
eq('templates stay out of the pool', [], storage.get_active_items_all())
eq('templates stay out of MAP', [], storage.get_map_items())
eq('templates stay out of the inbox', [], storage.get_inbox_items())
eq('templates stay out of the deferred list', [], storage.get_deferred_items())
counts = storage.get_gtd_review_counts()
eq('templates are not counted for review', 0, counts.get('inbox', 0) + counts.get('someday', 0))


# ── Minting ──────────────────────────────────────────────────────
storage.mint_occasions(TODAY)
pool = storage.get_active_items_all()
eq('the day mints one action per template', 2, len(pool))
eq('the minted actions keep their wording',
   ['Pull last week numbers', 'Write up actions'],
   sorted(i['content'] for i in pool))
eq('the minted actions keep their area', {7}, {i['area_id'] for i in pool})

placed = storage.get_engage_placements(TODAY)
eq('they are placed at the matching event start', [840, 840],
   [int(p['minute']) for p in placed])

# The templates are still templates.
eq('minting does not consume the templates', 2, len(storage.get_occasion(occ['id'])['items']))


# ── Idempotency, the load-bearing half ───────────────────────────
storage.mint_occasions(TODAY)
storage.mint_occasions(TODAY)
eq('re-reading the day does not re-mint', 2, len(storage.get_active_items_all()))

# Completion DELETES the row, which is exactly why the mint ledger is a table of
# its own rather than a lookup for a live item.
done = storage.get_active_items_all()[0]
storage.delete_inbox_item(done['id'])
storage.mint_occasions(TODAY)
eq('finishing a minted action does not bring it back', 1, len(storage.get_active_items_all()))


# ── Matching ─────────────────────────────────────────────────────
# Same occasion, an unrelated day and time, booked as its own event.
storage.mint_occasions(TOMORROW)
eq('the next booking mints again, by TITLE not by series', 2,
   len(storage.get_engage_placements(TOMORROW)))
eq('and lands at that booking own time', [1020, 1020],
   [int(p['minute']) for p in storage.get_engage_placements(TOMORROW)])

# 'Standup' matches nothing, and 'dave' must not match it.
eq('a non-matching event mints nothing extra', 3,
   len(storage.get_active_items_all()))

add_event('Lunch with DAVE', YESTERDAY, '12:00')
storage.mint_occasions(YESTERDAY)
eq('a past day is never minted into', [], storage.get_engage_placements(YESTERDAY))

# An event on a switched-off calendar is not on the day, so it may not bring
# actions onto it — the same JOIN get_gcal_events reads through.
DAY3 = (date_cls.today() + timedelta(days=3)).isoformat()
add_event('Dave sync', DAY3, '11:00', source=2)
storage.mint_occasions(DAY3)
eq('a muted calendar mints nothing', [], storage.get_engage_placements(DAY3))


# ── Paused, and the escape hatch ─────────────────────────────────
storage.update_occasion(occ['id'], active=0)
conn.execute("DELETE FROM occasion_mint WHERE date = ?", (TOMORROW,))
conn.execute("DELETE FROM engage_placement WHERE date = ?", (TOMORROW,))
conn.commit()
storage.mint_occasions(TOMORROW)
eq('a paused occasion mints nothing', [], storage.get_engage_placements(TOMORROW))
storage.update_occasion(occ['id'], active=1)

# The one silent data bug this feature could cause: a template springing into
# the inventory because something PATCHed a status onto it.
tpl = storage.get_occasion(occ['id'])['items'][0]
storage.update_inbox_item(tpl['id'], status='active', content='renamed template')
after = storage.get_occasion(occ['id'])['items'][0]
eq('a template refuses to change status', 'occasion',
   conn.execute('SELECT status FROM inbox_item WHERE id = ?', (tpl['id'],)).fetchone()[0])
eq('but everything else on it still edits', 'renamed template', after['content'])


# ── Deleting the occasion ────────────────────────────────────────
live_before = len(storage.get_active_items_all())
storage.delete_occasion(occ['id'])
eq('deleting an occasion takes its templates', [], storage.get_occasions())
eq('but leaves the actions it already minted', live_before,
   len(storage.get_active_items_all()))

print()
if fails:
    print(f'{len(fails)} FAILED: ' + ', '.join(fails))
    sys.exit(1)
print('All checks passed.')
