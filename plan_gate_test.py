"""Photo gates: a `!` line in a day's plan. Run: python plan_gate_test.py

What this file holds (2026-10-30, Quentin's instruction — "under no
circumstances may I be overcharged"):

  1. The grammar: `!` makes a line a gate, nested or not; a crossed-out one is
     no gate; the judge reads the line, its notes and its block.
  2. THE LOCK: once a gate's window opens its line cannot be added, removed,
     crossed out, moved or reworded; before that it is ordinary text, and
     every other line stays free.
  3. THE COMMITMENT: provisional before the window, sealed at the first look
     after only if a look saw it coming; the stake only if armed. A gate never
     sealed costs nothing, ever.
  4. Proof: only inside the window, only images, never from the assistant;
     the verdict is written once, by the desktop judge, inside its grace.
  5. The hour to disagree: a rejected proof, an empty window or a proof
     nobody judged (Claude Code away) each fail — and nothing is charged
     until the hour is over and no appeal is still being judged. An appeal
     that passes clears the gate; there may be several.
  6. Money: once, by the one path — the default stake, the switch at settle,
     the fee, the GLOBAL weekly cap shared with the gates, a lost response
     left 'unknown' and never retried, a day older than yesterday stale.
  7. What the app is told: the judge's reachability, and each failure handed
     to the desktop to announce exactly once.
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import day_plan         # noqa: E402
import storage          # noqa: E402
import qr_judge         # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', datetime.now().date().isoformat())

import app as app_mod    # noqa: E402

client = app_mod.app.test_client()
fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


# ── A clock the test holds. The judge and the routes read qr_judge's
# datetime; SQLite's own stamps are rewritten to it after each write. ──
class Clock(datetime):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at


qr_judge.datetime = Clock


def at(hhmm, day='2031-03-04'):
    Clock.at = Clock.strptime(day + ' ' + hhmm, '%Y-%m-%d %H:%M')
    return Clock.at


def restamp(table, id, col):
    conn = storage.get_conn()
    conn.execute(f'UPDATE {table} SET {col} = ? WHERE id = ?',
                 (Clock.at.strftime('%Y-%m-%d %H:%M:%S'), id))
    conn.commit()
    conn.close()


# Beeminder, stubbed: every bill is recorded, nothing leaves the machine.
billed = []
reply = {'ok': True}


def fake_post(url, body):
    billed.append(body)
    if reply.get('lost'):
        raise OSError('connection reset after send')
    return True, {'id': {'$oid': 'c%d' % len(billed)}}


qr_judge._http_post = fake_post
with open('config.json', 'w') as f:
    json.dump({'beeminder_auth_token': 't', 'beeminder_user': 'q'}, f)


def arm(on):
    storage.set_setting('gate_charging_armed_at', '2031-01-01T00:00:00' if on else '')


storage.set_setting('gate_charge_cents', '500')
storage.set_setting('gate_card_fee_cents', '50')
storage.set_setting('gate_weekly_cap_cents', '2500')
arm(True)

D = '2031-03-04'
PLAN = ('9-11:50 COS333: Problem set\n'
        '* questions 1-4\n'
        '  !11:50-12 Photo of Q1-4 written out\n'
        '  * on paper, worked\n'
        '!2-2:10 Inbox zero\n'
        '~~!3-3:10 Crossed out~~\n'
        '4-5 Reading')


def put(body, day=D):
    return client.put(f'/api/day-plan/{day}', json={'body': body})


def gate(start, day=D):
    return next((g for g in storage.plan_gates_on(day) if g['start_min'] == start), None)


def view(start, day=D):
    return next((g for g in client.get(f'/api/plan-gates?date={day}').get_json()['gates']
                 if g['start_min'] == start), None)


def prove(gid, photos=('data:image/png;base64,iVBORw0KGgo=',), comment='', headers=None):
    r = client.post(f'/api/plan-gates/{gid}/proof', json={'photos': list(photos), 'comment': comment},
                    headers=headers or {})
    if r.status_code == 200:
        restamp('plan_gate_proof', r.get_json()['id'], 'created_at')
    return r


def verdict(pid, ok, headers=None):
    r = client.post(f'/api/plan-gates/proofs/{pid}/verdict', json={'pass': ok, 'reason': 'seen'},
                    headers=headers or {})
    if r.status_code == 200:
        restamp('plan_gate_proof', pid, 'judged_at')
    return r


# ── 1. the grammar ──
lines = day_plan.gate_lines(PLAN)
check('a `!` line is a gate, nested or not; a crossed-out one is not',
      sorted(lines) == [(710, 720), (840, 850)], sorted(lines))
check('the judge reads the line (with the category it inherits), its notes and its block',
      lines[(710, 720)]['task'] == 'COS333: Photo of Q1-4 written out\n- on paper, worked\n'
                                   'Inside the block: COS333: Problem set\n- questions 1-4',
      lines[(710, 720)]['task'])
items = day_plan.parse(PLAN)['items']
check('a nested gate line is a block in its block, which stretches over it (9-12)',
      (items[0]['start'], items[0]['end']) == (540, 720), items[0])

# A `!` line is a BLOCK, hours and all; its gate rides on it.
conn = storage.get_conn()
conn.execute('INSERT INTO recurring_block (label, color, day_of_week, start_time, end_time) '
             "VALUES ('deep work', '#5f7f54', 1, '13:00', '16:00')")       # 2031-03-04 is a Tuesday
conn.execute("INSERT INTO calendar_source (name, url, color) VALUES ('Mine', 'x', '#888888')")
# The calendar is read around the REAL today, so the event-cover check uses it.
SOON = (datetime.now() + timedelta(days=3)).date().isoformat()
conn.execute("INSERT INTO gcal_event (uid, summary, start, end, allday, source_id) "
             "VALUES ('e1', 'Call', ?, ?, 0, 1)", (SOON + 'T14:00:00', SOON + 'T14:30:00'))
conn.commit()
conn.close()
storage.set_day_plan('2031-03-04', PLAN)
segs = storage.block_segments_for('2031-03-04')
check('a `!` line draws its block, nested or not',
      any(s['label'] == 'Inbox zero' and (s['start'], s['end']) == (840, 850) for s in segs)
      and any(k['label'] == 'Photo of Q1-4 written out' for s in segs for k in s.get('kids', [])),
      [s['label'] for s in segs])
check('...and takes its hours from the week, like any plan block',
      [(s['start'], s['end']) for s in segs if s['label'] == 'deep work'] == [(780, 840), (850, 900), (910, 960)],
      [(s['label'], s['start'], s['end']) for s in segs])
storage.set_day_plan('2031-03-04', '')
storage.set_day_plan(SOON, '!1:50-2:10 Gate over the call')
check('...and hides the event it overlaps, like any plan block',
      storage.get_gcal_events()[0]['plan_covered'] is True, storage.get_gcal_events())
storage.set_day_plan(SOON, '')

# ── 2 + 3. the lock, and the commitment it is written with ──
at('09:00')
r = put(PLAN)
check('the plan saves', r.status_code == 200, r.get_json())
g1, g2 = gate(710), gate(840)
check('saving commits each gate provisionally, staked at the default while armed',
      g1 and g2 and not g1['sealed_at'] and g1['staked_cents'] == 500, g1)
check('a crossed-out gate is not committed', gate(900) is None)
r = put(PLAN.replace('Inbox zero', 'Inbox to zero'))
check('before it opens a gate line is ordinary text: reworded freely',
      r.status_code == 200 and gate(840)['title'] == 'Inbox to zero', r.get_json())
r = put(PLAN.replace('!2-2:10 Inbox zero\n', ''))
check('...and removed freely, its provisional row with it',
      r.status_code == 200 and gate(840) is None, r.get_json())
put(PLAN)

at('11:40')
qr_judge.plan_judge()                 # a tick within COMMIT_LEAD_MIN of 11:50
at('11:52')
qr_judge.plan_judge()
check('sealed at the first look after its window opens', gate(710)['sealed_at'] is not None, gate(710))
for label, body in (('reworded', PLAN.replace('Q1-4 written', 'Q1-3 written')),
                    ('removed', PLAN.replace('  !11:50-12 Photo of Q1-4 written out\n', '')),
                    ('crossed out', PLAN.replace('  !11:50-12 Photo of Q1-4 written out',
                                                 '  ~~!11:50-12 Photo of Q1-4 written out~~')),
                    ('moved', PLAN.replace('!11:50-12', '!11:55-12'))):
    r = put(body)
    check(f'once open, the gate line cannot be {label}', r.status_code == 409, (r.status_code, r.get_json()))
r = put(PLAN.replace('!2-2:10 Inbox zero\n', '!11-11:30 Late gate\n!2-2:10 Inbox zero\n'))
check('a gate whose window has already opened cannot be added', r.status_code == 409, r.get_json())
r = put(PLAN.replace('4-5 Reading', '4-6 Reading and notes'))
check('every other line stays free', r.status_code == 200, r.get_json())
r = put(PLAN.replace('9-11:50 COS333', '8-11:50 COS333'))
check("...including the block a gate sits in, when the gate's times read the same",
      r.status_code == 200, r.get_json())

# ── 4. proof ──
check('proof before the window is refused', prove(g2['id']).status_code == 409)
r = prove(g1['id'], photos=['data:text/html;base64,PGI+'])
check('a proof that is not an image is refused', r.status_code == 400, r.get_json())
check('a proof with no photo is refused', prove(g1['id'], photos=[]).status_code == 400)
r = prove(g1['id'], headers={'X-QPA-Actor': 'assistant'})
check('the assistant cannot send proof', r.status_code == 403, r.get_json())
r = prove(g1['id'], comment='done on paper')
p1 = r.get_json()['id']
check('a proof inside the window is taken, as a proof', r.status_code == 200 and r.get_json()['kind'] == 'proof',
      r.get_json())
check('its photo is a file in gate-photos/, served back',
      client.get('/gate-photos/' + storage.plan_gate_proof_get(p1)['photos'][0]).status_code == 200)
check('the day reads it as judging', view(710)['state'] == 'judging', view(710))
cal = client.get(f'/api/gates/days?from={D}&to={D}').get_json()[D]['plan_gates']
check("the calendar's gate read carries it, at its window, in the same words",
      [(g['end_min'], g['state']) for g in cal] == [(720, 'judging'), (850, 'upcoming')], cal)

work = client.post('/api/plan-gates/judge', json={'claude': True}).get_json()
check("the desktop judge is handed it, with the gate's task",
      [w['proof']['id'] for w in work['queue']] == [p1] and 'on paper' in work['queue'][0]['gate']['task'],
      work)
check('the assistant cannot judge', verdict(p1, True, {'X-QPA-Actor': 'assistant'}).status_code == 403)
check('a verdict', verdict(p1, True).status_code == 200)
check('...is written once', verdict(p1, False).status_code == 409)
check('a passed gate is met at once', view(710)['state'] == 'met', view(710))
check('...and takes no more proof', prove(g1['id']).status_code == 409)
at('12:30')
qr_judge.plan_judge()
check('a met gate settles ok, and nothing is billed',
      gate(710)['charge_status'] == 'ok' and not billed, (gate(710), billed))

# ── 5. failing, and the hour to disagree ──
at('13:50')
qr_judge.plan_judge()                 # the ticks before 14:00 see it coming
at('14:02')
qr_judge.plan_judge()
g2 = gate(840)
p2 = prove(g2['id']).get_json()['id']
verdict(p2, False)
check('a rejected proof inside the window: failed, and more photos still taken',
      view(840)['state'] == 'failed' and view(840)['can_prove'], view(840))
work = client.post('/api/plan-gates/judge', json={'claude': True}).get_json()
check('the failure is handed to the desktop to announce', [g['id'] for g in work['notify']] == [g2['id']],
      work['notify'])
client.post(f'/api/plan-gates/{g2["id"]}/notified', json={'key': work['notify'][0]['fail_key']})
work = client.post('/api/plan-gates/judge', json={'claude': True}).get_json()
check('...once', work['notify'] == [], work['notify'])
at('14:30')
check('after the window: an hour to disagree, until 15:10',
      view(840)['can_appeal'] and view(840)['appeal_until'].endswith('15:10:00'), view(840))
qr_judge.plan_judge()
check('nothing is charged inside the hour', gate(840)['charge_status'] is None and not billed)
p3 = prove(g2['id'], photos=[], comment='the inbox count is in the corner').get_json()['id']
check('a disagreement in words is an appeal', storage.plan_gate_proof_get(p3)['kind'] == 'appeal')
verdict(p3, False)
work = client.post('/api/plan-gates/judge', json={'claude': True}).get_json()
check('a failed appeal is announced too', [g['id'] for g in work['notify']] == [g2['id']])
at('15:05')
p4 = prove(g2['id'], comment='second look: screenshot attached').get_json()['id']
check('an appeal is not final: another may follow inside the hour', p4 > p3)
at('15:11')
qr_judge.plan_judge()
check('an appeal still with the judge at the end of the hour holds the charge',
      gate(840)['charge_status'] is None and view(840)['state'] == 'judging' and not billed, view(840))
verdict(p4, True)
qr_judge.plan_judge()
check('an appeal that passes clears the gate: ok, nothing billed',
      gate(840)['charge_status'] == 'ok' and not billed, gate(840))

# ── 6. money: absent, unjudged, the cap, the switch ──
# From here the clock WALKS, ticking the judge every five minutes the way
# the server's timer does.
def walk(hhmm, day):
    goal = Clock.strptime(day + ' ' + hhmm, '%Y-%m-%d %H:%M')
    while Clock.at + timedelta(minutes=5) <= goal:
        Clock.at = Clock.at + timedelta(minutes=5)
        qr_judge.plan_judge()
    Clock.at = goal
    qr_judge.plan_judge()


D2 = '2031-03-05'
at('08:00', D2)
put('!9-9:10 Desk clear\n!10-10:10 Run logged\n!11-11:10 Dishes\n!12-12:10 Laundry', D2)
walk('09:30', D2)
check('an empty window fails: absent, and the hour opens at its close',
      view(540, D2)['state'] == 'failed' and view(540, D2)['reason'] == 'absent'
      and view(540, D2)['appeal_until'].endswith('10:10:00'), view(540, D2))
walk('10:05', D2)
pu = prove(gate(600, D2)['id']).get_json()['id']            # Claude Code is away: never judged
walk('10:11', D2)
check('absent: billed once, after the hour — the stake, 500, less the 50 fee',
      gate(540, D2)['charge_status'] == 'succeeded' and gate(540, D2)['amount_cents'] == 500
      and [b['amount'] for b in billed] == ['4.50'], (gate(540, D2), billed))
qr_judge.plan_judge()
qr_judge.plan_judge()
check('every later tick leaves it alone', len(billed) == 1, billed)
walk('10:16', D2)
check('an unjudged proof fails once its grace is gone (Claude Code away)',
      view(600, D2)['state'] == 'failed' and view(600, D2)['reason'] == 'unjudged'
      and view(600, D2)['appeal_until'].endswith('11:15:00'), view(600, D2))
check('a verdict after the grace is refused', verdict(pu, True).status_code == 409)
walk('11:16', D2)
check('unjudged: billed after its hour', gate(600, D2)['charge_status'] == 'succeeded' and len(billed) == 2,
      gate(600, D2))
check('the weekly spent counts photo gates', storage.qr_weekly_spent_cents(D2) == 1000)

# The cap is global: a gate's charge and a photo gate's share it.
conn = storage.get_conn()
conn.execute("INSERT INTO qr_node (id, label, window_start, window_end, token) "
             "VALUES (99, 'Wake', '06:00', '07:00', 'x')")
conn.execute("INSERT INTO qr_charge_log (node_id, date, failure_reason, charge_status, amount_cents) "
             "VALUES (99, ?, 'absent', 'succeeded', 700)", (D2,))
conn.commit()
conn.close()
reply['lost'] = True
walk('12:11', D2)
check("a lost response is 'unknown' and counts against the cap",
      gate(660, D2)['charge_status'] == 'unknown' and storage.qr_weekly_spent_cents(D2) == 2200
      and len(billed) == 3, gate(660, D2))
reply['lost'] = False
qr_judge.plan_judge()
check('...and is never retried', len(billed) == 3, billed)
walk('13:11', D2)
check('a charge that would cross the GLOBAL cap is skipped whole: capped',
      gate(720, D2)['charge_status'] == 'capped' and len(billed) == 3, gate(720, D2))

# The switch: off at settle is off; off when the window opened is no stake.
D3 = '2031-03-06'
at('08:00', D3)
put('!9-9:10 Off at settle\n!10-10:10 Off when sealed', D3)
walk('09:55', D3)
check('sealed while armed: the stake', gate(540, D3)['staked_cents'] == 500, gate(540, D3))
arm(False)
walk('10:05', D3)
check('sealed while disarmed: nothing at stake',
      gate(600, D3)['sealed_at'] and gate(600, D3)['staked_cents'] is None, gate(600, D3))
walk('11:11', D3)
check('disarmed at settle: judged, priced, never billed',
      gate(540, D3)['charge_status'] == 'would_fire' and gate(600, D3)['charge_status'] == 'would_fire'
      and len(billed) == 3, (gate(540, D3), gate(600, D3)))
arm(True)
qr_judge.plan_judge()
check('re-arming reaches nothing already judged', len(billed) == 3)

# A gate nobody saw coming: saved, then no look until after it opened.
D5 = '2031-03-08'
at('08:00', D5)
put('!9-9:10 Unseen', D5)
at('09:05', D5)
qr_judge.plan_judge()
check('a gate not seen within COMMIT_LEAD_MIN of opening is never sealed',
      gate(540, D5)['sealed_at'] is None and view(540, D5)['state'] == 'off', gate(540, D5))
check('...and takes no proof', prove(gate(540, D5)['id']).status_code == 409)
walk('09:11', D5)
check('...and freezes n/a when its window closes, never money',
      gate(540, D5)['charge_status'] == 'n/a' and len(billed) == 3, gate(540, D5))

# A day older than yesterday: judged, frozen, never paid.
D4 = '2031-03-10'
at('08:00', D4)
put('!9-9:10 Old', D4)
walk('09:01', D4)
at('09:00', '2031-03-13')
qr_judge.plan_judge()
check('a judge back after days: stale, never billed', gate(540, D4)['charge_status'] == 'stale'
      and len(billed) == 3, gate(540, D4))

# ── 7. the judge's reachability ──
at('09:01', '2031-03-13')
client.post('/api/plan-gates/judge', json={'claude': True})
check('a heard judge with Claude Code is reachable',
      client.get(f'/api/plan-gates?date={D4}').get_json()['judge']['online'] is True)
at('09:04', '2031-03-13')
check('...and unreachable once unheard for two minutes',
      client.get(f'/api/plan-gates?date={D4}').get_json()['judge']['online'] is False)
client.post('/api/plan-gates/judge', json={'claude': False})
check('...or heard without Claude Code', client.get(f'/api/plan-gates?date={D4}').get_json()['judge']['online']
      is False)
check('the assistant is not the judge',
      client.post('/api/plan-gates/judge', json={'claude': True},
                  headers={'X-QPA-Actor': 'assistant'}).status_code == 403)

print()
print(f'{len(fails)} FAILED' if fails else 'All checks passed.')
sys.exit(1 if fails else 0)
