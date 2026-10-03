"""The week and the day are two stores. Run: python day_block_test.py

GLOBAL is recurring_block — weekdays, and changes dated forward. LOCAL is a
date: block_override (a weekly block's one day) and day_block (a block that
exists on one date only). What this file holds (2026-10-03, Quentin's
instruction: "do NOT mix the two"):

  1. A day block is drawn on its date and nowhere else, by the one resolution
     every surface reads (block_segments_for) — overnight tail included.
  2. Writing one never touches the week, and writing the week never touches
     one: the Block Editor's list is unchanged, and a weekly edit leaves the
     day block where it was.
  3. A write naming the wrong half is REFUSED, not ignored: a date on a weekly
     route, a weekday or an effective_from on a day-block route.
  4. The assistant may write day blocks (the planning skill's whole job), and
     only through the routes that say they are local.
"""

import os
import sys
import tempfile
from datetime import date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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


# A Tuesday far enough out that nothing else lands on it.
D = date_cls.today() + timedelta(days=14)
D = D + timedelta(days=(1 - D.weekday()) % 7)
DAY, NEXT = D.isoformat(), (D + timedelta(days=1)).isoformat()
PREV = (D - timedelta(days=1)).isoformat()

week = client.post('/api/blocks', json={
    'label': 'Class', 'color': '#98b9dd', 'days': [D.weekday()],
    'start_time': '09:00', 'end_time': '11:00'}).get_json()
week_before = client.get('/api/blocks').get_json()

# ── 1. drawn on its date, by the one resolution ──────────────
r = client.post('/api/day-blocks', json={
    'date': DAY, 'start_min': 14 * 60, 'end_min': 17 * 60,
    'label': 'COS330', 'color': '#a3d9a5'})
check('a day block is created', r.status_code == 201, r.get_json())
db = r.get_json()

segs = storage.block_segments_for(DAY)
mine = [s for s in segs if s.get('day_block_id') == db['id']]
check('it is in force on its date', len(mine) == 1 and mine[0]['start'] == 840
      and mine[0]['end'] == 1020, segs)
check('it carries no weekly block id', mine and mine[0]['block_id'] is None, mine)
check('the weekly block is still there beside it',
      any(s['block_id'] == week[0]['id'] for s in segs), segs)
check('it is not in force a week later',
      not any(s.get('day_block_id') for s in storage.block_segments_for(
          (D + timedelta(days=7)).isoformat())))

late = client.post('/api/day-blocks', json={
    'date': DAY, 'start_min': 23 * 60, 'end_min': 25 * 60,
    'label': 'Late', 'color': '#a3d9a5'}).get_json()
tail = [s for s in storage.block_segments_for(NEXT) if s.get('day_block_id') == late['id']]
check('one past midnight continues into the next day at a negative start',
      len(tail) == 1 and tail[0]['start'] == -60 and tail[0]['end'] == 60, tail)
check('...and not into the day before',
      not any(s.get('day_block_id') == late['id'] for s in storage.block_segments_for(PREV)))

# ── 2. neither half writes the other ─────────────────────────
check('adding day blocks leaves the weekly schedule unchanged',
      client.get('/api/blocks').get_json() == week_before)

r = client.patch(f'/api/day-blocks/{db["id"]}', json={'start_min': 15 * 60, 'end_min': 18 * 60})
check('moving a day block moves the row', r.status_code == 200
      and r.get_json()['start_min'] == 900, r.get_json())
check('...and still leaves the week alone', client.get('/api/blocks').get_json() == week_before)

b = week[0]
client.patch(f'/api/blocks/{b["id"]}', json={
    'label': 'Class', 'color': '#98b9dd', 'day_of_week': b['day_of_week'],
    'start_time': '08:00', 'end_time': '10:00'})
check('a weekly edit leaves the day block where it was',
      storage.get_day_block(db['id'])['start_min'] == 900)

r = client.get(f'/api/day-blocks?from={DAY}&to={NEXT}')
check('the range read returns the day blocks', r.status_code == 200
      and {x['id'] for x in r.get_json()} == {db['id'], late['id']}, r.get_json())

# ── 3. the wrong half is refused, not ignored ────────────────
r = client.post('/api/blocks', json={'label': 'X', 'color': '#98b9dd', 'days': [0],
                                     'start_time': '12:00', 'end_time': '13:00', 'date': DAY})
check('a date on a weekly POST is refused', r.status_code == 400, r.get_json())
r = client.patch(f'/api/blocks/{b["id"]}', json={'date': DAY, 'start_time': '08:00'})
check('a date on a weekly PATCH is refused', r.status_code == 400, r.get_json())
check('...and nothing was written', len(client.get('/api/blocks').get_json()) == 1)
for bad in ({'days': [1]}, {'day_of_week': 1}, {'effective_from': NEXT}):
    r = client.post('/api/day-blocks', json=dict(bad, date=DAY, start_min=600, end_min=660,
                                                 label='Y', color='#a3d9a5'))
    check(f'{list(bad)[0]} on a day-block POST is refused', r.status_code == 400, r.get_json())
    r = client.patch(f'/api/day-blocks/{db["id"]}', json=bad)
    check(f'{list(bad)[0]} on a day-block PATCH is refused', r.status_code == 400, r.get_json())
r = client.post('/api/day-blocks', json={'start_min': 600, 'end_min': 660,
                                         'label': 'Y', 'color': '#a3d9a5'})
check('a day block without a date is refused (a write names its day)', r.status_code == 400)

# ── filing and deletion ──────────────────────────────────────
area = storage.create_area('COS330', 'project')
client.patch(f'/api/day-blocks/{db["id"]}', json={'area_id': area['id']})
storage.delete_area(area['id'])
check('deleting its area unfiles the day block rather than orphaning it',
      storage.get_day_block(db['id'])['area_id'] is None)

r = client.delete(f'/api/day-blocks/{db["id"]}')
check('a day block deletes', r.status_code == 204 and storage.get_day_block(db['id']) is None)
r = client.post('/api/day-blocks', json={'id': db['id'], 'date': DAY, 'start_min': 900,
                                         'end_min': 1080, 'label': 'COS330',
                                         'color': '#a3d9a5'})
check('an undo restores it under its ORIGINAL id', r.status_code == 201
      and r.get_json()['id'] == db['id'], r.get_json())

# ── 4. the assistant's scope ─────────────────────────────────
H = {'X-QPA-Actor': 'assistant', 'X-QPA-Reason': 'test'}
r = client.post('/api/day-blocks', headers=H, json={
    'date': DAY, 'start_min': 600, 'end_min': 720, 'label': 'COS330', 'color': '#a3d9a5'})
check('the assistant may add a day block', r.status_code == 201, r.get_json())
r = client.patch(f'/api/day-blocks/{r.get_json()["id"]}', headers=H,
                 json={'start_min': 630, 'end_min': 750})
check('...move one', r.status_code == 200, r.get_json())
r = client.post('/api/day-blocks', headers=H, json={
    'id': 999, 'date': DAY, 'start_min': 600, 'end_min': 720, 'label': 'x', 'color': '#a3d9a5'})
check('...but not replay an id (that is the undo\'s door, not a plan\'s)', r.status_code == 403)
changes = storage.get_assistant_changes()
check('the assistant\'s day-block writes are logged',
      any('/api/day-blocks' in c['path'] for c in changes), changes[:2])

print()
if fails:
    print(f'{len(fails)} FAILED')
    sys.exit(1)
print('All checks passed.')
