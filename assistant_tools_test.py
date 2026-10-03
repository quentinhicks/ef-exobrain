"""The assistant's tools write what they say and nothing else. Run: python assistant_tools_test.py

mcp/blocks_mcp.py (2026-09-30, Quentin's instruction: "a tool such that AI
could edit my weekly block schedule") drives the app's own routes with every
write marked `X-QPA-Actor: assistant`. This drives each of its tools through
the REAL routes and the REAL allowlist (app.ASSISTANT_WRITES) against a temp
database — the HTTP hop is replaced by Flask's test client, nothing else — and
checks the scope still refuses what it should: a marked write outside the
allowlist is a 403, and every marked write is logged.

Same shape as the other suites: a temp database, no framework.
"""

import json
import os
import sys
import tempfile
import urllib.parse
from datetime import date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'mcp'))

import storage          # noqa: E402

storage.init_db()
# Importing app starts the backup thread; a stamped date keeps it from firing.
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app              # noqa: E402
import blocks_mcp       # noqa: E402
import gates_mcp        # noqa: E402

client = app.app.test_client()
fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}')
    if not cond:
        print(f'        got: {got}')
        fails.append(label)


# The HTTP hop, and only that: same headers, same refusal shape, the test
# client instead of urllib.
def fake_call(method, path, body=None, reason=None):
    headers = {}
    if method != 'GET':
        headers['X-QPA-Actor'] = 'assistant'
        headers['X-QPA-Reason'] = urllib.parse.quote(reason or '', safe=' ')
    r = client.open(path, method=method, json=body, headers=headers)
    if r.status_code >= 400:
        raise gates_mcp.ToolError(f'the app refused it ({r.status_code}): '
                                  f'{(r.get_json(silent=True) or {}).get("error")}')
    return r.get_json(silent=True) or {}


blocks_mcp.call = fake_call
T = lambda name, **a: blocks_mcp.TOOLS[name][0](a)
week = lambda: {b['block_id']: b for b in T('week_list')['week']}
future = (date_cls.today() + timedelta(days=7))
FUT = future.isoformat()
dow = lambda d: blocks_mcp.DAYS[d.weekday()]

# ── the week ──────────────────────────────────────────────────
out = T('week_add_block', label='Deep work', days=['mo', 'we', 'fr'], start='09:00', end='12:00',
        reason='a morning of focus')
ids = out['block_ids']
check('add_block makes one row per weekday', len(ids) == 3, out)
w = week()
check('...each on its own day',
      sorted(w[i]['day'] for i in ids) == ['fr', 'mo', 'we'], [w[i]['day'] for i in ids])
check('...and list_blocks reads them back', all(w[i]['start'] == '09:00' for i in ids), w)
try:
    T('week_add_block', label='Clash', days=['mo'], start='10:00', end='11:00', reason='x')
    check('an overlapping block is refused', False)
except gates_mcp.ToolError as e:
    check('an overlapping block is refused, in the app\'s words', 'Overlaps' in str(e), e)

mo = next(i for i in ids if w[i]['day'] == 'mo')
T('week_update_block', block_id=mo, start='08:30', reason='earlier start')
b = week()[mo]
check('update_block changes only what it was given',
      (b['start'], b['end'], b['label'], b['day']) == ('08:30', '12:00', 'Deep work', 'mo'), b)
T('week_update_block', block_id=mo, day='tu', reason='move it')
check('...including the day', week()[mo]['day'] == 'tu', week()[mo])

T('week_update_block', block_id=mo, end='13:00', effective_from=FUT, reason='longer from next week')
b = week()[mo]
check('a dated change leaves today alone', b['end'] == '12:00', b)
check('...and is listed as scheduled',
      any(c['field'] == 'end_time' and c['from_day'] == FUT for c in b.get('scheduled_changes', [])),
      b.get('scheduled_changes'))
T('week_cancel_scheduled_change', block_id=mo, field='end_time', reason='never mind')
check('cancel_scheduled_change calls it off', not week()[mo].get('scheduled_changes'),
      week()[mo].get('scheduled_changes'))

T('week_set_active', block_id=mo, active=False, reason='pause')
check('set_block_active pauses', week()[mo]['active'] is False, week()[mo])
T('week_set_active', block_id=mo, active=True, reason='resume')
check('...and resumes', week()[mo]['active'] is True, week()[mo])

# ── one day ───────────────────────────────────────────────────
we = next(i for i in ids if w[i]['day'] == 'we')
day = future
while dow(day) != 'we':
    day += timedelta(days=1)
D = day.isoformat()
seg = lambda: next(s for s in T('days_view', **{'from': D})['days'][0]['blocks']
                   if s.get('block_id') == we)
T('day_set_block_hours', block_id=we, date=D, start='14:00', end='16:00', reason='afternoon only')
check('set_day_hours moves that date', (seg()['start'], seg()['end']) == ('14:00', '16:00'), seg())
check('...and not the week', week()[we]['start'] == '09:00', week()[we])
T('day_cancel_block', block_id=we, date=D, reason='holiday')
check('cancel_day cancels that date', seg()['cancelled'] is True, seg())
T('day_restore_block', block_id=we, date=D, reason='back on')
check('restore_day puts the week back',
      (seg()['cancelled'], seg()['start'], seg()['changed_for_this_day']) == (False, '09:00', False), seg())

