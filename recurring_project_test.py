"""A recurring thing can be a PROJECT. Run: python recurring_project_test.py

The case is taxes: it comes back every year, it is an OUTCOME rather than one
action, and its two dates are different — the day it makes sense to START (the
forms are all in by 31 January) and the day it is DUE (15 April). A recurring
action could carry only one of them.

What is under test is that this reuses what already exists rather than growing
a second scheduler beside it:

  * ONE table (recurring_task) and ONE due predicate (_recurring_due), with
    `spawn` saying what the occurrence IS. Yearly is spelled "every 12 months",
    which that predicate already answers.
  * `deadline_md` resolved to a real date at seed time, forward only — a
    deadline behind the thing it belongs to is not a deadline.
  * The seeded row is a `kind = 'project'` inbox_item, so MAP's project lens and
    the weekly review's "every project has a next action" pick it up with no
    query anywhere knowing where it came from.
  * The one-live-at-a-time guard still holds: last year's taxes still open means
    this year does not seed a second one.
"""
import datetime
import os
import sys
import tempfile

# The data dir IS the working directory (see app.py), so a scratch one is how a
# suite gets its own database instead of writing into the repo.
os.chdir(tempfile.mkdtemp(prefix='qpa-recur-'))

import storage

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def at(y, m, d):
    """storage reads the clock through date_cls.today(), so a subclass with a
    fixed today() is how a February is tested in August."""
    real = datetime.date

    class Frozen(real):
        @classmethod
        def today(cls):
            return real(y, m, d)
    storage.date_cls = Frozen


storage.init_db()
real_date = datetime.date

# ── the example, seeded once ──────────────────────────────────
tasks = storage.get_recurring_tasks()
tax = [t for t in tasks if t['name'] == 'Pay my taxes']
check('the taxes example is seeded', len(tax) == 1, tasks)
t = tax[0] if tax else {}
check('as a PROJECT, not an action', t.get('spawn') == 'project', t.get('spawn'))
check('yearly, in the grammar the table already had',
      t.get('kind') == 'monthly_date' and t.get('interval') == 12, t)
check('starting 1 February, and never a February already gone',
      (t.get('anchor_date') or '').endswith('-02-01')
      and t['anchor_date'] >= real_date.today().isoformat(), t.get('anchor_date'))
check('due on US tax day', t.get('deadline_md') == '04-15', t.get('deadline_md'))
check('and it starts life with its support material',
      '31 January' in (t.get('notes') or ''), t.get('notes'))

storage.set_setting('tax_project_seeded', None)   # the marker is the only guard
storage.init_db()
again = [x for x in storage.get_recurring_tasks() if x['name'] == 'Pay my taxes']
check('clearing the marker is what lets it seed again (so never clear it)',
      len(again) == 2, len(again))
storage.delete_recurring_task(again[-1]['id'])

# ── the deadline resolves forward, never backward ─────────────
check('read in February, tax day is this year',
      storage._md_on_or_after('04-15', real_date(2027, 2, 1)) == '2027-04-15')
check('read in May, it is next year',
      storage._md_on_or_after('04-15', real_date(2027, 5, 1)) == '2028-04-15')
check('read ON the day, it is today — the deadline has not passed yet',
      storage._md_on_or_after('04-15', real_date(2027, 4, 15)) == '2027-04-15')
check('29 February lands on 1 March in a year without one',
      storage._md_on_or_after('02-29', real_date(2027, 1, 1)) == '2027-03-01',
      storage._md_on_or_after('02-29', real_date(2027, 1, 1)))
check('no rule, no deadline', storage._md_on_or_after(None, real_date(2027, 1, 1)) is None)
check('a malformed rule is no deadline, not a crash',
      storage._md_on_or_after('April', real_date(2027, 1, 1)) is None)

# ── the due predicate, unchanged and doing the yearly work ────
task = dict(t)
check('due on 1 February 2027', storage._recurring_due(task, real_date(2027, 2, 1)))
check('not on 2 February', not storage._recurring_due(task, real_date(2027, 2, 2)))
check('not in March', not storage._recurring_due(task, real_date(2027, 3, 1)))
check('due again a year later', storage._recurring_due(task, real_date(2028, 2, 1)))
check('and not six months in between',
      not storage._recurring_due(task, real_date(2027, 8, 1)))

# ── seeding on the day ────────────────────────────────────────
at(2027, 2, 1)
storage.seed_recurring_tasks()
rows = [i for i in storage.get_map_items() if i['content'] == 'Pay my taxes']
check('one occurrence is seeded on the day', len(rows) == 1, rows)
row = rows[0] if rows else {}
check('and it is a PROJECT', row.get('kind') == 'project', row.get('kind'))
check('due on tax day of that year', row.get('deadline') == '2027-04-15', row.get('deadline'))
check('carrying the template notes', '31 January' in (row.get('notes') or ''))
check('and filed under the template that made it',
      row.get('recurring_task_id') == t['id'], row.get('recurring_task_id'))

# a project is what MAP's project lens shows and what the review asks about
counts = storage.get_gtd_review_counts()
names = [p['content'] for p in (counts.get('project_list') or [])]
check('the weekly review asks it for a next action', 'Pay my taxes' in names, names)

# ── one live at a time ────────────────────────────────────────
at(2028, 2, 1)
storage.seed_recurring_tasks()
rows = [i for i in storage.get_map_items() if i['content'] == 'Pay my taxes']
check('last year still open means this year does not seed a second one',
      len(rows) == 1, len(rows))

storage.delete_inbox_item(rows[0]['id'])
at(2029, 2, 1)
storage.seed_recurring_tasks()
rows = [i for i in storage.get_map_items() if i['content'] == 'Pay my taxes']
check('once it is finished, the next year seeds again', len(rows) == 1, len(rows))
check('with that year\'s deadline',
      rows and rows[0].get('deadline') == '2029-04-15',
      rows and rows[0].get('deadline'))

# ── an ACTION template is untouched by any of this ────────────
area = [a for a in storage.get_areas() if a['active']][0]
act = storage.create_recurring_task('Water the plants', area['id'], 'weekly', '0',
                                    None, None, 1, '2029-02-01')
check('a recurring task still defaults to seeding an action',
      act['spawn'] == 'item' and act['deadline_md'] is None, act)
at(2029, 2, 5)                      # a Monday
storage.seed_recurring_tasks()
plants = [i for i in storage.get_map_items() if i['content'] == 'Water the plants']
check('and seeds one', len(plants) == 1, plants)
check('as an action with no deadline',
      plants and plants[0]['kind'] != 'project' and not plants[0].get('deadline'), plants)

# ── the editor saves everything it edits ──────────────────────
saved = storage.update_recurring_task(act['id'], name='Water the plants twice',
                                      spawn='project', deadline_md='12-24',
                                      notes='in the sink', interval=2, active=0)
check('one update writes wording, spawn, deadline rule, notes, schedule and state',
      (saved['name'] == 'Water the plants twice' and saved['spawn'] == 'project'
       and saved['deadline_md'] == '12-24' and saved['notes'] == 'in the sink'
       and saved['interval'] == 2 and saved['active'] == 0), saved)
untouched = storage.update_recurring_task(act['id'], notes='just notes')
check('and a field left out of the call is left alone',
      untouched['name'] == 'Water the plants twice' and untouched['notes'] == 'just notes',
      untouched)

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
