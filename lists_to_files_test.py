"""Lists are a file system. Run: python lists_to_files_test.py

Three kinds of row in one tree (ref_list.kind): a DIRECTORY holds directories,
lists and documents; a LIST holds checkable items; a DOCUMENT holds a title and
a body. The root is the home directory. What is under test:

  * the one-time migration: a list that held lists becomes a directory, and
    if it also held items they move into a list of the same name inside it —
    nothing lost, nothing renamed — and it never runs twice;
  * only a directory holds anything: no list or document as a parent, no
    item in a directory or a document, no directory moved inside itself;
  * clarify's append adds a paragraph to the END of a document, and only a
    document can be appended to;
  * deleting a directory splices what it held up a level, never takes it.
"""
import os
import sys
import tempfile

os.chdir(tempfile.mkdtemp(prefix='qpa-files-'))

import storage

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


def rows():
    return {l['id']: l for l in storage.get_ref_lists()}


storage.init_db()

# ── the migration: build the old shape by hand, then re-run it ─────
conn = storage.get_conn()
mixed = conn.execute("INSERT INTO ref_list (name) VALUES ('Weekly review')").lastrowid
conn.execute("INSERT INTO ref_list (name, parent_id) VALUES ('Get clear', ?)", (mixed,))
conn.execute("INSERT INTO ref_item (list_id, content) VALUES (?, 'empty the inbox')", (mixed,))
folder = conn.execute("INSERT INTO ref_list (name) VALUES ('Books')").lastrowid
conn.execute("INSERT INTO ref_list (name, parent_id) VALUES ('to read', ?)", (folder,))
leaf = conn.execute("INSERT INTO ref_list (name) VALUES ('Groceries')").lastrowid
conn.execute("INSERT INTO ref_item (list_id, content) VALUES (?, 'milk')", (leaf,))
conn.execute("DELETE FROM setting WHERE key = 'lists_to_files'")
conn.commit()
storage._lists_to_files(conn)
conn.close()

r = rows()
check('a list that held lists and items is a directory', r[mixed]['kind'] == 'dir', r[mixed])
kept = [l for l in r.values() if l['parent_id'] == mixed and l['name'] == 'Weekly review']
check('its items moved into a list of the same name inside it',
      len(kept) == 1 and kept[0]['kind'] == 'list'
      and [i['content'] for i in kept[0]['items']] == ['empty the inbox'], kept)
check('the directory holds no items itself', r[mixed]['items'] == [])
check('a list that held only lists is a directory, with nothing added',
      r[folder]['kind'] == 'dir' and len([l for l in r.values() if l['parent_id'] == folder]) == 1)
check('a plain list is untouched', r[leaf]['kind'] == 'list' and len(r[leaf]['items']) == 1)

conn = storage.get_conn()
storage._lists_to_files(conn)
conn.close()
check('the migration runs once', len(rows()) == len(r))

# ── only a directory holds anything ──────────────────────────────
doc = storage.create_ref_list('Dune notes', folder, 'doc', 'first thoughts')
check('a document can live in a directory', doc['kind'] == 'doc' and doc['parent_id'] == folder)
check('nothing goes inside a list', refused(storage.create_ref_list, 'x', leaf))
check('nothing goes inside a document', refused(storage.create_ref_list, 'x', doc['id'], 'list'))
check('a directory takes no items', refused(storage.create_ref_item, folder, 'x'))
check('a document takes no items', refused(storage.create_ref_item, doc['id'], 'x'))
check('an unknown kind is refused', refused(storage.create_ref_list, 'x', None, 'folder'))
inner = storage.create_ref_list('Sci-fi', folder, 'dir')
check('a directory cannot move inside itself',
      refused(storage.update_ref_list, folder, parent_id=folder))
check('nor inside its own descendant',
      refused(storage.update_ref_list, folder, parent_id=inner['id']))
moved = storage.update_ref_list(doc['id'], parent_id=inner['id'])
check('a document can move between directories', moved['parent_id'] == inner['id'])
check('a list cannot be given a body', storage.update_ref_list(leaf, body='x')['body'] == '')

# ── appending to a document ──────────────────────────────────────
out = storage.append_ref_doc(doc['id'], 'the spice is a metaphor')
check('append adds a paragraph at the end',
      out['body'] == 'first thoughts\n\nthe spice is a metaphor', out['body'])
empty = storage.create_ref_list('Empty doc', None, 'doc')
check('appending to an empty document adds no blank lead',
      storage.append_ref_doc(empty['id'], 'one')['body'] == 'one')
check('only a document can be appended to', refused(storage.append_ref_doc, leaf, 'x'))

# ── delete splices up ────────────────────────────────────────────
storage.delete_ref_list(inner['id'])
check('deleting a directory keeps what it held, one level up',
      rows()[doc['id']]['parent_id'] == folder)

print('\n'.join(ok + bad))
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
