"""One gate, a tag per schedule: a weekday tag and a weekend tag on one Wake gate.

Quentin's instruction (2026-11-05): a gate may run on several schedules and
each may have its own tag. A tag carries the days it clears
(qr_tag.days_of_week, NULL = every day) and a tap counts only on them. This
is the money path, so the checks are about what CANNOT happen:

  * a weekday tag does not clear the gate on a Saturday
  * giving a tag MORE days is another way to clear the gate, so on a tag-only
    gate it waits 24h; fewer days lands at once
  * no change — fewer days, a pause, a delete, cleared keys — may leave a day
    the gate runs with nothing that could clear it
  * the history read (outcomes) asks the same predicate the judge does

Run: python gate_tag_days_test.py
"""
import datetime
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import storage          # noqa: E402
import qr_judge         # noqa: E402
import app as A         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + ('' if cond else ' - ' + str(extra)))


storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()

META = '00112233445566778899AABBCCDDEEFF'
MAC = 'FFEEDDCCBBAA99887766554433221100'
UID_W = '04AABBCCDDEE01'
UID_E = '04AABBCCDDEE02'

today = datetime.date.today()
# The most recent past Monday and Saturday: days the judge can read.
MON = (today - datetime.timedelta(days=today.weekday() + 7)).isoformat()
SAT = (today - datetime.timedelta(days=(today.weekday() - 5) % 7 or 7)).isoformat()

# ── the predicate ──
TAP_WEEKDAYS = {'proof': 'tag', 'tag_days': '01234'}
node0 = {'proof_mode': 'tag'}
check('a weekday tag clears the gate on a Monday',
      qr_judge.scan_satisfies(node0, TAP_WEEKDAYS, MON))
check('...and NOT on a Saturday', not qr_judge.scan_satisfies(node0, TAP_WEEKDAYS, SAT))
check('a tag with no days set clears every day',
      qr_judge.scan_satisfies(node0, {'proof': 'tag', 'tag_days': None}, SAT))
check('a weekday tag does not clear a LINK gate on a Saturday either',
      not qr_judge.scan_satisfies({'proof_mode': 'link'}, TAP_WEEKDAYS, SAT))
check('...while a link scan still clears a link gate any day',
      qr_judge.scan_satisfies({'proof_mode': 'link'}, {'proof': 'link'}, SAT))
check('every day is stored as NULL, one spelling per set',
      qr_judge.norm_days('6543210') is None and qr_judge.norm_days('40') == '04')

# ── a tag-only Wake gate with two tags ──
gate = c.post('/api/accountability/nodes',
              json={'label': 'Wake', 'window_start': '06:00', 'window_end': '10:00'}).get_json()
gid = gate['id']
# Born long ago, so the past days below are days it ran.
conn = storage.get_conn()
conn.execute('UPDATE qr_node SET created_at = NULL WHERE id = ?', (gid,))
conn.commit()
conn.close()
w = c.post(f'/api/accountability/nodes/{gid}/tags', json={'uid': UID_W, 'label': 'Desk'}).get_json()
e = c.post(f'/api/accountability/nodes/{gid}/tags', json={'uid': UID_E, 'label': 'Kitchen'}).get_json()
for t in (w, e):
    c.put(f"/api/accountability/tags/{t['id']}/keys", json={'meta': META, 'mac': MAC})
r = c.patch(f'/api/accountability/nodes/{gid}', json={'proof_mode': 'tag'})
check('the gate goes tag-only with both tags live', r.status_code == 200, r.get_json())


def tag_row(tid):
    return next(t for t in storage.qr_tags_for_node(gid) if t['id'] == tid)


def days(tid, value):
    return c.patch(f'/api/accountability/tags/{tid}', json={'days_of_week': value})


r = days(w['id'], '01234')
check('narrowing the desk tag to weekdays lands at once (the kitchen tag covers the rest)',
      r.status_code == 200 and tag_row(w['id'])['days_of_week'] == '01234', r.get_json())
