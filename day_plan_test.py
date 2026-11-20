"""A day's plan, written as text. Run: python day_plan_test.py

What this file holds (2026-10-28, Quentin's design "Calendar Plan"):

  1. The grammar (day_plan.py): a time range read forward through the day,
     an optional category before a colon, `@ place`, an indented line nested
     in the one above (the parent stretching to cover it), a `*` line a note
     inside its block, and anything else reported rather than guessed at.
  2. The plan is drawn by the one resolution (block_segments_for): filed
     under the area its category names, wearing that category's colour,
     at a named location — and nothing about it is stored but the text.
  3. A plan REPLACES the day (2026-11-20, "Calendar To-dos" 9a, reversing
     "only the hours it names"): the week's blocks, the one-offs and the
     timed events of a planned date are not in force, and come back whole
     when it is cleared.
  4. The route keeps the date in its path and refuses a body that is not text.
  5. (2026-11-20) A `*` line is a TASK: a to-do item, its id in hex on the
     line, placed on the day; a `@ PLACE.` line is a frame; nesting goes to
     any depth; a name's colour follows the word rule.
  6. The text and the items agree through every door: minting, renaming,
     crossing out, finishing elsewhere, undoing, removing a line, placing an
     action on a planned day, and a field that was a round trip behind.
"""

import os
import sys
import tempfile
from datetime import date as date_cls, timedelta

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
check('a * line is a task in the block above it', items[1]['notes'] == ['Send task assignments email']
      and items[1]['tasks'] == [{'text': 'Send task assignments email', 'id': None, 'struck': False, 'line': 3}],
      items[1]['tasks'])
nest = items[3]
check('indented lines nest, inheriting the category',
      [k['title'] for k in nest['kids']] == ['A3', 'Meeting with Angelina Ji']
      and all(k['cat'] == 'COS333' for k in nest['kids']))
check('the parent stretches to cover its children', (nest['start'], nest['end']) == (930, 1050))
check('a parent with no title is called by its category', day_plan.label_of(nest) == 'COS333')
check('@ names a place apart from the title', items[4]['title'] == 'Eat dinner' and items[4]['loc'] == 'Quad')
check('an unreadable line is reported with its number',
      P['skipped'] == [{'n': 10, 'text': 'what is this'}], P['skipped'])
check('blank text is no plan', day_plan.parse('  \n') == {'items': [], 'frames': [], 'skipped': []})
zero = day_plan.parse('0-1:30 Sleep\n13-14 Lunch')['items']
check('hour 0 is midnight and an hour over 12 is 24-hour',
      [(i['start'], i['end']) for i in zero] == [(0, 90), (780, 840)], zero)

# Crossed out with ~~ … ~~: on one line, across lines, a parent and its kids.
X = day_plan.parse('''8-9 Gym
~~9-10 COS333: Problem set~~
* a note under a crossed block
~~10-11 Lunch
11-12 Walk~~
1-2 ENT200:
  1-2 Write
  ~~2-3 Read~~
~~4-6 Club:
  4-5 Meet
  * agenda~~
7-8 Dinner ~~with Sam~~
~~not a time line~~
9-10 Open ~~ended''')
xi = X['items']
check('a line wrapped in ~~ is crossed out, its times still read',
      [(i['title'] or i['cat'], i['struck']) for i in xi] ==
      [('Gym', False), ('Problem set', True), ('Lunch', True), ('Walk', True),
       ('ENT200', False), ('Club', True), ('Dinner', False), ('Open ~~ended', False)], xi)
check('a ~~ spanning lines crosses out each of them', xi[2]['struck'] and xi[3]['struck'])
check('a crossed-out block keeps its times', (xi[1]['start'], xi[1]['end']) == (540, 600), xi[1])
check('a task under a crossed block is crossed too', xi[1]['notes'] == []
      and [t['struck'] for t in xi[1]['tasks']] == [True], xi[1])
ent = xi[4]
check('a crossed-out child is crossed; its sibling is not',
      [(k['title'], k['struck']) for k in ent['kids']] == [('Write', False), ('Read', True)], ent['kids'])
check('a parent stretches only over the children it still draws',
      (ent['start'], ent['end']) == (780, 840), (ent['start'], ent['end']))
