"""Routines became lists. Run: python routines_to_lists_test.py

2026-10-05, Quentin's instruction: "make routines into normal lists and then
remove code surrounding dynamic execution". storage._routines_to_lists turns
every routine into a reference list, ONCE:

  1. a routine is a ref_list of the same name, its steps the items in order;
  2. a `header` step opens a CHILD list (parent_id) holding the steps after it;
  3. a checklist step names the list it pointed at, and a feature step with no
     wording gets a readable label;
  4. a routine that was also a task becomes a weekly recurring_task on the same
     days, and the action it had already seeded is kept and handed to it;
  5. running it again changes nothing (setting.routines_to_lists).
"""

import os
import sys
import tempfile
from datetime import date as date_cls

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


# A routine as the runner left it: a weekly review that was also a Sunday task,
# with a header, a checklist step and a feature step that has no wording.
conn = storage.get_conn()
checklist = conn.execute("INSERT INTO ref_list (name, position) VALUES ('Inboxes', 1)").lastrowid
fid = conn.execute(
    """INSERT INTO flow (name, position, period, as_task, days_of_week)
       VALUES ('Sunday review', 1, 'week', 1, '6')""").lastrowid
for pos, (kind, content, ref) in enumerate((
        ('text', 'Collect loose papers', checklist),
        ('header', 'Get current', None),
        ('review_in_zero', 'Get "in" to empty', None),
        ('metrics', '', None),
        ('header', 'Get creative', None),
        ('text', 'Be courageous', None)), start=1):
    conn.execute('''INSERT INTO flow_step (flow_id, position, kind, content, ref_list_id)
                    VALUES (?, ?, ?, ?, ?)''', (fid, pos, kind, content, ref))
seeded = conn.execute(
    """INSERT INTO inbox_item (content, status, kind, flow_id)
       VALUES ('Sunday review', 'active', 'item', ?)""", (fid,)).lastrowid
conn.execute("DELETE FROM setting WHERE key = 'routines_to_lists'")
conn.commit()
storage._routines_to_lists(conn)
conn.close()


def snapshot():
    c = storage.get_conn()
    out = (
        [dict(r) for r in c.execute('SELECT id, name, parent_id FROM ref_list ORDER BY id')],
        [dict(r) for r in c.execute(
            'SELECT list_id, content, position FROM ref_item ORDER BY list_id, position')],
        [dict(r) for r in c.execute('SELECT * FROM recurring_task ORDER BY id')],
    )
    c.close()
    return out


lists, items, tasks = snapshot()
root = [l for l in lists if l['name'] == 'Sunday review' and l['parent_id'] is None]
check('the routine is a list of the same name', len(root) == 1, lists)
root_id = root[0]['id'] if root else None
children = [l for l in lists if l['parent_id'] == root_id]
check('each header is a CHILD list of it, in order',
      [l['name'] for l in children] == ['Get current', 'Get creative'], children)


def items_of(list_id):
    return [i['content'] for i in items if i['list_id'] == list_id]


check('steps before the first header stay on the routine list, and a checklist '
      'step names its list',
      items_of(root_id) == ['Collect loose papers (list: Inboxes)'], items_of(root_id))
check('steps after a header fall into its list, a blank feature step labelled',
      children and items_of(children[0]['id']) == ['Get "in" to empty', 'Metrics'],
      children and items_of(children[0]['id']))
check('...until the next header',
      len(children) > 1 and items_of(children[1]['id']) == ['Be courageous'],
      len(children) > 1 and items_of(children[1]['id']))

task = [t for t in tasks if t['name'] == 'Sunday review']
check('a routine that was a task is a weekly recurring task on the same day',
      len(task) == 1 and task[0]['kind'] == 'weekly' and task[0]['days_of_week'] == '6'
      and task[0]['spawn'] == 'item' and task[0]['active'] == 1, task)
c = storage.get_conn()
item = dict(c.execute('SELECT * FROM inbox_item WHERE id = ?', (seeded,)).fetchone())
c.close()
check('the action it had seeded is kept, handed to that task, its runner link gone',
      item['flow_id'] is None and task and item['recurring_task_id'] == task[0]['id'], item)

storage.seed_recurring_tasks()
c = storage.get_conn()
n = c.execute("SELECT COUNT(*) AS n FROM inbox_item WHERE content = 'Sunday review'"
              " AND status = 'active'").fetchone()['n']
c.close()
check('and seeding the task does not mint a second copy beside it', n == 1, n)

# ONCE. The lists are ordinary editable rows, and one deleted must not grow back.
before = snapshot()
c = storage.get_conn()
storage._routines_to_lists(c)
c.close()
storage.init_db()
check('running it again changes nothing', snapshot() == before)
check('the flag is recorded', bool(storage.get_settings().get('routines_to_lists')),
      storage.get_settings().get('routines_to_lists'))

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
