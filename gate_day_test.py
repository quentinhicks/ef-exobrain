"""The gate day read-out. Run: python gate_day_test.py

/api/accountability/nodes/<id>/day is the TRANSPARENCY surface (2026-08-21,
Quentin's instruction): what this box knows about one gate on one day, so that
"the scan did not work and I cannot see why" has an answer that is not a guess.

The thing it must never do is answer with its own arithmetic. Every number here
is asked of the function that would charge for it — qr_judge.resolve_window,
applies_on, routine_deadline, scan_satisfies — so this file mostly checks that
the payload AGREES with the judge on the same day, including the cases where
the judge is surprising: a pawn shortening the deadline invisibly, a date
override that stands as written, a scan that landed 40m outside the fence.
"""

import datetime
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import app as A         # noqa: E402
import storage          # noqa: E402
import qr_judge         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())
c = A.app.test_client()

TODAY = datetime.date.today().isoformat()
YESTERDAY = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

# Kanji Hall, near enough. The gate is pinned at the hall; the scans below land
# at increasing distances from it, which is the case that sent us here.
HALL_LAT, HALL_LNG = 40.34390, -74.65970

gate = c.post('/api/accountability/nodes', json={
    'label': 'Kanji Hall', 'window_start': '06:00', 'window_end': '10:00',
    'geofence_lat': HALL_LAT, 'geofence_lng': HALL_LNG,
    'geofence_radius_m': 50}).get_json()
GID = gate['id']


def day(date=TODAY, node=GID):
    return c.get('/api/accountability/nodes/%s/day?date=%s' % (node, date)).get_json()


d = day()
check('the day read-out answers for the gate and the date asked',
      d['node_id'] == GID and d['date'] == TODAY, (d.get('node_id'), d.get('date')))
check('...with the window the JUDGE resolves, not a second arithmetic',
      (d['window']['start'], d['window']['end'], d['window']['offset_days'])
      == qr_judge.resolve_window(dict(storage.qr_get_nodes()[0]), TODAY),
      d['window'])
check('...and says WHERE that window came from', 'from' in d['window'], d['window'].get('from'))
check('the pinned place is reported with its radius',
      d['location']['radius_m'] == 50 and d['location']['lat'] == HALL_LAT, d['location'])

# ── the scan that did not clear it ────────────────────────────────────────
#
# THE WHOLE POINT. A scan 220m away with 65m of GPS error is what "the app does
# not know I am in Kanji Hall" looks like from the database, and the read-out
# has to show the distance, not merely that the day failed.
def scan_at(hhmm, lat, lng, geo_pass, accuracy):
    # The judge's own local->UTC conversion, so a scan written for 07:30 lands
    # where 07:30 actually is in the window it is being compared against.
    storage.qr_log_scan(GID, qr_judge._utc_iso(TODAY, hhmm).replace('Z', '.000Z'),
                        lat, lng, geo_pass, accuracy)


scan_at('07:30', 40.34590, -74.65970, 0, 65)

d = day()
check('a scan of the day is listed at all', len(d['scans']) == 1, d['scans'])
sc = d['scans'][0]
check('...with how far off it was', sc['distance_m'] and 200 < sc['distance_m'] < 250,
      sc.get('distance_m'))
check('...with the accuracy the phone claimed', sc['accuracy_m'] == 65, sc.get('accuracy_m'))
check('...and whether it CLEARS the gate, asked of scan_satisfies',
      sc['satisfies'] is False, sc)

# A scan inside the fence clears it, and the read-out says so the same way.
scan_at('07:40', HALL_LAT, HALL_LNG, 1, 12)
d = day()
good = [s for s in d['scans'] if s['satisfies']]
check('a scan inside the fence satisfies it', len(good) == 1, [s['distance_m'] for s in d['scans']])
check('...and is marked as inside the window too', good[0]['in_window'] is True, good[0])

# ── a scan OUTSIDE the window is still shown ──────────────────────────────
#
# Filtering it out would render the day as "nothing happened", which is a lie
# about a day you scanned on — four minutes late is the answer, not an absence.
scan_at('18:05', HALL_LAT, HALL_LNG, 1, 12)
d = day()
late = [s for s in d['scans'] if not s['in_window']]
check('a scan after the window closed is still listed', len(late) == 1,
      [(s['scanned_at'], s['in_window']) for s in d['scans']])