check('crossing out a parent crosses out what is nested in it', all(k['struck'] for k in xi[5]['kids']))
check('struck words inside a kept line are dropped from it', xi[6]['title'] == 'Dinner', xi[6])
check('a crossed-out line that is not a block is not reported as skipped', X['skipped'] == [], X['skipped'])
check('an unclosed ~~ is only text', xi[7]['title'] == 'Open ~~ended' and not xi[7]['struck'])

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
check('carrying its * lines as tasks, each with an id written in',
      [t['text'] for t in ps['tasks']] == ['start with Q3'] and ps['tasks'][0]['id'], ps['tasks'])
check('a known place is the location, not the title',
      plan[1]['label'] == 'Lunch' and plan[1]['location_id'], plan[1])
check('an unknown category files under nothing, in a colour of its own',
      plan[2]['area_id'] is None and plan[2]['color'] == storage._hash_color('ENT200'), plan[2])
check('a plan is no weekly and no one-off block', all(s['block_id'] is None and s['day_block_id'] is None
                                                     for s in plan))
check('a plan replaces the day: no weekly block and no one-off is in force on it',
      all(s.get('plan_date') for s in segs), segs)
check('nothing but the text is stored', storage.get_conn().execute(
    'SELECT COUNT(*) FROM day_block').fetchone()[0] == 1)
check('the calendar read carries the plan', client.get(
    f'/api/calendar/days?from={day}&to={day}').get_json()[day]['plan']['body'].startswith('9-10'))

client.put(f'/api/day-plan/{day}', json={'body': '~~10-11 Errands~~\n'
                                                  '3-4 ENT200:\n'
                                                  '  3-4 Write\n'
                                                  '  ~~4-5 Read~~'})
segs = storage.block_segments_for(day)
check('a crossed-out block draws nothing', not any(s['label'] == 'Errands' for s in segs), segs)
ent = [s for s in segs if s.get('plan_date') == day]
check('the parent draws with the child it keeps, without the crossed one',
      [(s['start'], s['end'], [k['label'] for k in s['kids']]) for s in ent] == [(900, 960, ['Write'])], ent)

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
check('every timed event of a planned day is covered; an all-day one is not',
      covered() == {'Gym': True, 'Office hours': True, 'Holiday': False}, covered())
check('the calendar read serves the flag', all('plan_covered' in e for e in client.get('/api/gcal').get_json()))
panel = [r['label'] for r in storage.get_engage_day()['rows'] if r['kind'] == 'event']
check("the NOW panel's day skips the covered events", panel == [], panel)
client.put(f'/api/day-plan/{day}', json={'body': '~~9-10 COS333: Problem set~~'})
check('a crossed-out block still hides the event under it', covered()['Gym'] is True, covered())
client.put(f'/api/day-plan/{day}', json={'body': ''})
check('clearing the plan uncovers it', not any(covered().values()), covered())

# ── 4. the route ──
check('a bad date is refused', client.put('/api/day-plan/today', json={'body': 'x'}).status_code == 400)
check('a body that is not text is refused', client.put(f'/api/day-plan/{day}', json={}).status_code == 400)

# ── 5. the grammar's new lines: frames, any depth, the colour rule ──
G = day_plan.parse('''7:30-9. CWR201: Library
  7:30-7:40. Walk to Firestone
  7:40-9. Find book, read
    7:40-8:15. Find book
    8:15-9. Read
2-3. Later
3:45-6. @ STOKES.
* bring the badge [1f]
~~4-5. @ GONE.~~''')
lib = G['items'][0]
check('nesting goes to any depth, each level its parent category',
      [k['title'] for k in lib['kids'][1]['kids']] == ['Find book', 'Read']
      and lib['kids'][1]['kids'][1]['cat'] == 'CWR201', lib)
check('an @ PLACE. line is a frame, read as daytime, carrying its tasks',
      [(f['label'], f['start'], f['end'], [t['id'] for t in f['tasks']]) for f in G['frames']]
      == [('STOKES', 945, 1080, [0x1f])], G['frames'])
check('a frame takes no hours and moves no reading', [i['title'] for i in G['items']] == ['Library', 'Later']
      and G['items'][1]['start'] == 840, G['items'])
check('a struck task line, its words and its id',
      day_plan.parse('9-10 X\n* ~~Submit~~ [2b2]')['items'][0]['tasks']
      == [{'text': 'Submit', 'id': 0x2b2, 'struck': True, 'line': 2}])
