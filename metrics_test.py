"""Self-monitoring metrics: definitions, the twice-a-day ask, and the hard rule.

The load-bearing case is that ONE metric can be asked by a morning step AND a
night step on the same date. That is why metric_step is a join and why an entry
is keyed by (date, metric, STEP) - without the step in the key the night answer
lands on the morning row and silently overwrites it.

The other rule under test: no row means NO DATA, never zero. Clearing an answer
deletes the row rather than writing a 0, because a false zero lies in exactly
the direction that ruins a trend.
"""
import sys
import datetime
import storage
import app as A

ok, bad = [], []
def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))

storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()
TODAY = datetime.date.today().isoformat()
YDAY = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

# two routines: morning and night, each with a metrics step
mf = c.post('/api/flows', json={'name': 'Morning'}).get_json()
nf = c.post('/api/flows', json={'name': 'Night'}).get_json()
ms = c.post(f"/api/flows/{mf['id']}/steps", json={'content': 'metrics', 'kind': 'metrics'}).get_json()
ns = c.post(f"/api/flows/{nf['id']}/steps", json={'content': 'metrics', 'kind': 'metrics'}).get_json()

# ── the four shapes ──
mood = c.post('/api/metrics', json={'name': 'Mood', 'kind': 'scale', 'scale_min': 1, 'scale_max': 7,
                                    'step_ids': [ms['id'], ns['id']]}).get_json()
cups = c.post('/api/metrics', json={'name': 'Coffees', 'kind': 'count', 'unit': 'cups',
                                    'step_ids': [ns['id']]}).get_json()
lift = c.post('/api/metrics', json={'name': 'Trained', 'kind': 'yesno',
                                    'step_ids': [ns['id']]}).get_json()
note = c.post('/api/metrics', json={'name': 'One line', 'kind': 'text',
                                    'step_ids': [ns['id']]}).get_json()
check('a metric is created', mood['id'] and mood['kind'] == 'scale', mood)
check('an unknown kind falls back to scale',
      c.post('/api/metrics', json={'name': 'X', 'kind': 'nonsense'}).get_json()['kind'] == 'scale')
check('a blank name is refused', c.post('/api/metrics', json={'name': '  '}).status_code == 400)

# ── THE schema-deciding one: asked twice a day ──
check('Mood is asked by BOTH steps', sorted(mood['step_ids']) == sorted([ms['id'], ns['id']]), mood['step_ids'])
morning = c.get(f"/api/metrics/step/{ms['id']}?date={TODAY}").get_json()
night = c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()
check('the morning step asks only Mood', [m['name'] for m in morning['metrics']] == ['Mood'],
      [m['name'] for m in morning['metrics']])
check('the night step asks all four',
      [m['name'] for m in night['metrics']] == ['Mood', 'Coffees', 'Trained', 'One line'],
      [m['name'] for m in night['metrics']])

c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': mood['id'], 'step_id': ms['id'], 'value': 3})
c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': mood['id'], 'step_id': ns['id'], 'value': 6})
m_am = c.get(f"/api/metrics/step/{ms['id']}?date={TODAY}").get_json()['metrics'][0]['entry']
m_pm = [m for m in c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()['metrics']
        if m['name'] == 'Mood'][0]['entry']
check('the morning answer is 3', m_am['value_num'] == 3, m_am)
check('the night answer is 6 and did NOT overwrite it', m_pm['value_num'] == 6, m_pm)
check('they are two distinct rows', m_am['id'] != m_pm['id'])

# ── no answer means NO DATA, never zero ──
n = c.get(f"/api/metrics/step/{ns['id']}?date={YDAY}").get_json()
check('an unanswered day has no entries', all(m['entry'] is None for m in n['metrics']))
check('...and is not complete', n['complete'] is False)
c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': mood['id'], 'step_id': ms['id'], 'value': None})
check('clearing removes the row, not sets zero',
      c.get(f"/api/metrics/step/{ms['id']}?date={TODAY}").get_json()['metrics'][0]['entry'] is None)

# ── the hard-step rule: complete only when every asked metric is answered ──
check('night is not complete yet', c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()['complete'] is False)
c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': cups['id'], 'step_id': ns['id'], 'value': 2})
c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': lift['id'], 'step_id': ns['id'], 'value': True})
check('still not complete with one missing',
      c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()['complete'] is False)
r = c.put('/api/metrics/entry', json={'date': TODAY, 'metric_id': note['id'], 'step_id': ns['id'],
                                      'value': 'shipped the metrics feature'}).get_json()
check('complete once every one is answered', r['complete'] is True, r)

# values land in the right column
nm = {m['name']: m for m in c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()['metrics']}
check('count stores a number', nm['Coffees']['entry']['value_num'] == 2)
check('yes/no stores 1', nm['Trained']['entry']['value_num'] == 1)
check('text stores text, not a number', nm['One line']['entry']['value_text'] == 'shipped the metrics feature'
      and nm['One line']['entry']['value_num'] is None, nm['One line']['entry'])
check('a step that asks NOTHING is not satisfied by asking nothing',
      storage.metrics_step_complete(99999, TODAY) is False)

# ── pausing keeps history, stops the asking ──
c.patch(f"/api/metrics/{cups['id']}", json={'active': False})
after = c.get(f"/api/metrics/step/{ns['id']}?date={TODAY}").get_json()
check('a paused metric is no longer asked', 'Coffees' not in [m['name'] for m in after['metrics']],
      [m['name'] for m in after['metrics']])
check('its past answer still exists',
      len(c.get(f"/api/metrics/{cups['id']}/history").get_json()) == 1)
check('and the step can still complete without it', after['complete'] is True)

# ── history ──
c.put('/api/metrics/entry', json={'date': YDAY, 'metric_id': mood['id'], 'step_id': ns['id'], 'value': 4})
h = c.get(f"/api/metrics/{mood['id']}/history").get_json()
check('history returns both days', len(h) == 2, h)
check('history is in date order', [x['date'] for x in h] == [YDAY, TODAY], h)

# ── delete removes the question AND its unreadable answers ──
c.delete(f"/api/metrics/{note['id']}")
check('the metric is gone', all(m['name'] != 'One line' for m in c.get('/api/metrics').get_json()))
check('its entries went with it', c.get(f"/api/metrics/{note['id']}/history").get_json() == [])

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