# ── the pawn, which is invisible in every column ──────────────────────────
flow = c.post('/api/flows', json={'name': 'Morning routine'}).get_json()
c.patch('/api/flows/%s' % flow['id'], json={'qr_node_id': GID})
other = c.post('/api/flows', json={'name': 'Night routine'}).get_json()
step = c.post('/api/flows/%s/steps' % other['id'],
              json={'content': 'Lay out clothes'}).get_json()
c.patch('/api/flow-steps/%s' % step['id'],
        json={'pawn_to_flow_id': flow['id'], 'pawn_minutes': 20})
c.post('/api/flow-steps/%s/pawn' % step['id'], json={'date': TODAY})

d = day()
check('the pawned minutes are named', d['pawn']['minutes'] == 20, d['pawn'])
check('...along with the step that arrived and where it came from',
      d['pawn']['steps'] and d['pawn']['steps'][0]['content'] == 'Lay out clothes'
      and d['pawn']['steps'][0]['from_routine'] == 'Night routine', d['pawn']['steps'])
# 2026-08-25: pawned work moves the OPENING, never the close (qr_judge.
# opened_earlier). The read-out shows the window the judge uses either way,
# which is what this check is really for — the two must not disagree.
check('...and the window the judge uses is the one that OPENED earlier',
      d['window']['start'] == qr_judge.resolve_window(storage.qr_get_nodes()[0], TODAY)[0]
      and d['window']['start'] == '05:40'
      and d['window']['end'] == '10:00', d['window'])
check('the gating routine is named with its own deadline',
      d['routine'] and d['routine']['name'] == 'Morning routine', d.get('routine'))

# ── a date override stands as written, and the pawn does NOT shorten it ───
#
# On a FUTURE day: an override within 24h of its own close is refused outright
# (override_locked), so today cannot answer this question.
SOON = (datetime.date.today() + datetime.timedelta(days=3)).isoformat()
c.post('/api/flow-steps/%s/pawn' % step['id'], json={'date': SOON})
ov = c.post('/api/accountability/nodes/%s/overrides' % GID,
            json={'date': SOON, 'window_start': '06:00', 'window_end': '11:00'})
check('an override on a future day is accepted', ov.status_code == 200, ov.get_json())
d = day(SOON)
check('an override wins, and the read-out says which layer answered',
      d['window']['end'] == '11:00' and 'day only' in d['window']['from'], d['window'])
check('...and it says the pawn did NOT apply, rather than showing dead minutes',
      d['pawn']['minutes'] == 20 and d['pawn']['applied'] is False, d['pawn'])

# ── the money numbers, without leaking the token ──────────────────────────
d = day()
check('the stake that would be charged is stated',
      d['stake_cents'] == 200, d.get('stake_cents'))
check('nothing in the payload carries a secret',
      'beeminder_auth_token' not in str(d) and all('meta' not in (t or {}) for t in d['tags']),
      d['tags'])

# ── a day the gate does not run ───────────────────────────────────────────
#
# A gate with a SOURCE is asked the source, not days_of_week (applies_on), so
# the day it does not run is one its schedule has no occurrence on. A
# Monday-only gate answers that without touching the one above.
mon = c.post('/api/accountability/nodes', json={
    'label': 'Monday only', 'window_start': '06:00', 'window_end': '10:00',
    'days_of_week': '0'}).get_json()
not_monday = TODAY
while datetime.date.fromisoformat(not_monday).weekday() == 0:
    not_monday = (datetime.date.fromisoformat(not_monday)
                  + datetime.timedelta(days=1)).isoformat()
dm = day(not_monday, mon['id'])
check('a day the gate does not run says so, rather than drawing a window',
      dm['applies'] is False, (not_monday, dm['applies']))
check('...and the day it DOES run says that too',
      day(TODAY if datetime.date.fromisoformat(TODAY).weekday() == 0
          else (datetime.date.fromisoformat(TODAY) + datetime.timedelta(
              days=(7 - datetime.date.fromisoformat(TODAY).weekday()) % 7 or 7)).isoformat(),
          mon['id'])['applies'] is True)

check('a gate that does not exist is a 404',
      c.get('/api/accountability/nodes/99999/day').status_code == 404)
check('a malformed date is refused',
      c.get('/api/accountability/nodes/%s/day?date=tomorrow' % GID).status_code == 400)

for line in ok + bad:
    print(line)
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
