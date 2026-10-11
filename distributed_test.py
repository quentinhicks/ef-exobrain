"""The laptop and the phone at once. Run: python distributed_test.py

One server, two devices, real HTTP on a real threaded server — the shape the
VM runs: every device is a client of one database. What is under test
(2026-10-11, Quentin's instruction: tests indicating whether simultaneous
laptop + phone use works):

  1. Writing at the same moment loses nothing: both devices capturing at
     once land every capture, and no request fails with a locked database.
  2. A write on one device is what the other reads next — no copy in between.
  3. Two devices editing DIFFERENT fields of one item both stick: a PATCH
     names only what it changes, so neither overwrites the other's edit.
  4. A thing deleted on one device stays deleted when the other, still
     showing it, edits it: an edit never brings a row back to life.
  5. Undo on one device after the other deleted restores the SAME id — the
     children and placements that point at it keep pointing at it.
  6. Both devices placing one item on one day leave ONE placement, the last.
  7. The calendar's range reads and the per-day reads agree for the other
     device's write.
"""

import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import date as date_cls

os.chdir(tempfile.mkdtemp(prefix='qpa-distributed-'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app as app_mod    # noqa: E402
from werkzeug.serving import make_server   # noqa: E402

server = make_server('127.0.0.1', 0, app_mod.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'
TODAY = date_cls.today().isoformat()
ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def inbox_contents():
    return [i['content'] for i in call('GET', '/api/inbox')[1]]


# ── 1. Capturing at the same moment ──────────────────────────
N = 30
statuses = {'laptop': [], 'phone': []}
start = threading.Barrier(2)


def device(name):
    start.wait()
    for i in range(N):
        statuses[name].append(call('POST', '/api/inbox', {'content': f'{name} capture {i}'})[0])


threads = [threading.Thread(target=device, args=(d,)) for d in statuses]
[t.start() for t in threads]
[t.join() for t in threads]
got = inbox_contents()
for d in statuses:
    check(f'{d}: every capture answered 2xx', all(200 <= s < 300 for s in statuses[d]),
          [s for s in statuses[d] if not 200 <= s < 300])
    check(f'{d}: every capture is in the inbox', all(f'{d} capture {i}' in got for i in range(N)),
          sum(f'{d} capture {i}' in got for i in range(N)))

# ── 2. One device reads the other's write ────────────────────
call('POST', '/api/inbox', {'content': 'typed on the phone'})
check("the laptop's next read has the phone's capture", 'typed on the phone' in inbox_contents())

# ── 3. Different fields of one item, at once ─────────────────
_, item = call('POST', '/api/inbox', {'content': 'shared item'})
iid = item['id']
call('PATCH', f'/api/inbox/{iid}', {'status': 'active'})
both = threading.Barrier(2)
edits = [('laptop', {'notes': 'laptop notes'}), ('phone', {'tags': 'phone-tag'})]


def edit(body):
    both.wait()
    call('PATCH', f'/api/inbox/{iid}', body)


ts = [threading.Thread(target=edit, args=(b,)) for _, b in edits]
[t.start() for t in ts]
[t.join() for t in ts]
row = next(i for i in call('GET', '/api/inbox/active')[1] if i['id'] == iid)
check("both devices' edits to different fields stuck",
      row.get('notes') == 'laptop notes' and 'phone-tag' in (row.get('tags') or ''),
      {k: row.get(k) for k in ('notes', 'tags')})

# ── 4. Deleted on one, edited on the other ───────────────────
_, gone = call('POST', '/api/inbox', {'content': 'deleted on the phone'})
call('PATCH', f"/api/inbox/{gone['id']}", {'status': 'active'})
_, snap = call('GET', f"/api/inbox/{gone['id']}/snapshot")
call('DELETE', f"/api/inbox/{gone['id']}")
status, _ = call('PATCH', f"/api/inbox/{gone['id']}", {'notes': 'the laptop had it open'})
alive = [i for i in call('GET', '/api/inbox')[1] + call('GET', '/api/inbox/active')[1]
         if i['id'] == gone['id']]
check("the laptop's late edit does not bring the phone's delete back", not alive, status)
check('and it is told the item is gone (404), not a server error', status == 404, status)

# ── 5. Undo after the other device's delete ──────────────────
_, parent = call('POST', '/api/inbox', {'content': 'a project'})
call('PATCH', f"/api/inbox/{parent['id']}", {'status': 'active'})
_, kid = call('POST', '/api/inbox', {'content': 'its action'})
call('PATCH', f"/api/inbox/{kid['id']}", {'status': 'active', 'project_id': parent['id']})
call('POST', '/api/engage/placements', {'item_id': parent['id'], 'date': TODAY, 'minute': 480})
_, psnap = call('GET', f"/api/inbox/{parent['id']}/snapshot")
call('DELETE', f"/api/inbox/{parent['id']}")
call('POST', '/api/inbox/restore', psnap)
active = {i['id']: i for i in call('GET', '/api/inbox/active')[1]}
check('undo restores the same id', parent['id'] in active)
check('and its action points at it again', (active.get(kid['id']) or {}).get('project_id') == parent['id'])
placed = [p for p in call('GET', f'/api/engage/placements?date={TODAY}')[1] if p['item_id'] == parent['id']]
check('and its placement is back', len(placed) == 1, placed)

# ── 6. Both place one item on one day ────────────────────────
both = threading.Barrier(2)


def place(minute):
    both.wait()
    call('POST', '/api/engage/placements', {'item_id': iid, 'date': TODAY, 'minute': minute})


ts = [threading.Thread(target=place, args=(m,)) for m in (600, 660)]
[t.start() for t in ts]
[t.join() for t in ts]
placed = [p for p in call('GET', f'/api/engage/placements?date={TODAY}')[1] if p['item_id'] == iid]
check('two devices placing one item leave ONE placement', len(placed) == 1, placed)

# ── 7. The range read and the day read agree ─────────────────
call('POST', '/api/day-blocks', {'date': TODAY, 'start_min': 900, 'end_min': 960,
                                 'label': 'from the phone', 'color': '#123456'})
_, day = call('GET', f'/api/blocks/day?date={TODAY}&all=1')
_, rng = call('GET', f'/api/calendar/days?from={TODAY}&to={TODAY}')
check("the laptop's range read sees the phone's block, as the day read does",
      any(s['label'] == 'from the phone' for s in day)
      and rng[TODAY]['segments'] == day, len(day))

server.shutdown()
for line in ok + bad:
    print(line)
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
