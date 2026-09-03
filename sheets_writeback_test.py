"""The academic sheet feed, and the tick that goes back to it.
Run: python sheets_writeback_test.py

2026-09-03, Quentin's instruction: rows the sheet marks outstanding
(`G||B&&!BLACK` true, `DONE` false) become real pool items in their own area,
and ticking one off in the app ticks the checkbox in the sheet.

Two halves, and each has a way of being quietly wrong:

  READ    a CSV export has no row numbers, so the app knew WHICH row was
          outstanding and not WHERE it lived. The API read carries
          `row_number`, and it is re-read on every refresh because inserting a
          row in the sheet moves every row below it - a remembered number
          silently addresses a NEIGHBOUR, and ticking the wrong homework off
          looks exactly like success.

  WRITE   ticking is a real mutation of a document the app does not own. It
          goes first and the local delete only follows if it succeeded: the
          other order loses the item on a failed write with nothing left
          pointing at the sheet row, and the app disagrees with its own source
          of truth forever after.

The ledger (`sheets_item_seed`) is what joins them, and it has the classic
ledger failure available to it: re-seeding something the user already finished.
So the third case below is the load-bearing one - a key the sheet still offers
whose ITEM is gone is left alone, occasion_mint's rule.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import aggregator      # noqa: E402
import storage         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


# The two header orders that actually exist in the spreadsheet. Reading by
# POSITION would file the type as the course on one of them and look correct
# on the other, which is the failure that never announces itself.
HDR_A = ['T', 'C', 'DO', 'TITLE', 'TIME', 'DUE', 'DONE', '1ST', 'PAST DUE',
         'BLACK', 'YELLOW', 'GREEN', '#I', 'BLUE', 'BLANK', 'G||B&&!BLACK']
HDR_B = ['C', 'T', 'DO', 'TITLE', 'TIME', 'DUE', 'DONE', '1ST', 'PAST DUE',
         'BLACK', 'YELLOW', 'GREEN', '#I', 'BLUE', 'BLANK', 'G||B&&!BLACK']


def feed(rows, tab='TL26B'):
    """A fetch_sheets_tab result, without the network."""
    return {'rows': rows, 'done_col': 6, 'title_col': 3, 'tab': tab}


def row(n, title, course='M', due='2/15', due_yes=True, done=False):
    return {'row_number': n, 'title': title, 'name': title, 'course': course,
            'due_date': due, 'due_time': None, 'due_yes': due_yes, 'done': done}


def items():
    conn = storage.get_conn()
    out = {r['content']: dict(r) for r in conn.execute(
        "SELECT * FROM inbox_item WHERE status = 'active'").fetchall()}
    conn.close()
    return out


def seeds():
    conn = storage.get_conn()
    out = {r['sheets_key']: dict(r) for r in conn.execute(
        'SELECT * FROM sheets_item_seed').fetchall()}
    conn.close()
    return out


# ── 1. columns are found by NAME, in either order ────────────────────────
a = aggregator.sheets_header_map(HDR_A)
b = aggregator.sheets_header_map(HDR_B)
check('header map: TITLE/DONE/DUE agree across both column orders',
      a['title'] == b['title'] == 3 and a['done'] == b['done'] == 6
      and a['due_date'] == b['due_date'] == 5)
check('header map: the course column tracks C, not position',
      a['course'] == 1 and b['course'] == 0, f'{a["course"]} / {b["course"]}')
check('header map: the G||B&&!BLACK gate column is found',
      a['due_yes'] == 15)
check('header map: whitespace in a retyped header does not break it',
      aggregator.sheets_header_map(['  title ', 'G || B && ! BLACK'])
      == {'title': 0, 'due_yes': 1})

# ── 2. the write ADDRESS: base-26 with no zero digit ─────────────────────
check('col_letter: A/Z/AA/AZ/ZZ/AAA all land right',
      [aggregator.col_letter(i) for i in (0, 25, 26, 51, 701, 702)]
      == ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])

# ── 3. seeding: the sheet's own rule, and the named area ─────────────────
storage.init_db()
conn = storage.get_conn()
dom = conn.execute("INSERT INTO domain (name) VALUES ('Academic')").lastrowid
acad = conn.execute(
    "INSERT INTO area (name, type, domain_id) VALUES ('Academics', 'standard', ?)",
    (dom,)).lastrowid
conn.commit()
conn.close()

res = storage.seed_sheets_items(feed([
    row(4, 'CN 3: Optimization'),
    row(5, 'Skipped: no G||B', due_yes=False),
    row(6, 'Already ticked in the sheet', done=True),
    row(7, 'PS1', course='C', due='2/10'),
]), 'Academics')

live = items()
check('seed: only due_yes AND NOT done rows become items',
      set(live) == {'CN 3: Optimization', 'PS1'}, sorted(live))
check('seed: reports what it did', res['seeded'] == 2, res)
check('seed: they land in the NAMED area, not the default',
      all(i['area_id'] == acad for i in live.values()))
check('seed: they are active items, so the pool can see them',
      all(i['status'] == 'active' and i['kind'] == 'item'
          for i in live.values()))
check('seed: the M/D due date resolves to a real deadline',
      live['PS1']['deadline'] and live['PS1']['deadline'].endswith('-02-10'),
      live['PS1']['deadline'])
check('seed: the ledger remembers the address, not just the fact',
      seeds()['M:CN 3: Optimization:2/15']['row_number'] == 4)

# an unmatched area name falls back rather than filing nowhere
conn = storage.get_conn()
check('area: an unknown name falls back to the default area',
      storage.sheets_area_id(conn, 'Nonexistent') is not None)
check('area: a known name wins', storage.sheets_area_id(conn, 'academics') == acad)
conn.close()

# ── 4. re-seeding is idempotent, and the ADDRESS follows the row ─────────
res = storage.seed_sheets_items(feed([
    row(9, 'CN 3: Optimization'),     # two rows were inserted above it
    row(10, 'PS1', course='C', due='2/10'),
]), 'Academics')
check('re-seed: the same keys do not duplicate',
      len(items()) == 2 and res['seeded'] == 0, res)
check('re-seed: the row number is REFRESHED, not remembered',
      seeds()['M:CN 3: Optimization:2/15']['row_number'] == 9)

# ── 5. the app owns what the sheet has no opinion about ──────────────────
ps1 = items()['PS1']
storage.update_inbox_item(ps1['id'], tags='@desk 30m', notes='ch 4')
storage.seed_sheets_items(feed([
    row(9, 'CN 3: Optimization'),
    row(10, 'PS1', course='C', due='2/10'),
]), 'Academics')
after = items()['PS1']
check('refresh: tags and notes the app added survive a refresh',
      after['tags'] == '@desk 30m' and after['notes'] == 'ch 4',
      f'{after["tags"]!r} / {after["notes"]!r}')

# ── 6. RECONCILE: the sheet dropping a row retracts the item ─────────────
res = storage.seed_sheets_items(feed([
    row(9, 'CN 3: Optimization'),
    row(10, 'PS1', course='C', due='2/10', done=True),   # ticked in the sheet
]), 'Academics')
check('reconcile: a row ticked IN THE SHEET takes its item with it',
      set(items()) == {'CN 3: Optimization'} and res['retracted'] == 1, res)
check('reconcile: the ledger row goes too, so the sheet can offer it again',
      'C:PS1:2/10' not in seeds())

storage.seed_sheets_items(feed([
    row(9, 'CN 3: Optimization'),
    row(10, 'PS1', course='C', due='2/10'),              # un-ticked again
]), 'Academics')
check('reconcile: a row RESTORED in the sheet seeds afresh',
      'PS1' in items())

# ── 7. the ledger's real job: no resurrection ────────────────────────────
storage.delete_inbox_item(items()['PS1']['id'])
storage.seed_sheets_items(feed([
    row(9, 'CN 3: Optimization'),
    row(10, 'PS1', course='C', due='2/10'),   # sheet STILL says outstanding
]), 'Academics')
check('ledger: an item finished by hand is NOT re-seeded while the row stands',
      'PS1' not in items(), sorted(items()))

# ── 8. CASCADE: addresses into a tab die with the tab ────────────────────
storage.seed_sheets_items(feed([row(3, 'Other tab row')], tab='TL25A'),
                          'Academics')
n = storage.clear_sheets_seeds('TL25A')
check('cascade: clearing a tab drops ITS ledger rows', n == 1 and
      not [k for k, v in seeds().items() if v['tab'] == 'TL25A'])
check('cascade: it leaves the OTHER tab alone',
      any(v['tab'] == 'TL26B' for v in seeds().values()))
check('cascade: the seeded ITEM stands - real work, not a config artifact',
      'Other tab row' in items())

# ── 9. the write guard: proving the row is still the right row ───────────
CALLS = []


class FakeResp:
    status_code = 200

    def json(self):
        return {}

    def raise_for_status(self):
        pass


class FakeSession:
    def get(self, url, params=None, timeout=None):
        CALLS.append(('get', url))
        return FakeResp()

    def put(self, url, params=None, json=None, timeout=None):
        CALLS.append(('put', url, params, json))
        return FakeResp()


aggregator._sheets_session = lambda creds: FakeSession()

aggregator.sheets_read_cell = lambda *a, **k: 'PS1'
aggregator.sheets_set_done('creds.json', 'SHEET', 'TL26B', 10, 6, 3, 'PS1', True)
put = [c for c in CALLS if c[0] == 'put'][-1]
check('write: it addresses the DONE column of that exact row',
      put[1].endswith('/TL26B%21G10'), put[1])
check('write: USER_ENTERED, so a checkbox gets a boolean and not "TRUE"',
      put[2]['valueInputOption'] == 'USER_ENTERED' and put[3]['values'] == [[True]],
      put[2:])

aggregator.sheets_read_cell = lambda *a, **k: 'Somebody else\'s homework'
refused = False
try:
    aggregator.sheets_set_done('creds.json', 'SHEET', 'TL26B', 10, 6, 3, 'PS1', True)
except ValueError:
    refused = True
check('write: a row that no longer says what we expect is REFUSED, not ticked',
      refused)

before = len([c for c in CALLS if c[0] == 'put'])
try:
    aggregator.sheets_set_done('creds.json', 'SHEET', 'TL26B', 10, 6, 3, 'PS1', True)
except ValueError:
    pass
check('write: the refusal happens BEFORE the put, not after',
      len([c for c in CALLS if c[0] == 'put']) == before)

# ── 10. untick is a real inverse ─────────────────────────────────────────
aggregator.sheets_read_cell = lambda *a, **k: 'PS1'
aggregator.sheets_set_done('creds.json', 'SHEET', 'TL26B', 10, 6, 3, 'PS1', False)
put = [c for c in CALLS if c[0] == 'put'][-1]
check('untick: undo writes FALSE to the same cell', put[3]['values'] == [[False]])

# ── 11. the ROUTE: the sheet is ticked FIRST, and only then the delete ───
#
# This is the ordering the whole feature rests on. delete-then-write loses the
# item on a failed write with nothing left addressing the sheet row, and the
# app would then disagree with its own source of truth with no way to notice.
import app as flask_app        # noqa: E402

flask_app.config['sheets_id'] = 'SHEET'
flask_app.config['sheets_tab'] = 'TL26B'
flask_app.config['sheets_area'] = 'Academics'
flask_app.config['gcal_credentials_path'] = __file__   # any path that EXISTS

storage.seed_sheets_items(feed([row(11, 'Route row', course='M', due='3/1')]),
                          'Academics')
target = items()['Route row']

WROTE = []


def fake_ok(creds, sid, tab, rown, done_col, title_col, title, value=True):
    WROTE.append((tab, rown, done_col, value))
    return True


def fake_fail(*a, **k):
    raise RuntimeError('403 caller does not have permission')


client = flask_app.app.test_client()

flask_app.sheets_set_done = fake_fail
resp = client.delete(f'/api/inbox/{target["id"]}')
check('route: a FAILED tick refuses the delete', resp.status_code == 502,
      resp.status_code)
check('route: and the item is still there to try again',
      'Route row' in items())
check('route: the refusal says what went wrong',
      'permission' in resp.get_json().get('error', ''), resp.get_json())

flask_app.sheets_set_done = fake_ok
resp = client.delete(f'/api/inbox/{target["id"]}')
check('route: a successful tick lets the delete through',
      resp.status_code == 204, resp.status_code)
check('route: it ticked the right row of the right tab',
      WROTE == [('TL26B', 11, 6, True)], WROTE)
check('route: and the item is gone from the pool', 'Route row' not in items())

conn = storage.get_conn()
wb = conn.execute("SELECT written_back FROM sheets_item_seed "
                  "WHERE sheets_key = 'M:Route row:3/1'").fetchone()
conn.close()
check('route: the ledger records that the sheet was written to',
      wb and wb['written_back'] == 1)

# ── 12. undo puts BOTH halves back ───────────────────────────────────────
WROTE.clear()
resp = client.post('/api/inbox/restore',
                   json={'row': dict(target), 'children': [], 'placements': []})
check('undo: the item comes back',
      resp.status_code == 201 and 'Route row' in items(), resp.status_code)
check('undo: and the sheet is UNTICKED, so the next refresh cannot retract '
      'the item the undo just restored', WROTE == [('TL26B', 11, 6, False)],
      WROTE)

# ── 13. an unconfigured feed says so instead of half-working ─────────────
flask_app.config['sheets_tab'] = ''
resp = client.post('/api/sheets/refresh')
check('config: an unconfigured feed 400s naming the keys it needs',
      resp.status_code == 400 and 'sheets_tab' in resp.get_json()['error'],
      resp.get_json())
flask_app.config['sheets_tab'] = 'TL26B'

print('\n'.join(ok + bad))
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