# ── a block for one date (the LOCAL store) ────────────────────
week_before = client.get('/api/blocks').get_json()
view = lambda: T('days_view', **{'from': D})['days'][0]
out = T('day_add_block', date=D, label='Deep work', start='13:00', end='15:00', reason='exam push')
dbid = out['day_block_id']
mine = [b for b in view()['blocks'] if b.get('day_block_id') == dbid]
check('day_add_block puts a block on that date', len(mine) == 1 and mine[0]['kind'] == 'day'
      and (mine[0]['start'], mine[0]['end']) == ('13:00', '15:00'), view())
check('...borrowing the weekly colour of the same label',
      client.get(f'/api/day-blocks?from={D}').get_json()[0]['color']
      == next(b for b in week_before if b['label'] == 'Deep work')['color'])
check('...and leaves the week exactly as it was', client.get('/api/blocks').get_json() == week_before)
check('...and is counted apart from the weekly hours',
      T('days_view', **{'from': D})['hours_by_label']['Deep work'] == {'weekly': 3.0, 'day_only': 2.0,
                                                                     'total': 5.0},
      T('days_view', **{'from': D})['hours_by_label'])
check('free gaps leave out what the blocks cover',
      not any(g.startswith('13:00') or g.startswith('09:00') for g in view()['free']), view()['free'])
try:
    T('day_add_block', date=D, label='Clash', start='10:00', end='11:00', reason='x')
    check('a day block over a weekly one is refused', False)
except gates_mcp.ToolError as e:
    check('a day block over a weekly one is refused, naming what it hits', 'Deep work' in str(e), e)
T('day_add_block', date=D, label='Clash', start='10:00', end='11:00', allow_overlap=True,
  reason='agreed double-booking')
check('...unless the overlap is accepted',
      any(b['label'] == 'Clash' for b in view()['blocks']), view())
T('day_update_block', day_block_id=dbid, start='15:00', end='17:30', reason='later')
mine = next(b for b in view()['blocks'] if b.get('day_block_id') == dbid)
check('day_update_block moves it', (mine['start'], mine['end']) == ('15:00', '17:30'), mine)
T('day_remove_block', day_block_id=dbid, reason='done early')
check('day_remove_block removes it', not any(b.get('day_block_id') == dbid
                                             for b in view()['blocks']))
check('...and the week was never touched', client.get('/api/blocks').get_json() == week_before)
check('every tool says which half it writes',
      all(desc.startswith(('GLOBAL', 'LOCAL')) for n, (_, desc, _, _) in blocks_mcp.TOOLS.items()
          if n.startswith(('week_add', 'week_update', 'week_set', 'week_delete', 'day_'))))

T('week_delete_block', block_id=we, reason='drop wednesdays')
check('delete_block deletes one weekday', we not in week() and mo in week(), list(week()))

# ── the scope ─────────────────────────────────────────────────
for label, method, path, body in [
    ('an inbox write', 'POST', '/api/inbox', {'content': 'x'}),
    ('a gate\'s stake', 'PATCH', '/api/accountability/nodes/1', {'charge_cents': 0}),
    ('an unknown block field', 'PATCH', f'/api/blocks/{mo}', {'label': 'x', 'secret': 1}),
    ('a setting', 'PATCH', '/api/settings', {'theme': 'light'}),
]:
    r = client.open(path, method=method, json=body, headers={'X-QPA-Actor': 'assistant'})
    check(f'the assistant is refused {label}', r.status_code == 403, r.status_code)

log = client.get('/api/assistant/changes').get_json()
check('every marked write is logged, refusals included',
      any(e.get('status') == 403 or e.get('status_code') == 403 for e in log)
      and any('/api/blocks' in (e.get('path') or '') for e in log), json.dumps(log[:2]))
check('...with the reason given',
      any((e.get('reason') or '') == 'a morning of focus' for e in log), [e.get('reason') for e in log][:5])

# ── the shared plumbing ───────────────────────────────────────
listed = gates_mcp.handle({'id': 1, 'method': 'tools/list'}, blocks_mcp.TOOLS, 'qpa-blocks')
check('the block server lists its own tools',
      {t['name'] for t in listed['tools']} == set(blocks_mcp.TOOLS), listed)
init = gates_mcp.handle({'id': 1, 'method': 'initialize', 'params': {}}, blocks_mcp.TOOLS, 'qpa-blocks')
check('...under its own name', init['serverInfo']['name'] == 'qpa-blocks', init)
check('the gate server still lists only gate tools',
      {t['name'] for t in gates_mcp.handle({'id': 1, 'method': 'tools/list'})['tools']}
      == set(gates_mcp.TOOLS))

print()
if fails:
    print(f'{len(fails)} failure(s)')
    sys.exit(1)
print('The assistant\'s tools write what they say, and nothing else.')