groups = ([('COS333', '#4f7394'), ('Wind down', '#827dc8')], [('Stokes Schedule', '#c8aa64')])
check('a name wears the block or area its words name', storage._name_color(groups, 'COS333') == '#4f7394')
check('...else a calendar sharing a word (filler words skipped)',
      storage._name_color(groups, '@ STOKES') == '#c8aa64'
      and storage._name_color(groups, 'the schedule') == storage._hash_color('the schedule'))
check('...else its own pastel, the same every time',
      storage._name_color(groups, 'ENT200') == storage._hash_color('ENT200') == storage._hash_color('ent200'))
check('no category is neutral grey', storage._name_color(groups, '') == storage.PLAN_NO_CATEGORY)

# ── 6. a plan's tasks ARE the to-do items ──
# Tomorrow, so the gate line below has not opened yet whatever the clock says.
day = (date_cls.today() + timedelta(days=1)).isoformat()


def item(i):
    r = storage.get_conn().execute('SELECT * FROM inbox_item WHERE id = ?', (i,)).fetchone()
    return dict(r) if r else None


def placed(i):
    return [(p['minute'], p['anchor']) for p in storage.get_engage_placements(day) if p['item_id'] == i]


def put(body, base=None):
    j = {'body': body}
    if base is not None:
        j['base'] = base
    return client.put(f'/api/day-plan/{day}', json=j).get_json()


def ids_of(body):
    return [t['id'] for t in day_plan.tasks_of(body)[0]]


p = put('12:40-2. COS333: A4\n  * Finish Q3\n  * x\n!3-3:10 Photo\n* photo of Q3\n5-6. Rest')
q3 = ids_of(p['body'])[0]
check('a new task line is minted an item, its id written onto the line',
      f'* Finish Q3 [{q3:x}]' in p['body'] and item(q3)['content'] == 'Finish Q3'
      and item(q3)['status'] == 'active', p['body'])
check('...filed under the area its category names, placed at its line', item(q3)['area_id'] == area_id
      and placed(q3) == [(760, 'plan')], (item(q3), placed(q3)))
check('a one-letter task is not minted yet', '* x\n' in p['body'] + '\n', p['body'])
photo = ids_of(p['body'])[2]   # [Finish Q3, x (no id yet), photo of Q3]
check("a gate's * line is a to-do too, placed at the gate's line",
      item(photo) and item(photo)["content"] == "photo of Q3" and placed(photo) == [(900, "plan")], (item(photo), placed(photo)))
check("...and its id is not part of what the gate is judged on",
      day_plan.gate_lines(p['body'])[(900, 910)]['task'] == 'Photo\n- photo of Q3', day_plan.gate_lines(p['body']))
body = p['body']
p = put(body.replace('Finish Q3', 'Finish Q3 and Q4'))
check('a line reworded rewords its item', item(q3)['content'] == 'Finish Q3 and Q4', item(q3))
storage.update_inbox_item(q3, content='Q3, Q4')
check('an item reworded elsewhere rewords its line',
      f'* Q3, Q4 [{q3:x}]' in storage.get_day_plan(day)['body'], storage.get_day_plan(day)['body'])
body = storage.get_day_plan(day)['body']
snap = storage.get_inbox_snapshot(q3)
p = put(body.replace('* Q3, Q4', '* ~~Q3, Q4~~'))
check('crossing a line out finishes its item', item(q3) is None and '~~Q3, Q4~~' in p['body'], p['body'])
storage.restore_inbox_item(snap)
check("the finish's undo puts the item back and uncrosses its line",
      item(q3) and f'* Q3, Q4 [{q3:x}]' in storage.get_day_plan(day)['body'], storage.get_day_plan(day)['body'])
storage.delete_inbox_item(q3)
body = storage.get_day_plan(day)['body']
check('finished anywhere else, its line is crossed out', '~~Q3, Q4~~' in body, body)
p = put(body.replace('~~Q3, Q4~~', 'Q3, Q4'), base=body)
check('uncrossing it by hand brings the item back under its id',
      item(q3) and item(q3)['content'] == 'Q3, Q4' and placed(q3) == [(760, 'plan')], (item(q3), p['body']))
stale = p['body'].replace('~~', '')
storage.delete_inbox_item(q3)
p = put(p['body'].replace('Q3, Q4', 'Q3, Q4'), base=p['body'])
check('a field that never saw the finish cannot undo it', item(q3) is None
      and '~~Q3, Q4~~' in p['body'], p['body'])

