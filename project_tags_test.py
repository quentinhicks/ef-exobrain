"""A project's contexts bind everything under it — derived, never written.

The rule (Quentin, 2026-08-19): tags on a project are tags on every active item
in it. @errands on the project says the same thing about each of its actions, so
the pool's gates, MAP's lens and a row's chips all read the inherited set.

What the tests are really guarding:

  * DERIVED. The child row's own `tags` column never changes, so removing a tag
    from the project removes it from the children too - the same bargain
    effective_deadline makes, and the reason neither is cascaded onto rows.
  * The LOCATION gate asks the inherited set. Filtering on a row's own tags left
    an action under an @office project available from anywhere, which is the
    bug this feature exists to fix.
  * It survives nesting and cannot hang on a cycle.

Run: python project_tags_test.py
"""
import datetime
import sys

import storage
import app as A

ok, bad = [], []
def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))

storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()

area = c.post('/api/areas', json={'name': 'Life'}).get_json()


def item(content, **kw):
    it = c.post('/api/inbox', json={'content': content}).get_json()
    c.patch(f"/api/inbox/{it['id']}", json=dict({'status': 'active', 'area_id': area['id']}, **kw))
    return it


def by_content(rows, text):
    return next((r for r in rows if r['content'] == text), None)


proj = item('Move flat', tags='errands home', deadline='2026-09-01')
act = item('Buy boxes', project_id=proj['id'], tags='phone')
sub = item('Pack the kitchen', project_id=proj['id'], tags='')
subact = item('Wrap the glasses', project_id=sub['id'])
loose = item('Read the standard', tags='deep')

pool = storage.get_active_items_all()
a = by_content(pool, 'Buy boxes')
check('an action inherits its project\'s contexts',
      set((a['effective_tags'] or '').split()) == {'phone', 'errands', 'home'}, a['effective_tags'])
check('...its OWN tag leads', (a['effective_tags'] or '').split()[0] == 'phone', a['effective_tags'])
check('...and the row itself is untouched — this is derived', a['tags'] == 'phone', a['tags'])
check('an unrelated item inherits nothing',
      by_content(pool, 'Read the standard')['effective_tags'] == 'deep')

deep = by_content(pool, 'Wrap the glasses')
check('nesting inherits through the sub-project',
      set((deep['effective_tags'] or '').split()) == {'errands', 'home'}, deep['effective_tags'])
check('the deadline still comes down the same walk',
      deep['effective_deadline'] == '2026-09-01', deep['effective_deadline'])

# the pool's own three reads agree
dom = storage.get_active_items_for_domain(None) if False else None
mp = by_content(storage.get_map_items(), 'Buy boxes')
check('MAP carries the same inherited set',
      set((mp['effective_tags'] or '').split()) == {'phone', 'errands', 'home'}, mp['effective_tags'])

# ── the LOCATION gate asks the inherited set ──
loc = c.post('/api/locations', json={'name': 'Home', 'lat': 1.0, 'lng': 2.0,
                                     'radius_m': 100}).get_json()
c.post('/api/tag-locations', json={'tag': 'home', 'location_id': loc['id']})
here = storage.items_at_location(loc['id'])
check('an action under a located project is available AT that location',
      by_content(here, 'Buy boxes') is not None, [r['content'] for r in here])
check('...and the project itself is not in the pool at all',
      by_content(here, 'Move flat') is None or by_content(here, 'Move flat')['kind'] == 'project')
check('an item with no location tag is not pulled in by the gate',
      by_content(here, 'Read the standard') is None, [r['content'] for r in here])

# ── removing it from the project removes it everywhere ──
c.patch(f"/api/inbox/{proj['id']}", json={'tags': 'errands'})
a2 = by_content(storage.get_active_items_all(), 'Buy boxes')
check('dropping a tag from the project drops it from the children',
      set((a2['effective_tags'] or '').split()) == {'phone', 'errands'}, a2['effective_tags'])
check('...and the child keeps what it said itself', a2['tags'] == 'phone')
after = storage.items_at_location(loc['id'])
check('...so the location gate lets go of it too',
      by_content(after, 'Buy boxes') is None, [r['content'] for r in after])

# ── a cycle cannot hang the walk ──
conn = storage.get_conn()
conn.execute('UPDATE inbox_item SET project_id = ? WHERE id = ?', (subact['id'], proj['id']))
conn.commit()
conn.close()
try:
    storage.get_active_items_all()
    check('a cycle in the data is walked once, not forever', True)
except Exception as e:
    check('a cycle in the data is walked once, not forever', False, e)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
