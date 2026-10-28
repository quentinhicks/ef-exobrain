"""A day's plan, written as text. Run: python day_plan_test.py

What this file holds (2026-10-28, Quentin's design "Calendar Plan"):

  1. The grammar (day_plan.py): a time range read forward through the day,
     an optional category before a colon, `@ place`, an indented line nested
     in the one above (the parent stretching to cover it), a `*` line a note
     inside its block, and anything else reported rather than guessed at.
  2. The plan is drawn by the one resolution (block_segments_for): filed
     under the area its category names, wearing that category's colour,
     at a named location — and nothing about it is stored but the text.
  3. A plan takes ONLY the hours it names: the week and the one-offs it
     overlaps stay around it, and come back whole when it is cleared.
  4. The route keeps the date in its path and refuses a body that is not text.
"""

import os
import sys
import tempfile
from datetime import date as date_cls

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import day_plan         # noqa: E402
import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app as app_mod    # noqa: E402

client = app_mod.app.test_client()
fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


# ── 1. the grammar ──
P = day_plan.parse('''8:55-9:10. Daily to-do list
9:10-9:40 COS333: Miscellaneous tasks
* Send task assignments email
11-1. ENT200: Read poetry book
3:30-4:45. COS333:
  3:30-4:45. A3
  4:45-5:30. Meeting with Angelina Ji
6:15-6:45. Eat dinner @ Quad
10-1. Late
what is this''')
items = P['items']
spans = [(i['start'], i['end']) for i in items]
check('times read forward: 8:55am, 11-1 is 11:00-13:00, 3:30 is 15:30',
      spans[:3] == [(535, 550), (550, 580), (660, 780)], spans)
check('a range past midnight runs into the next day (22:00-01:00)', spans[-1] == (1320, 1500), spans)
check('a category before the colon', items[1]['cat'] == 'COS333' and items[1]['title'] == 'Miscellaneous tasks')
check('a * line is a note in the block above it', items[1]['notes'] == ['Send task assignments email'])
nest = items[3]
check('indented lines nest, inheriting the category',
      [k['title'] for k in nest['kids']] == ['A3', 'Meeting with Angelina Ji']
      and all(k['cat'] == 'COS333' for k in nest['kids']))
check('the parent stretches to cover its children', (nest['start'], nest['end']) == (930, 1050))
check('a parent with no title is called by its category', day_plan.label_of(nest) == 'COS333')
check('@ names a place apart from the title', items[4]['title'] == 'Eat dinner' and items[4]['loc'] == 'Quad')
check('an unreadable line is reported with its number',
      P['skipped'] == [{'n': 10, 'text': 'what is this'}], P['skipped'])
check('blank text is no plan', day_plan.parse('  \n') == {'items': [], 'skipped': []})
zero = day_plan.parse('0-1:30 Sleep\n13-14 Lunch')['items']
check('hour 0 is midnight and an hour over 12 is 24-hour',
      [(i['start'], i['end']) for i in zero] == [(0, 90), (780, 840)], zero)

# ── 2 + 3. drawn by the one resolution, taking only its own hours ──
day = date_cls.today().isoformat()
conn = storage.get_conn()
conn.execute("INSERT INTO area (name) VALUES ('COS333')")
area_id = conn.execute("SELECT id FROM area WHERE name = 'COS333'").fetchone()['id']
conn.execute("INSERT INTO location (name, lat, lng) VALUES ('Quad', 40.3, -74.6)")
conn.execute('INSERT INTO recurring_block (label, color, day_of_week, start_time, end_time) '
             "VALUES ('COS333', '#4f7394', ?, '07:00', '08:00')", (date_cls.today().weekday(),))
conn.execute('INSERT INTO recurring_block (label, color, day_of_week, start_time, end_time) '
             "VALUES ('deep work', '#5f7f54', ?, '09:00', '17:00')", (date_cls.today().weekday(),))
conn.commit()
conn.close()
one_off = storage.create_day_block(day, 12 * 60, 14 * 60, 'Lab', '#c8828c')

before = storage.block_segments_for(day)
r = client.put(f'/api/day-plan/{day}', json={'body': '9-10 COS333: Problem set\n'
                                                      '* start with Q3\n'
                                                      '1-2 Lunch @ Quad\n'
                                                      '3-5 ENT200:\n'
                                                      '  3-4 Read\n'
                                                      '  4-5 Write'})
