"""The experiment lifecycle: one runs at a time, and ENDING one is one act.

Three things are under test, all of them shapes that used to be wrong:

1. A GUARDED WRITE REPORTS THE GUARD. resolve/rename only fire while the
   experiment is 'running' and both used to answer with a fresh SELECT of the
   row - which exists either way, so an UPDATE that matched nothing came back
   200 with the untouched row. Ending one from Tracking and then pressing
   "End it" on a runner page painted before that read as success and pushed an
   undo that would have reopened something it never ended.

2. THE RESOLUTION IS EVIDENCE, so a blank one is refused. The weekly review
   judges that line; "resolved: -" is the one thing its queue cannot act on.

3. ENDING ONE AND STARTING TOMORROW'S IS ONE ACT (Quentin, 2026-08-19). One
   runs at a time, so the next can only begin once this one is closed - which
   is why the ordering is the server's, in the same PATCH, and why the DAY both
   halves are stamped with is the one the surface sends: a night finished at
   00:20 resolves the night it ran, and its successor starts that same day.

The retired schema is checked here too: `experiment` / monthly_experiment_verdict
(title / hypothesis / prediction, judged by a monthly-review UI that no longer
exists) were a SECOND store for the same question, and the drop is recorded in
a setting rather than done silently.
"""
import sys
import datetime
import storage
import app as A

ok, bad = [], []
def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))

storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()
TODAY = datetime.date.today().isoformat()
NIGHT = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

# ── the retired schema ──
tables = {r[0] for r in storage.get_conn().execute(
    "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
check('the operating-experiment table is gone', 'experiment' not in tables)
check('...and the monthly verdicts that judged it', 'monthly_experiment_verdict' not in tables)
check('...and the drop is RECORDED, not silent',
      bool(storage.get_settings().get('operating_experiments_retired')),
      storage.get_settings().get('operating_experiments_retired'))
check('its routes are gone too', c.get('/api/experiments').status_code == 404)
check('habit_experiment is the one that stayed', 'habit_experiment' in tables)

# ── one at a time ──
one = c.post('/api/habit-experiments', json={'content': 'coffee before 10'}).get_json()
check('an experiment starts', one.get('status') == 'running', one)
check('a second one is refused while it runs',
      c.post('/api/habit-experiments', json={'content': 'no phone in bed'}).status_code == 409)
check('a blank name is refused',
      c.post('/api/habit-experiments', json={'content': '  '}).status_code == 400)

# ── the guard, not the row ──
check('an empty resolution is refused',
      c.patch(f"/api/habit-experiments/{one['id']}", json={'resolution': '   '}).status_code == 400)
check('...and refusing it left the experiment running',
      c.get('/api/habits').get_json()['experiments']['running']['id'] == one['id'])

r = c.patch(f"/api/habit-experiments/{one['id']}",
            json={'resolution': 'slept better, kept it', 'date': NIGHT})
check('ending it resolves it', r.status_code == 200 and r.get_json()['status'] == 'resolved',
      r.get_json())
check('...on the day the SURFACE sent, not the clock',
      r.get_json()['resolved_on'] == NIGHT, r.get_json()['resolved_on'])
again = c.patch(f"/api/habit-experiments/{one['id']}", json={'resolution': 'again'})
check('ending it a SECOND time is refused, not reported as success',
      again.status_code == 409, (again.status_code, again.get_json()))
check('...and the first resolution is untouched',
      c.get('/api/habits').get_json()['experiments']['awaiting'][0]['resolution']
      == 'slept better, kept it')
rename = c.patch(f"/api/habit-experiments/{one['id']}", json={'content': 'reworded'})
check('rewording a resolved one is refused the same way', rename.status_code == 409,
      rename.status_code)
check('...so the thing the review is about to judge still says what it said',
      c.get('/api/habits').get_json()['experiments']['awaiting'][0]['content']
      == 'coffee before 10')

# ── ending one and starting the next, in one act ──
two = c.post('/api/habit-experiments', json={'content': 'walk after lunch'}).get_json()
end = c.patch(f"/api/habit-experiments/{two['id']}",
              json={'resolution': 'made no difference', 'outcome': 'drop',
                    'next': 'phone out of the bedroom', 'date': NIGHT})
body = end.get_json()
check('dropping evaluates it there and then, no review queue',
      body['status'] == 'evaluated' and body['outcome'] == 'drop', body)
nxt = body.get('next_experiment')
check('the next experiment comes back with it', bool(nxt and nxt['id']), nxt)
check('...running', nxt and nxt['status'] == 'running')
check('...started on the day that was sent, not the clock',
      nxt and nxt['started_on'] == NIGHT, nxt and nxt['started_on'])
check('...and it IS the running one now',
      c.get('/api/habits').get_json()['experiments']['running']['id'] == nxt['id'])
check('a dropped one never reaches the review queue',
      two['id'] not in {e['id'] for e in c.get('/api/habits').get_json()['experiments']['awaiting']})

# ── the undo half: close the new one first, then reopen ──
check('reopening the old one is refused while the new one runs',
      c.post(f"/api/habit-experiments/{two['id']}/reopen").status_code == 409)
c.patch(f"/api/habit-experiments/{nxt['id']}", json={'resolution': 'undone', 'outcome': 'drop'})
back = c.post(f"/api/habit-experiments/{two['id']}/reopen")
check('...and allowed once it is closed', back.status_code == 200, back.status_code)
check('reopening wipes the resolution it was ended with',
      back.get_json()['status'] == 'running' and not back.get_json()['resolution'],
      back.get_json())

# ── a resolution the review can act on ──
c.patch(f"/api/habit-experiments/{two['id']}", json={'resolution': 'worth keeping', 'date': TODAY})
promoted = c.patch(f"/api/habit-experiments/{two['id']}", json={'outcome': 'habit'}).get_json()
check('the review can promote it to a habit', bool(promoted.get('habit')), promoted)
check('...and only one promotion a week',
      c.post('/api/habit-experiments', json={'content': 'third'}).status_code == 201
      and c.patch(
          f"/api/habit-experiments/"
          f"{c.get('/api/habits').get_json()['experiments']['running']['id']}",
          json={'resolution': 'also good'}).status_code == 200
      and c.patch(
          f"/api/habit-experiments/"
          f"{c.get('/api/habits').get_json()['experiments']['awaiting'][0]['id']}",
          json={'outcome': 'habit'}).status_code == 409)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
