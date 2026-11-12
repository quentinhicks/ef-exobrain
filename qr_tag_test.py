"""The HARD gate proof: a verified NFC tap, and what it is allowed to clear.

This is the money path, so the checks are about what CANNOT happen:

  * a tag-only gate is not cleared by a link scan or by a geofence, however
    honest either looks - that is the whole difference between the two modes
  * a captured tap URL is worth nothing the second time: the read counter is
    claimed by the UPDATE itself, so two processes racing cannot both win it
  * a tag is its OWN configuration (2026-11-12): set up once in the registry,
    on no gate, and assigned to gates' schedules; it clears the gates it is on
    and no other, even when the gates share keys; on several gates, one tap
    clears each whose assignment is live, and its ONE read counter means a URL
    from before it joined a gate is not new to that gate
  * a new tag on a tag-only gate waits its 24h like every other loosening, and
    a paused one that never came due cannot clear anything
  * the last tag of a tag-only gate cannot be removed, because a gate nothing
    can clear is not a commitment, it is a charge every day

Run: python qr_tag_test.py
"""
import datetime
import json
import os
import sys
import tempfile

# A SCRATCH DIRECTORY, like every other suite. Without it this ran against the
# tracker.db and config.json beside the code, so it passed exactly once: the
# second run found its own tags already claimed ("that UID already belongs to a
# gate") and failed at the first key it tried to write. It also wrote its
# fixture keys into a real config.json, which is the file that holds the live
# ones - a test must never be able to touch those.
HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import ntag             # noqa: E402
import storage          # noqa: E402
import qr_judge         # noqa: E402
import app as A         # noqa: E402

ok, bad = [], []
def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))

storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()

META = '00112233445566778899AABBCCDDEEFF'
MAC = 'FFEEDDCCBBAA99887766554433221100'
UID_A = '04AABBCCDDEE80'
UID_B = '0411223344556680'[:14]


def keys_in_config(tag_id, meta=META, mac=MAC):
    # The same door the Tags section uses, so the test exercises the merge
    # rather than writing config.json behind it. tag_id is the REGISTRY's.
    return c.put(f'/api/nfc-tags/{tag_id}/keys', json={'meta': meta, 'mac': mac})


def register(uid, label=None):
    r = c.post('/api/nfc-tags', json={'uid': uid, 'label': label or ''})
    assert r.status_code == 201, (r.status_code, r.get_json())
    return r.get_json()


def assign(node_id, tag, days=None):
    return c.post(f'/api/accountability/nodes/{node_id}/tags',
                  json={'tag_id': tag['id'], 'days_of_week': days})


gate = c.post('/api/accountability/nodes',
              json={'label': 'Gym', 'window_start': '06:00', 'window_end': '10:00'}).get_json()
check('a new gate proves itself by LINK, the way every gate did before',
      (gate.get('proof_mode') or 'link') == 'link', gate.get('proof_mode'))
check('...and says what to write to a tag once a scan URL is configured',
      'tap_url' in gate, sorted(gate)[:6])

# ── it takes a tag with keys before a gate can demand one ──
hard = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'tag'})
check('a gate cannot go tag-only with no tag — that gate could never be cleared',
      hard.status_code == 400, (hard.status_code, hard.get_json()))

phys_a = register(UID_A, 'Gym door')
check('a tag is set up in the registry, on no gate',
      phys_a.get('id') and phys_a['uid'] == UID_A and phys_a['gates'] == [], phys_a)
check('...and starts with no keys, so it cannot verify anything yet',
      phys_a.get('keys_set') is False, phys_a)
check('the registry holds one tag per UID',
      c.post('/api/nfc-tags', json={'uid': UID_A.lower()}).status_code == 409)
check('a UID that is not 7 bytes is refused',
      c.post('/api/nfc-tags', json={'uid': 'AABB'}).status_code == 400)
check('a gate is given only a tag from the registry',
      c.post(f"/api/accountability/nodes/{gate['id']}/tags", json={'uid': UID_A}).status_code == 400)
tag = assign(gate['id'], phys_a).get_json()
check('a registered tag is assigned to the gate',
      tag.get('id') and tag['uid'] == UID_A and tag['tag_id'] == phys_a['id']
      and tag['label'] == 'Gym door', tag)
check('the same gate cannot hold the same tag twice',
      assign(gate['id'], phys_a).status_code == 409)
check('the registry says which gates a tag is on',
      [g['node_label'] for g in c.get('/api/nfc-tags').get_json()[0]['gates']] == ['Gym'])

still = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'tag'})
check('a tag with no keys still cannot make a gate tag-only', still.status_code == 400,
      still.get_json())
check('the keys go in write-only', keys_in_config(phys_a['id']).status_code == 200)
check('...into config.json, never the database',
      META not in json.dumps([dict(r) for r in storage.get_conn().execute(
          'SELECT * FROM nfc_tag').fetchall()]))
check('...and are reported only as SET, never read back',
      c.get('/api/accountability/nodes').get_json()[0]['tags'][0]['keys_set'] is True
      and 'meta' not in c.get('/api/accountability/nodes').get_json()[0]['tags'][0])
check('a key that is not 16 bytes is refused',
      c.put(f"/api/nfc-tags/{phys_a['id']}/keys",
            json={'meta': 'AABB', 'mac': MAC}).status_code == 400)

went = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'tag'})
check('with a live keyed tag, going tag-only applies AT ONCE (it is a tightening)',
      went.status_code == 200 and 'proof_mode' in (went.get_json().get('immediate') or []),
      went.get_json())

node = [n for n in storage.qr_get_nodes() if n['id'] == gate['id']][0]

# ── what clears it, and what does not ──
D = '2030-01-07'          # any day: these taps' tags clear every day
LINK_SCAN = {'proof': 'link', 'geofence_pass': 1}
TAP = {'proof': 'tag', 'geofence_pass': None}
check('a tag-only gate is NOT cleared by a link scan',
      not qr_judge.scan_satisfies(node, LINK_SCAN, D))
check('...not even by one that passed a geofence',
      not qr_judge.scan_satisfies(dict(node, geofence_lat=1.0, geofence_lng=2.0), LINK_SCAN, D))
check('a tag-only gate is cleared by a verified tap', qr_judge.scan_satisfies(node, TAP, D))
link_node = dict(node, proof_mode='link')
check('a link gate is still cleared by a link scan', qr_judge.scan_satisfies(link_node, LINK_SCAN, D))
check('a link gate with a fence is not cleared by a scan outside it',
      not qr_judge.scan_satisfies(dict(link_node, geofence_lat=1.0, geofence_lng=2.0),
                                  {'proof': 'link', 'geofence_pass': 0}, D))
check('a tap clears a link gate too — it is stronger evidence than what was asked',
      qr_judge.scan_satisfies(dict(link_node, geofence_lat=1.0, geofence_lng=2.0), TAP, D))

# ── the public tap endpoint ──
import qr_scan_server                                              # noqa: E402
t = qr_scan_server.app.test_client()

picc, cm = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 5)
r = t.get(f'/t?e={picc}&c={cm}')
check('a genuine tap is logged', r.status_code == 200 and b'Logged' in r.data, r.status_code)
scans = storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
check('...as a scan of THIS gate, marked as tag-proved',
      len(scans) == 1 and scans[0]['proof'] == 'tag' and scans[0]['tag_id'] == tag['id'], scans)
check('...and it satisfies the gate it was tapped for',
      qr_judge.scan_satisfies(node, scans[0], D))

again = t.get(f'/t?e={picc}&c={cm}')
check('the SAME tap replayed logs nothing more — the read counter is spent',
      len(storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z',
                                     '2100-01-01T00:00:00Z')) == 1,
      again.data[:80])
old_picc, old_cm = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 4)
t.get(f'/t?e={old_picc}&c={old_cm}')
check('...and so does an OLDER counter, which is what a captured URL looks like',
      len(storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z',
                                     '2100-01-01T00:00:00Z')) == 1)