check('PUT saves the text', r.status_code == 200 and r.get_json()['body'].startswith('9-10'), r.get_json())
segs = storage.block_segments_for(day)
plan = [s for s in segs if s.get('plan_date') == day]
check('three plan blocks, nested ones riding inside', len(plan) == 3 and len(plan[2]['kids']) == 2, plan)
ps = plan[0]
check('filed under the area its category names', ps['area_id'] == area_id, ps)
check("wearing that category's colour", ps['color'] == '#4f7394', ps['color'])
check('carrying its * lines', ps['notes'] == ['start with Q3'], ps['notes'])
check('a known place is the location, not the title',
      plan[1]['label'] == 'Lunch' and plan[1]['location_id'], plan[1])
check('an unknown category files under nothing, in a colour of its own',
      plan[2]['area_id'] is None and plan[2]['color'] in storage.PLAN_PALETTE, plan[2])
check('a plan is no weekly and no one-off block', all(s['block_id'] is None and s['day_block_id'] is None
                                                     for s in plan))
deep = [(s['start'], s['end']) for s in segs if s['label'] == 'deep work']
check('the week keeps the hours the plan does not name',
      deep == [(600, 720), (840, 900)], deep)
lab = [(s['start'], s['end']) for s in segs if s.get('day_block_id') == one_off['id']]
check('a one-off is trimmed by the plan too', lab == [(720, 780)], lab)
check('blocks the plan does not touch are left alone',
      [(s['start'], s['end']) for s in segs if s['label'] == 'COS333' and s['block_id']] == [(420, 480)])
check('nothing but the text is stored', storage.get_conn().execute(
    'SELECT COUNT(*) FROM day_block').fetchone()[0] == 1)
check('the calendar read carries the plan', client.get(
    f'/api/calendar/days?from={day}&to={day}').get_json()[day]['plan']['body'].startswith('9-10'))

client.put(f'/api/day-plan/{day}', json={'body': '   '})
check('blank text clears it, and the day comes back whole', storage.block_segments_for(day) == before)
check('...with no row left', storage.get_conn().execute('SELECT COUNT(*) FROM day_plan').fetchone()[0] == 0)

# ── 5. the events it covers, decided once and served ──
conn = storage.get_conn()
conn.execute("INSERT INTO calendar_source (name, url, color) VALUES ('Mine', 'x', '#888888')")
src = conn.execute('SELECT id FROM calendar_source').fetchone()['id']
for uid, summary, s, e, allday in (('e1', 'Gym', f'{day}T08:30:00', f'{day}T09:30:00', 0),
                                   ('e2', 'Office hours', f'{day}T10:30:00', f'{day}T11:00:00', 0),
                                   ('e3', 'Holiday', day, day, 1)):
    conn.execute('INSERT INTO gcal_event (uid, summary, start, end, allday, source_id) VALUES (?,?,?,?,?,?)',
                 (uid, summary, s, e, allday, src))
conn.commit()
conn.close()
covered = lambda: {e['summary']: e['plan_covered'] for e in storage.get_gcal_events()}
check('with no plan, no event is covered', not any(covered().values()), covered())
client.put(f'/api/day-plan/{day}', json={'body': '9-10 COS333: Problem set'})
check('an event the plan overlaps at all is covered; one in its gaps and an all-day one are not',
      covered() == {'Gym': True, 'Office hours': False, 'Holiday': False}, covered())
check('the calendar read serves the flag', all('plan_covered' in e for e in client.get('/api/gcal').get_json()))
panel = [r['label'] for r in storage.get_engage_day()['rows'] if r['kind'] == 'event']
check("the NOW panel's day skips the covered event", panel == ['Office hours'], panel)
client.put(f'/api/day-plan/{day}', json={'body': ''})
check('clearing the plan uncovers it', not any(covered().values()), covered())

# ── 4. the route ──
check('a bad date is refused', client.put('/api/day-plan/today', json={'body': 'x'}).status_code == 400)
check('a body that is not text is refused', client.put(f'/api/day-plan/{day}', json={}).status_code == 400)

print()
print(f'{len(fails)} FAILED' if fails else 'All checks passed.')
sys.exit(1 if fails else 0)
