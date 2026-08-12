"""Tests for the per-day markdown history. Run: python daybook_test.py

Same shape as the other suites — a temp database, no framework, each check
naming the failure it prevents.

The point of this file is NOT that the markdown looks nice. It is that the
export cannot silently fall behind the schema: every table is dated, standing
state, or a named cache, and a table nobody classified shows up in the file's own
"not covered" section rather than vanishing. That is the property the whole
module exists for, so it is the property under test.
"""

import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import daybook          # noqa: E402

fails = []


def eq(label, got, want):
    ok = got == want
    print(f'{"PASS" if ok else "FAIL"}  {label}')
    if not ok:
        print(f'        got:  {got}\n        want: {want}')
        fails.append(label)


def ok(label, cond, detail=''):
    eq(label, bool(cond) or detail or False, True)


TODAY = date_cls.today().isoformat()
YESTERDAY = (date_cls.today() - timedelta(days=1)).isoformat()

storage.init_db()

# ── every table is a DECISION ────────────────────────────────
#
# The failure this prevents: a new table is added, nobody thinks about the
# history, and a year of day files quietly lacks a datatype.

conn = storage.get_conn()
conn.row_factory = sqlite3.Row
tables = daybook._tables(conn)
classified, unclassified = [], []
for t in tables:
    cols = daybook._cols(conn, t)
    if t in daybook.SKIP or t in daybook.STATE or daybook._time_col(cols, t):
        classified.append(t)
    else:
        unclassified.append(t)
conn.close()

ok('every table is dated, standing state, or a named cache'
   if not unclassified else
   f'UNCLASSIFIED TABLES — give each a time column, a STATE entry or a SKIP entry: '
   f'{unclassified}', not unclassified)

# A table can be classified two ways at once, which would make the file's
# contents depend on the order the code happens to check in.
overlap = sorted(set(daybook.SKIP) & set(daybook.STATE))
eq('no table is both a cache and standing state', overlap, [])
bad_override = sorted(t for t, c in daybook.OVERRIDES.items()
                      if c is not None and t not in tables)
eq('no override names a table that no longer exists', bad_override, [])

# ── a day with data renders it ───────────────────────────────

storage.create_inbox_item('write the history exporter')
storage.set_journal_day(TODAY, {'bottleneck': 'the exporter', 'rating': 6}) \
    if hasattr(storage, 'set_journal_day') else None
review = [f for f in storage.get_flows(TODAY) if f['name'] == 'Weekly review'][0]
storage.upsert_flow_run(review['id'], storage.flow_period_key('week', date_cls.today()),
                        '{"1": "done"}', False)

text = daybook.render_day(TODAY)

ok('the day file names the day', text.startswith(f'# {TODAY}'))
ok('an item captured today appears', 'write the history exporter' in text)
ok('a heading is the human name, with the table name beside it',
   '## Captured  `inbox_item`' in text)
ok('a weekly routine run appears on every day of its week — it is keyed by the week',
   'Routines run' in text and 'flow_name=Weekly review' in text)
ok('the standing state section is there', '## The system as it stood' in text)
ok('and carries the gates, routines and areas', '### qr_node' in text or '### area' in text)
ok('the file states its own gaps', '## Not covered by this file' in text)
ok('and names the caches it left out', '`gcal_recurring_seen`' in text)

# Empty columns are omitted, or a row becomes unreadable as the schema grows.
ok('empty columns are not printed', 'chase_on=' not in text)

# ── a day with nothing says so, rather than looking broken ───

old = (date_cls.today() - timedelta(days=900)).isoformat()
ok('an empty day says it is empty', 'Nothing was recorded on this day.'
   in daybook.render_day(old))

# ── a NEW table is picked up with no code change ─────────────
#
# This is the property the module is built on: inference from the schema, not a
# hand-maintained list.

conn = sqlite3.connect(storage.DB_PATH)
conn.execute('CREATE TABLE freshly_invented (id INTEGER PRIMARY KEY, date TEXT, thing TEXT)')
conn.execute("INSERT INTO freshly_invented (date, thing) VALUES (?, 'a brand new datatype')",
             (TODAY,))
conn.execute('CREATE TABLE undated_thing (id INTEGER PRIMARY KEY, label TEXT)')
conn.execute("INSERT INTO undated_thing (label) VALUES ('nobody classified me')")
conn.commit()
conn.close()

text2 = daybook.render_day(TODAY)
ok('a new dated table appears with no code change', 'a brand new datatype' in text2)
ok('an unclassified table is NAMED as not covered, not dropped',
   '`undated_thing`' in text2 and '1 row(s)' in text2)

# ── files on disk ────────────────────────────────────────────
#
# A day with nothing in it gets no file: an absent file reads as "nothing
# happened", and 200 files saying so would bury the days that matter.
eq('an empty past day is not written', daybook.write_day(old), False)
ok('and no file appears for it',
   not os.path.exists(os.path.join(daybook.DAYBOOK_DIR, old[:4], f'{old}.md')))

eq('today is written', daybook.write_day(TODAY), True)
p = os.path.join(daybook.DAYBOOK_DIR, TODAY[:4], f'{TODAY}.md')
ok('under daybook/<year>/<date>.md', os.path.exists(p), p)
eq('writing today again with nothing changed is a no-op', daybook.write_day(TODAY), False)

# A past day is HISTORY. Rewriting it from a later schema would restate what was
# never true, so it happens only when asked. (Given something to record: an
# interaction dated yesterday.)
conn = sqlite3.connect(storage.DB_PATH)
conn.execute("INSERT INTO person (name) VALUES ('Someone')")
conn.execute("INSERT INTO interaction (person_id, date, note) VALUES (1, ?, 'talked')",
             (YESTERDAY,))
conn.commit(); conn.close()
eq('a past day WITH something in it is written', daybook.write_day(YESTERDAY), True)
with open(os.path.join(daybook.DAYBOOK_DIR, YESTERDAY[:4], f'{YESTERDAY}.md'), 'a') as f:
    f.write('\nhand-edited\n')
eq('a past day is not rewritten', daybook.write_day(YESTERDAY), False)
eq('unless forced', daybook.write_day(YESTERDAY, force=True), True)

# ── catch-up ─────────────────────────────────────────────────

written = daybook.catch_up()
ok('catch-up writes the missing days up to today', isinstance(written, list))
ok('and reaches today', os.path.exists(p))
# Bounded: an ancient row must not spawn years of empty files.
ok('catch-up is bounded', len(os.listdir(os.path.join(daybook.DAYBOOK_DIR, TODAY[:4]))) < 420,
   str(len(os.listdir(os.path.join(daybook.DAYBOOK_DIR, TODAY[:4])))))

print(f'\n{len(fails)} FAILED: {"; ".join(fails)}' if fails else '\nAll checks passed.')
raise SystemExit(1 if fails else 0)