nxt_picc, nxt_cm = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 6)
t.get(f'/t?e={nxt_picc}&c={nxt_cm}')
check('the NEXT real tap is logged', len(storage.qr_scans_in_window(
    gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')) == 2)

# The names a programming tool happens to use are not the app's business.
alt = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 7)
check("a tap named the way NXP's own backend names it is accepted",
      t.get(f'/t?enc_picc_data={alt[0]}&sdmmac={alt[1]}').status_code == 200)
bulk = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 8)
check('...and the BULK form, both mirrors in one parameter',
      t.get(f'/t?e={bulk[0]}{bulk[1]}').status_code == 200)
check('...each logged exactly once', len(storage.qr_scans_in_window(
    gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')) == 4)

# A tag that mirrors its UID but NOT its read counter cannot be told from one
# that does without the tag byte — and without the counter there is no replay
# guard at all, so it is refused rather than read out of the padding.
no_ctr = ntag.cbc_encrypt(bytes.fromhex(META),
                          bytes((0x87,)) + bytes.fromhex(UID_A) + bytes(8)).hex().upper()
ses = ntag.session_mac_key(bytes.fromhex(MAC), bytes.fromhex(UID_A), 0)
no_ctr_mac = ntag._mact(ntag.cmac(ses)).hex().upper()
check('a tag with no read-counter mirror is refused, in words',
      t.get(f'/t?e={no_ctr}&c={no_ctr_mac}').status_code == 403)

forged = t.get('/t?e=' + '11' * 16 + '&c=' + '22' * 8)
check('a made-up tap is refused', forged.status_code == 403, forged.status_code)
wrong_key = ntag.make_tap(bytes.fromhex('AA' * 16), bytes.fromhex(MAC), UID_A, 99)
check('a tap encrypted with the wrong key is refused',
      t.get(f'/t?e={wrong_key[0]}&c={wrong_key[1]}').status_code == 403)
check('...and neither logged anything', len(storage.qr_scans_in_window(
    gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')) == 4)

# ── a tag belongs to ONE gate ──
other = c.post('/api/accountability/nodes',
               json={'label': 'Desk', 'window_start': '09:00', 'window_end': '17:00'}).get_json()
phys_b = register(UID_B, 'Desk tag')
tag_b = assign(other['id'], phys_b).get_json()
keys_in_config(phys_b['id'])
pb, mb = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_B, 2)
t.get(f'/t?e={pb}&c={mb}')
gym = storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
desk = storage.qr_scans_in_window(other['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
check('a tap with the SAME keys but another tag clears only its own gate',
      len(gym) == 4 and len(desk) == 1, (len(gym), len(desk)))

# ── a new tag on a tag-only gate waits its 24h ──
phys_back = register('04FFEEDDCCBB80', 'Back door')
second = assign(gate['id'], phys_back).get_json()
check('a second tag on a TAG-ONLY gate is queued, not live',
      second['active'] == 0 and second.get('pending_live_at'), second)
keys_in_config(phys_back['id'])
p2, m2 = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), '04FFEEDDCCBB80', 1)
queued = t.get(f'/t?e={p2}&c={m2}')
check('...so a tap on it does not clear the gate yet', queued.status_code == 409,
      queued.status_code)
check('...and it says when it starts counting', b'starts counting' in queued.data,
      queued.data[:120])
check('the gate that is still waiting logged nothing',
      len(storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z',
                                     '2100-01-01T00:00:00Z')) == 4)

# time passes: the pending lands on READ, at either choke point
conn = storage.get_conn()
conn.execute("UPDATE easing_pending SET apply_at = ? WHERE kind = 'gate_tag'",
             ((datetime.datetime.now() - datetime.timedelta(minutes=1)).isoformat(),))
conn.commit()
conn.close()
check('once the 24h is up the tag goes live on the next read',
      storage.qr_tags_by_uid('04FFEEDDCCBB80')[0]['active'] == 1)
p3, m3 = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), '04FFEEDDCCBB80', 2)
t.get(f'/t?e={p3}&c={m3}')
check('...and then it clears the gate', len(storage.qr_scans_in_window(
    gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')) == 5)

# ── the gate must stay clearable ──
check('a tag-only gate will not give up its last tag',
      c.delete(f"/api/accountability/tags/{second['id']}").status_code == 200
      and c.delete(f"/api/accountability/tags/{tag['id']}").status_code == 400,
      'the second delete should be refused')
check('...nor let it be paused',
      c.patch(f"/api/accountability/tags/{tag['id']}",
              json={'active': 0}).status_code == 400)
check('...nor have its keys cleared',
      c.delete(f"/api/nfc-tags/{phys_a['id']}/keys").status_code == 400)
check('...nor be deleted from the registry',
      c.delete(f"/api/nfc-tags/{phys_a['id']}").status_code == 400
      and storage.nfc_tag(phys_a['id']) is not None)

# ── going back to the link is the loosening, and waits ──
back = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'link'})
check('dropping back to link proof waits 24h like every other easing',
      'proof_mode' in (back.get_json().get('pending') or []), back.get_json())
check('...so the gate still demands a tap in the meantime',
      [n for n in storage.qr_get_nodes()
       if n['id'] == gate['id']][0]['proof_mode'] == 'tag')

# ── one tag on several gates (2026-10-22: the dorm tag clears Sleep and Mindful) ──
def scans_of(node_id):
    return storage.qr_scans_in_window(node_id, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')


gym_before, desk_before = len(scans_of(gate['id'])), len(scans_of(other['id']))
on_desk = assign(other['id'], phys_a)
check("a tag already on one gate can be added to another", on_desk.status_code == 201,
      (on_desk.status_code, on_desk.get_json()))
on_desk = on_desk.get_json()
check('...live at once on a LINK gate, and its keys are already set (they are the UID\'s)',
      on_desk['active'] == 1 and on_desk['keys_set'] is True, on_desk)
check('...and the read counter is the TAG\'s, already spent',
      on_desk['last_counter'] == 8, on_desk['last_counter'])
t.get(f'/t?e={bulk[0]}&c={bulk[1]}')
check('a URL from BEFORE it joined the second gate clears neither',
      (len(scans_of(gate['id'])), len(scans_of(other['id']))) == (gym_before, desk_before))
p9, m9 = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 9)
both = t.get(f'/t?e={p9}&c={m9}')
check('one new tap clears BOTH gates, once each',
      (len(scans_of(gate['id'])), len(scans_of(other['id']))) == (gym_before + 1, desk_before + 1)
      and b'Gym' in both.data and b'Desk' in both.data, both.data[-300:])
t.get(f'/t?e={p9}&c={m9}')
check('...and replaying it clears neither again',
      (len(scans_of(gate['id'])), len(scans_of(other['id']))) == (gym_before + 1, desk_before + 1))

hard3 = c.post('/api/accountability/nodes',
               json={'label': 'Mindful', 'window_start': '07:45', 'window_end': '08:15'}).get_json()
assign(hard3['id'], phys_b)
c.patch(f"/api/accountability/nodes/{hard3['id']}", json={'proof_mode': 'tag'})
joined = assign(hard3['id'], phys_a).get_json()
check('on a TAG-ONLY gate the shared tag waits its 24h — it is a new way to clear THAT gate',
      joined['active'] == 0 and joined.get('pending_live_at'), joined)
p10, m10 = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 10)
t.get(f'/t?e={p10}&c={m10}')
check('...so a tap meanwhile clears the gates it is live on, and not the one it waits for',
      len(scans_of(gate['id'])) == gym_before + 2 and len(scans_of(hard3['id'])) == 0)
conn = storage.get_conn()
conn.execute("UPDATE easing_pending SET apply_at = ? WHERE kind = 'gate_tag'",
             ((datetime.datetime.now() - datetime.timedelta(minutes=1)).isoformat(),))
conn.commit()
conn.close()
t.get(f'/t?e={p10}&c={m10}')
check('once live, the tap it refused while waiting is NOT new to it — no replay',
      len(scans_of(hard3['id'])) == 0, scans_of(hard3['id']))
p11, m11 = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_A, 11)
t.get(f'/t?e={p11}&c={m11}')
check('...and the next real tap clears all three',
      len(scans_of(hard3['id'])) == 1 and len(scans_of(gate['id'])) == gym_before + 3)

check('pausing it on one gate leaves it live on the others',
      c.patch(f"/api/accountability/tags/{on_desk['id']}", json={'active': 0}).status_code == 200
      and [r['active'] for r in storage.qr_tags_by_uid(UID_A)] == [1, 0, 1])
desk_row = [t for n in c.get('/api/accountability/nodes').get_json() if n['id'] == other['id']
            for t in n['tags'] if t['uid'] == UID_A][0]
check('a shared tag says which other gates it clears, since its keys are theirs too',
      sorted(desk_row['also_on']) == ['Gym', 'Mindful'], desk_row.get('also_on'))
check('its keys cannot be cleared while a tag-only gate it is on has nothing else to clear it',
      c.delete(f"/api/nfc-tags/{phys_a['id']}/keys").status_code == 400)

# Deleting a gate takes ITS assignments and what was queued on them, never the
# same tag's assignments on other gates, nor the tag or its keys (2026-11-09).
storage.qr_pend_tag_live(on_desk['id'])
before = len(storage.qr_tags_by_uid(UID_A))
storage.qr_delete_node(other['id'])
conn = storage.get_conn()
left = conn.execute('SELECT COUNT(*) FROM qr_gate_tag WHERE node_id = ?', (other['id'],)).fetchone()[0]
queued = conn.execute("SELECT COUNT(*) FROM easing_pending WHERE kind = 'gate_tag' AND row_id = ?",
                      (on_desk['id'],)).fetchone()[0]
conn.close()
check('deleting a gate deletes its tag assignments', left == 0, left)
check('...and what was queued on them', queued == 0, queued)
check('...and leaves the same tag on its other gates', len(storage.qr_tags_by_uid(UID_A)) == before - 1)
check('...and keeps the tag, and its keys', storage.nfc_tag(phys_a['id']) is not None
      and UID_A in ntag.load_keys())

# ── a tag on no gate (2026-11-12) ──
phys_loose = register('04010203040580', 'Spare')
keys_in_config(phys_loose['id'])
pl, ml = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), '04010203040580', 3)
loose = t.get(f'/t?e={pl}&c={ml}')
check('a tap on a tag that is on no gate says so, and clears nothing',
      loose.status_code == 404 and b'not on a gate' in loose.data, loose.data[-200:])