r = days(e['id'], '56')
check('narrowing the kitchen tag to the weekend lands at once (weekdays are the desk\'s)',
      r.status_code == 200 and tag_row(e['id'])['days_of_week'] == '56', r.get_json())
r = days(w['id'], '0123')
check('dropping Friday from the desk tag is refused: nothing else clears Friday',
      r.status_code == 400 and 'Friday' in r.get_json().get('error', ''), r.get_json())
check('...and the tag keeps its days', tag_row(w['id'])['days_of_week'] == '01234')
check('a tag with no days is refused (that is a pause)', days(e['id'], '').status_code == 400)

r = days(e['id'], '456')
check('giving the kitchen tag Friday too is an easing: it waits 24h',
      r.status_code == 200 and r.get_json().get('pending') is True, r.get_json())
check('...the tag still clears only the weekend until then',
      tag_row(e['id'])['days_of_week'] == '56')
payload = next(t for t in c.get('/api/accountability/nodes').get_json()
               if t['id'] == gid)['tags']
check('...and the gate sheet is told what is coming',
      next(t for t in payload if t['id'] == e['id'])['pending_days'] == '456', payload)
r = days(e['id'], '56')
check('setting it back calls the queued easing off', r.status_code == 200
      and storage.qr_tag_days_pending(e['id']) is None, r.get_json())
days(e['id'], '456')
conn = storage.get_conn()
conn.execute("UPDATE easing_pending SET apply_at = '2000-01-01T00:00:00' "
             "WHERE kind = 'gate_tag' AND field = 'days_of_week'")
conn.commit()
conn.close()
storage.qr_scans_in_window(gid, '2000', '2001')        # the judge's read, alone
conn = storage.get_conn()
raw = conn.execute('SELECT days_of_week FROM qr_tag WHERE id = ?', (e['id'],)).fetchone()[0]
conn.close()
check('once due, the judge\'s own read applies it — never a tag read as tighter than it is',
      raw == '456', raw)

r = c.patch(f"/api/accountability/tags/{w['id']}", json={'active': 0})
check('pausing the desk tag is refused: Monday–Thursday would be uncovered',
      r.status_code == 400 and 'Monday' in r.get_json().get('error', ''), r.get_json())
r = c.delete(f"/api/accountability/tags/{e['id']}")
check('deleting the kitchen tag is refused: the weekend would be uncovered',
      r.status_code == 400 and 'Saturday' in r.get_json().get('error', ''), r.get_json())
check('...and so is clearing its keys — a physical tag\'s keys are what make it live',
      c.delete(f"/api/accountability/tags/{e['id']}/keys").status_code == 400)

# ── what the judge and the history make of a tap ──
node = next(n for n in storage.qr_get_nodes() if n['id'] == gid)


def tap(tid, ymd):
    local = datetime.datetime.fromisoformat(f'{ymd}T07:00:00')
    utc = datetime.datetime(*local.astimezone(None).utctimetuple()[:6])
    storage.qr_log_scan(gid, utc.strftime('%Y-%m-%dT%H:%M:%S.000Z'), None, None, None,
                        proof='tag', tag_id=tid)


def verdict(ymd):
    window = qr_judge.resolve_window(node, ymd)
    lo, hi = qr_judge.day_scan_bounds(node, ymd, window)
    return qr_judge.day_verdict(node, ymd, storage.qr_scans_in_window(gid, lo, hi))


tap(w['id'], SAT)
check('a desk tap on a Saturday does not clear the gate', verdict(SAT) == (False, 'absent'),
      verdict(SAT))
tap(e['id'], SAT)
check('a kitchen tap on the same Saturday does', verdict(SAT) == (True, None), verdict(SAT))
tap(w['id'], MON)
check('a desk tap on a Monday does', verdict(MON) == (True, None), verdict(MON))
hist = {(o['date']): o['outcome'] for o in qr_judge.outcomes(MON, SAT) if o['node_id'] == gid}
check('the history paints the tapped Monday met — it reads the tap\'s proof and tag now',
      hist.get(MON) == 'success', hist)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
raise SystemExit(1 if bad else 0)
