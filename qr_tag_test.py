"""The HARD gate proof: a verified NFC tap, and what it is allowed to clear.

This is the money path, so the checks are about what CANNOT happen:

  * a tag-only gate is not cleared by a link scan or by a geofence, however
    honest either looks - that is the whole difference between the two modes
  * a captured tap URL is worth nothing the second time: the read counter is
    claimed by the UPDATE itself, so two processes racing cannot both win it
  * a tag clears the gate it belongs to and no other, even when the gates share
    keys
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

import ntag
import storage
import qr_judge
import app as A

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


def keys_in_config(uid, meta=META, mac=MAC):
    # The same door the settings sheet uses, so the test exercises the merge
    # rather than writing config.json behind it.
    return c.put(f'/api/accountability/tags/{uid}/keys',
                 json={'meta': meta, 'mac': mac})


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

tag = c.post(f"/api/accountability/nodes/{gate['id']}/tags",
             json={'uid': UID_A, 'label': 'Gym door'}).get_json()
check('a tag is added to the gate', tag.get('id') and tag['uid'] == UID_A, tag)
check('...and starts with no keys, so it cannot verify anything yet',
      tag.get('keys_set') is False, tag)
check('a second gate cannot claim the same tag',
      c.post(f"/api/accountability/nodes/{gate['id']}/tags",
             json={'uid': UID_A}).status_code == 409)
check('a UID that is not 7 bytes is refused',
      c.post(f"/api/accountability/nodes/{gate['id']}/tags",
             json={'uid': 'AABB'}).status_code == 400)

still = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'tag'})
check('a tag with no keys still cannot make a gate tag-only', still.status_code == 400,
      still.get_json())
check('the keys go in write-only', keys_in_config(tag['id']).status_code == 200)
check('...into config.json, never the database',
      'ntag_keys' not in json.dumps([dict(r) for r in storage.get_conn().execute(
          'SELECT * FROM qr_tag').fetchall()]))
check('...and are reported only as SET, never read back',
      c.get('/api/accountability/nodes').get_json()[0]['tags'][0]['keys_set'] is True
      and 'meta' not in c.get('/api/accountability/nodes').get_json()[0]['tags'][0])
check('a key that is not 16 bytes is refused',
      c.put(f"/api/accountability/tags/{tag['id']}/keys",
            json={'meta': 'AABB', 'mac': MAC}).status_code == 400)

went = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'tag'})
check('with a live keyed tag, going tag-only applies AT ONCE (it is a tightening)',
      went.status_code == 200 and 'proof_mode' in (went.get_json().get('immediate') or []),
      went.get_json())

node = [n for n in storage.qr_get_nodes() if n['id'] == gate['id']][0]

# ── what clears it, and what does not ──
LINK_SCAN = {'proof': 'link', 'geofence_pass': 1}
TAP = {'proof': 'tag', 'geofence_pass': None}
check('a tag-only gate is NOT cleared by a link scan',
      not qr_judge.scan_satisfies(node, LINK_SCAN))
check('...not even by one that passed a geofence',
      not qr_judge.scan_satisfies(dict(node, geofence_lat=1.0, geofence_lng=2.0), LINK_SCAN))
check('a tag-only gate is cleared by a verified tap', qr_judge.scan_satisfies(node, TAP))
link_node = dict(node, proof_mode='link')
check('a link gate is still cleared by a link scan', qr_judge.scan_satisfies(link_node, LINK_SCAN))
check('a link gate with a fence is not cleared by a scan outside it',
      not qr_judge.scan_satisfies(dict(link_node, geofence_lat=1.0, geofence_lng=2.0),
                                  {'proof': 'link', 'geofence_pass': 0}))
check('a tap clears a link gate too — it is stronger evidence than what was asked',
      qr_judge.scan_satisfies(dict(link_node, geofence_lat=1.0, geofence_lng=2.0), TAP))

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
      qr_judge.scan_satisfies(node, scans[0]))

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
tag_b = c.post(f"/api/accountability/nodes/{other['id']}/tags",
               json={'uid': UID_B, 'label': 'Desk tag'}).get_json()
keys_in_config(tag_b['id'])
pb, mb = ntag.make_tap(bytes.fromhex(META), bytes.fromhex(MAC), UID_B, 2)
t.get(f'/t?e={pb}&c={mb}')
gym = storage.qr_scans_in_window(gate['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
desk = storage.qr_scans_in_window(other['id'], '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
check('a tap with the SAME keys but another tag clears only its own gate',
      len(gym) == 4 and len(desk) == 1, (len(gym), len(desk)))

# ── a new tag on a tag-only gate waits its 24h ──
second = c.post(f"/api/accountability/nodes/{gate['id']}/tags",
                json={'uid': '04FFEEDDCCBB80', 'label': 'Back door'}).get_json()
check('a second tag on a TAG-ONLY gate is queued, not live',
      second['active'] == 0 and second.get('pending_live_at'), second)
keys_in_config(second['id'])
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
      storage.qr_tag_by_uid('04FFEEDDCCBB80')['active'] == 1)
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
      c.delete(f"/api/accountability/tags/{tag['id']}/keys").status_code == 400)

# ── going back to the link is the loosening, and waits ──
back = c.patch(f"/api/accountability/nodes/{gate['id']}", json={'proof_mode': 'link'})
check('dropping back to link proof waits 24h like every other easing',
      'proof_mode' in (back.get_json().get('pending') or []), back.get_json())
check('...so the gate still demands a tap in the meantime',
      [n for n in storage.qr_get_nodes()
       if n['id'] == gate['id']][0]['proof_mode'] == 'tag')

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