check('...but the read is spent all the same: assigning it later does not make the URL new',
      storage.nfc_tag(phys_loose['id'])['last_counter'] == 3)
check('renaming a tag renames it on every gate it is on',
      c.patch(f"/api/nfc-tags/{phys_a['id']}", json={'label': 'Gym door (east)'}).status_code == 200
      and {r['label'] for r in storage.qr_tags_by_uid(UID_A)} == {'Gym door (east)'})
check('a tag needs a name', c.patch(f"/api/nfc-tags/{phys_a['id']}", json={'label': ' '}).status_code == 400)
check('an unused tag can be deleted from the registry',
      c.delete(f"/api/nfc-tags/{phys_loose['id']}").status_code == 200
      and storage.nfc_tag(phys_loose['id']) is None)
link_g = c.post('/api/accountability/nodes',
                json={'label': 'Library', 'window_start': '10:00', 'window_end': '11:00'}).get_json()
on_link = assign(link_g['id'], phys_b, '012').get_json()
storage.qr_pend_tag_days(on_link['id'], '0123')
check('deleting a tag takes it off every gate, with what was queued on its assignments',
      c.delete(f"/api/nfc-tags/{phys_back['id']}").status_code == 200
      and not storage.qr_tags_by_uid('04FFEEDDCCBB80'))
