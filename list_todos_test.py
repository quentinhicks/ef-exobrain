"""A list's items are to-dos. Run: python list_todos_test.py

2026-11-19, Quentin's instruction: "make the list items checkboxes (same data
type as to-do list)". A list's items are inbox_item rows with list_id set,
drawn with the to-do list's box. What is under test:

  * the one-time migration: each open ref_item is an active to-do in its list,
    in the list's order; a ticked one stays in ref_item (it has no to-do to
    become); it runs once;
  * a to-do in a list is on neither the to-do list nor Projects, and comes
    back to both the moment it leaves the list — or its list is gone;
  * only a list holds to-dos, and never a project;
  * one place keeps a row out of two homes: a list takes it out of a project
    and off Projects, and filing it under a project or onto Projects takes it
    out of the list;
  * deleting a list takes its to-dos, and restoring a snapshot puts one back.
"""
import os
import sys
import tempfile
from datetime import date as date_cls

os.chdir(tempfile.mkdtemp(prefix='qpa-list-todos-'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage  # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def refused(fn, *a, **k):
    try:
        fn(*a, **k)
    except ValueError as e:
        return str(e)
    return None


def lists():
    return {l['id']: l for l in storage.get_ref_lists()}


def pool_ids():
    return {i['id'] for i in storage.get_active_items_all()}


def map_ids():
    return {i['id'] for i in storage.get_map_items()}


storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())
check('a fresh database records the migration', bool(storage.get_settings().get('ref_items_to_todos')))

# ── the migration: the old shape by hand, then run it again ──────
conn = storage.get_conn()
groceries = conn.execute("INSERT INTO ref_list (name, kind) VALUES ('Groceries', 'list')").lastrowid
books = conn.execute("INSERT INTO ref_list (name, kind) VALUES ('Books', 'list')").lastrowid
for pos, (lid, text, done) in enumerate((
        (groceries, 'milk', 0), (groceries, 'eggs', 0), (books, 'Dune', 1), (books, 'Emma', 0),
        (groceries, 'bread', 0)), start=1):
    conn.execute('INSERT INTO ref_item (list_id, content, done, position) VALUES (?, ?, ?, ?)',
                 (lid, text, done, pos))
conn.execute("DELETE FROM setting WHERE key = 'ref_items_to_todos'")
conn.commit()
storage._ref_items_to_todos(conn)
conn.close()

r = lists()
check("each open item is a to-do in its list, in the list's order",
      [i['content'] for i in r[groceries]['items']] == ['milk', 'eggs', 'bread'],
      [i['content'] for i in r[groceries]['items']])
check('...an active action, nothing else decided',
      all(i['status'] == 'active' and i['kind'] == 'item' and i['list_id'] == groceries
          for i in r[groceries]['items']))
check('a ticked item has no to-do to become', [i['content'] for i in r[books]['items']] == ['Emma'])
conn = storage.get_conn()
left = [dict(x) for x in conn.execute('SELECT content, done FROM ref_item ORDER BY id')]
conn.close()
check('...and stays in ref_item, dormant; the moved ones are gone from it',
      left == [{'content': 'Dune', 'done': 1}], left)
conn = storage.get_conn()
storage._ref_items_to_todos(conn)
conn.close()
check('the migration runs once', len(lists()[groceries]['items']) == 3)

# ── off the to-do list and Projects ──────────────────────────────
milk = r[groceries]['items'][0]['id']
check('a list to-do is not in the pool', milk not in pool_ids())
check('...nor on Projects', milk not in map_ids())
loose = storage.create_inbox_item('call the bank', 'active')
check('an ordinary action still is in both', loose['id'] in pool_ids() and loose['id'] in map_ids())

# ── only a list, never a project ─────────────────────────────────
folder = storage.create_ref_list('Reading', None, 'dir')
doc = storage.create_ref_list('Notes', None, 'doc')
check('a directory holds no to-dos', refused(storage.update_inbox_item, loose['id'], list_id=folder['id']))
check('nor a document', refused(storage.update_inbox_item, loose['id'], list_id=doc['id']))
check('nor a list that does not exist', refused(storage.create_inbox_item, 'x', list_id=99999))
proj = storage.create_project('Move flat')
check('a project cannot go in a list',
      refused(storage.update_inbox_item, proj['id'], list_id=groceries))

# ── one row, one home ────────────────────────────────────────────
child = storage.create_inbox_item('pack books', 'active', project_id=proj['id'])
sent = storage.update_inbox_item(loose['id'], on_projects=1)
moved = storage.update_inbox_item(child['id'], list_id=groceries)
check('going into a list takes it out of its project',
      moved['list_id'] == groceries and moved['project_id'] is None, moved)
moved = storage.update_inbox_item(sent['id'], list_id=groceries)
check('...and off Projects', moved['on_projects'] == 0 and moved['list_id'] == groceries, moved)
back = storage.update_inbox_item(child['id'], project_id=proj['id'])
check('filing it under a project takes it out of the list',
      back['list_id'] is None and back['project_id'] == proj['id'], back)
back = storage.update_inbox_item(sent['id'], on_projects=1)
check('...and so does sending it to Projects', back['list_id'] is None and back['id'] in map_ids(), back)
out = storage.update_inbox_item(milk, list_id=None)
check('out of the list it is on the to-do list again', out['list_id'] is None and milk in pool_ids())
storage.update_inbox_item(milk, list_id=groceries)
created = storage.create_inbox_item('butter', None, project_id=proj['id'], list_id=groceries)
check('a to-do added in a list is active and in no project',
      created['status'] == 'active' and created['project_id'] is None and created['list_id'] == groceries,
      created)

# ── a dangling list_id is in no list ─────────────────────────────
conn = storage.get_conn()
stray = conn.execute("INSERT INTO inbox_item (content, status, list_id) VALUES ('stray', 'active', 99999)").lastrowid
conn.commit()
conn.close()
check('a to-do whose list is gone is back on the to-do list', stray in pool_ids())

# ── delete and restore ───────────────────────────────────────────
eggs = [i for i in lists()[groceries]['items'] if i['content'] == 'eggs'][0]['id']
snap = storage.get_inbox_snapshot(eggs)
storage.delete_ref_list(groceries)
conn = storage.get_conn()
n = conn.execute('SELECT COUNT(*) AS n FROM inbox_item WHERE list_id = ?', (groceries,)).fetchone()['n']
conn.close()
check('deleting a list takes its to-dos', n == 0, n)
again = storage.create_ref_list('Groceries', None, 'list')
snap['row']['list_id'] = again['id']
storage.restore_inbox_item(snap)
check('a snapshot puts one back, same id, in the list it is given',
      [i['id'] for i in lists()[again['id']]['items']] == [eggs])

print('\n'.join(ok + bad))
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