p = put('9-10. COS333: Set\n  * Read the spec')
spec = ids_of(p['body'])[0]
p2 = put('9-10. COS333: Set\n  * Read the spec\n  * Write tests', base='9-10. COS333: Set\n  * Read the spec')
check('a field a round trip behind is matched back by its words, not minted twice',
      ids_of(p2['body'])[0] == spec and storage.get_conn().execute(
          "SELECT COUNT(*) FROM inbox_item WHERE content = 'Read the spec'").fetchone()[0] == 1, p2['body'])
tests = ids_of(p2['body'])[1]
p3 = put('9-10. COS333: Set', base=p2['body'])
check('a line removed takes its item off the day, and the item stays',
      placed(tests) == [] and item(tests) and item(tests)['status'] == 'active', placed(tests))

conn = storage.get_conn()
conn.execute('INSERT INTO recurring_block (label, color, day_of_week, start_time, end_time) '
             "VALUES ('ENT200', '#c8828c', ?, '16:30', '19:00')", (date_cls.fromisoformat(day).weekday(),))
conn.commit()
conn.close()
p = put('3:45-4:45. Meet\n4:45-7. ENT200: Readings')
read = storage.create_inbox_item('Do ENT200 reading', 'active')['id']
storage.set_engage_placement(day, read, 990)      # on the ENT200 block, 16:30
body = storage.get_day_plan(day)['body']
check('an action placed on the day is written under the plan line of its block',
      body == f'3:45-4:45. Meet\n4:45-7. ENT200: Readings\n  * Do ENT200 reading [{read:x}]'
      and placed(read) == [(1005, 'plan')], (body, placed(read)))
p = put('3:45-4:45. Meet\n4:45-7. ENT200: Readings', base='3:45-4:45. Meet\n4:45-7. ENT200: Readings')
check('a field that never saw it does not take it off the day',
      f'[{read:x}]' in p['body'] and placed(read), p['body'])
storage.delete_engage_placement(day, read)
check('taken off the day elsewhere, its line goes', f'[{read:x}]' not in storage.get_day_plan(day)['body'])

p = put('3:45-6. @ STOKES.\n* bring the badge')
fr = p['frames'][0]
badge = ids_of(p['body'])[0]
check('a frame is served with its tasks, minted like any other',
      fr['label'] == 'STOKES' and fr['tasks'][0]['id'] == badge and placed(badge) == [(945, 'plan')], p)
put('')
check('clearing the plan takes its tasks off the day, and keeps them', placed(badge) == [] and item(badge))

# ── 7. the day beneath a plan, served while it is written ──
p = put('3:45-4:45. Meet')
rows = client.get(f'/api/calendar/days?from={day}&to={day}').get_json()[day]
check('a planned day serves the day it replaced, beside its own blocks',
      [s['label'] for s in rows['beneath']] == ['ENT200']
      and all(s.get('plan_date') for s in rows['segments']), rows)
put('')
check('an unplanned day has nothing beneath it',
      'beneath' not in client.get(f'/api/calendar/days?from={day}&to={day}').get_json()[day])

# ── 8. a gate's tasks under its lock (its window opened at midnight today) ──
today = date_cls.today().isoformat()
storage.set_day_plan(today, '!0-0:10 Photo of the set\n* Q1\n* Q2')
body = storage.get_day_plan(today)['body']
q1, q2 = ids_of(body)
r = client.put(f'/api/day-plan/{today}', json={'body': body.replace('* Q1', '* ~~Q1~~'), 'base': body})
check('a task under an open gate may be crossed out — done is not a change to the gate',
      r.status_code == 200 and item(q1) is None, r.get_json())
body = r.get_json()['body']
r = client.put(f'/api/day-plan/{today}', json={'body': body.replace('* Q2', '* Q2 and Q3'), 'base': body})
check('...but not reworded: the lock still holds the text', r.status_code == 409 and item(q2)['content'] == 'Q2', r.get_json())
storage.update_inbox_item(q2, content='Q2, all parts')
r = client.put(f'/api/day-plan/{today}', json={'body': body, 'base': body})
check('reworded through its item, a field that never saw it is not refused: the item wins',
      r.status_code == 200 and f'* Q2, all parts [{q2:x}]' in r.get_json()['body'], r.get_json())
r = client.put(f'/api/day-plan/{today}', json={'body': '', 'base': body})
check('and a base cannot talk the lock out of removing the gate', r.status_code == 409, r.get_json())

print()
print(f'{len(fails)} FAILED' if fails else 'All checks passed.')
sys.exit(1 if fails else 0)