check('...but not while it is all a tag-only gate has',
      c.delete(f"/api/nfc-tags/{phys_a['id']}").status_code == 400)

# ── the split (2026-11-12): old per-gate qr_tag rows become tags + assignments ──
os.chdir(tempfile.mkdtemp())
import sqlite3                                                     # noqa: E402
raw = sqlite3.connect('tracker.db')
raw.executescript('''
    CREATE TABLE qr_tag (
        id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL, label TEXT NOT NULL,
        uid TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1, last_tap_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        days_of_week TEXT, UNIQUE (node_id, uid));
    INSERT INTO qr_tag (id, node_id, label, uid, last_counter, last_tap_at, active, days_of_week, created_at)
      VALUES (1, 3, 'Kanji Hall dorm', '04326c521f1e90', 58, '2026-11-10T03:00:00Z', 1, NULL, '2026-08-25 00:54:55'),
             (2, 4, 'Addy stairwell', '047668521F1E90', 45, '2026-11-12T12:13:39Z', 1, '0256', '2026-08-25 01:45:38'),
             (4, 5, 'dorm (mindful)', '04326C521F1E90', 60, '2026-11-12T03:23:27Z', 0, NULL, '2026-10-22 20:28:54');
''')
raw.commit()
raw.close()
storage.init_db()
conn = storage.get_conn()
gone = conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'qr_tag'").fetchone()
phys = [dict(r) for r in conn.execute('SELECT * FROM nfc_tag ORDER BY id')]
asg = [dict(r) for r in conn.execute('SELECT * FROM qr_gate_tag ORDER BY id')]
conn.close()
check('the split leaves no qr_tag table behind', gone is None)
check('...one tag per physical UID, upper-cased',
      [p['uid'] for p in phys] == ['04326C521F1E90', '047668521F1E90'], phys)
check('...named by its first row, with the highest counter and the latest tap',
      phys[0]['label'] == 'Kanji Hall dorm' and phys[0]['last_counter'] == 60
      and phys[0]['last_tap_at'] == '2026-11-12T03:23:27Z', phys[0])
check('...and every old row is an assignment under its OWN id (scans and waits name it)',
      [(a['id'], a['node_id'], a['tag_id'], a['days_of_week'], a['active']) for a in asg]
      == [(1, 3, phys[0]['id'], None, 1), (2, 4, phys[1]['id'], '0256', 1),
          (4, 5, phys[0]['id'], None, 0)], asg)
storage.init_db()
conn = storage.get_conn()
check('...and runs once: a second start changes nothing',
      conn.execute('SELECT COUNT(*) FROM nfc_tag').fetchone()[0] == 2
      and conn.execute('SELECT COUNT(*) FROM qr_gate_tag').fetchone()[0] == 3)
conn.close()

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
