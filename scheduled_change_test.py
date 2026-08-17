"""A change dated forward. Run: python scheduled_change_test.py

Gates, blocks and the calendar that draws them. The three things this file is
here to hold:

  1. A DATE IS A FLOOR, NEVER A BYPASS. A loosening dated to tomorrow morning
     still waits its 24h. The date can only ever push a change later.
  2. The future SHOWS it. A window moved, or a gate paused, from Wednesday
     draws at its new time on Wednesday and its old time on Tuesday — because
     a change nobody can see until it lands is a change you plan around twice.
  3. PAST AND TODAY ARE UNTOUCHED. Anything effective by today has already
     been written into the row, so the projection and the row agree and the
     judge reads exactly what it read before this existed.
"""

import os
import sys
import tempfile
from datetime import date as date_cls, datetime, timedelta

os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import qr_judge         # noqa: E402

fails = []


def check(label, cond, got=''):
    print(f'{"PASS" if cond else "FAIL"}  {label}' + ('' if cond else f'\n        got: {got}'))
    if not cond:
        fails.append(label)


def fresh():
    for f in ('tracker.db', 'config.json'):
        if os.path.exists(f):
            os.remove(f)
    storage.init_db()
    storage.qr_ensure_charge_columns()
    storage.set_setting('gate_charging_live', '0')


TODAY = date_cls.today()
TOMORROW = (TODAY + timedelta(days=1)).isoformat()
WEDNESDAY = (TODAY + timedelta(days=3)).isoformat()      # comfortably past 24h
NEXT_WEEK = (TODAY + timedelta(days=7)).isoformat()


def node_of(nid):
    return [n for n in storage.qr_get_nodes() if n['id'] == nid][0]


# ── effective_date_for: the one rounding rule ────────────────
#
# A change that lands mid-afternoon has not governed that morning's window, so
# the first day it can be said to govern is the next one. Midnight is the
# exception because that is what a dated change is.
check('a change landing at midnight governs that day',
      storage.effective_date_for('2026-08-19T00:00:00') == '2026-08-19')
check('one landing later in the day governs the NEXT one',
      storage.effective_date_for('2026-08-19T16:24:00') == '2026-08-20')

# ── A DATE IS A FLOOR ────────────────────────────────────────
fresh()
nid = storage.qr_create_node('Wake', 'tok-sched-1', '06:00', '08:00',
                             lat=40.0, lng=-75.0, radius=100)
node = node_of(nid)

# 09:00 is a LATER start than 06:00 — the loosest thing you can do to a wake
# gate. Dated to tomorrow, which is less than 24h away for most of the day.
imm, pend = qr_judge.schedule_node_patch(node, {'window_start': '09:00'},
                                         effective_from=TOMORROW,
                                         now=datetime.combine(TODAY, datetime.min.time())
                                         + timedelta(hours=20))
check('a loosening dated inside the 24h window is pushed OUT to 24h',
      pend['window_start']['apply_at'][:10] == TOMORROW
      and pend['window_start']['apply_at'][11:16] == '20:00', pend)
check('...and it therefore governs the day AFTER the one asked for',
      pend['window_start']['effective_date'] > TOMORROW, pend)

imm, pend = qr_judge.schedule_node_patch(node, {'window_start': '09:00'},
                                         effective_from=WEDNESDAY)
check('a loosening dated beyond 24h lands exactly on that date',
      pend['window_start']['effective_date'] == WEDNESDAY
      and pend['window_start']['apply_at'] == WEDNESDAY + 'T00:00:00', pend)
check('and nothing about it applies now', not imm, imm)

# A TIGHTENING dated forward waits too. It is still a change nobody asked to
# happen today, and applying it early would move a deadline under the day.
imm, pend = qr_judge.schedule_node_patch(node, {'window_start': '05:00'},
                                         effective_from=WEDNESDAY)
check('a TIGHTENING dated forward is scheduled, not applied now',
      not imm and pend['window_start']['effective_date'] == WEDNESDAY, (imm, pend))

imm, pend = qr_judge.schedule_node_patch(node, {'window_start': '05:00'})
check('...but with no date it still applies at once, as it always did',
      imm == {'window_start': '05:00'} and not pend, (imm, pend))

# A date already past is not a schedule.
imm, pend = qr_judge.schedule_node_patch(node, {'window_start': '05:00'},
                                         effective_from=(TODAY - timedelta(days=2)).isoformat())
check('a date in the past means now', imm == {'window_start': '05:00'}, (imm, pend))

# ── THE FUTURE SHOWS IT ──────────────────────────────────────
fresh()
nid = storage.qr_create_node('Wake', 'tok-sched-2', '06:00', '08:00')
node = node_of(nid)
storage.qr_add_pending_change(nid, 'window_start', '07:00',
                              WEDNESDAY + 'T00:00:00', WEDNESDAY)
windows = storage.qr_gate_day_windows(node)
before = (date_cls.fromisoformat(WEDNESDAY) - timedelta(days=1)).isoformat()
check('the day before still draws the old window',
      windows[before]['window_start'] == '06:00', windows.get(before))
check('the day it starts draws the new one',
      windows[WEDNESDAY]['window_start'] == '07:00', windows.get(WEDNESDAY))
check('and so does every day after',
      windows[NEXT_WEEK]['window_start'] == '07:00', windows.get(NEXT_WEEK))
check('the changed day says so, so a surface can name it',
      windows[WEDNESDAY].get('scheduled_change') is True
      and 'scheduled_change' not in windows[before], windows.get(WEDNESDAY))
check('TODAY is untouched — nothing effective later may reach back',
      windows[TODAY.isoformat()]['window_start'] == '06:00',
      windows.get(TODAY.isoformat()))

# A PAUSE dated forward: the gate leaves the timeline on that day and not before.
fresh()
nid = storage.qr_create_node('Wake', 'tok-sched-3', '06:00', '08:00')
node = node_of(nid)
storage.qr_add_pending_change(nid, 'active', '0', WEDNESDAY + 'T00:00:00', WEDNESDAY)
windows = storage.qr_gate_day_windows(node)
check('a gate paused from Wednesday still runs on Tuesday', before in windows, sorted(windows))
check('...and is gone from Wednesday on',
      WEDNESDAY not in windows and NEXT_WEEK not in windows, sorted(windows))

# '0' is a TRUE string in Python, which is why storage.falsy exists and why
# this check is here rather than trusted.
check('a queued active reads as OFF even arriving as a string',
      storage.falsy('0') and storage.falsy(0) and not storage.falsy(1))

# A dated DELETION removes the gate from that day, not from history.
fresh()
nid = storage.qr_create_node('Wake', 'tok-sched-4', '06:00', '08:00')
node = node_of(nid)
storage.qr_add_pending_change(nid, storage.QR_DELETE_FIELD, '1',
                              WEDNESDAY + 'T00:00:00', WEDNESDAY)
windows = storage.qr_gate_day_windows(node)
check('a gate deleted from Wednesday still has its Tuesday', before in windows, sorted(windows))
check('...and no days from Wednesday on', WEDNESDAY not in windows, sorted(windows))

# ── BLOCKS: the same door, no 24h rule ───────────────────────
fresh()
dow = TODAY.weekday()
block = storage.create_block('Deep work', '#8fc6cf', dow, '09:00', '11:00', None, None)
wed = date_cls.fromisoformat(WEDNESDAY)
# A block on the same weekday as today, so both dates draw it.
same_dow_future = (TODAY + timedelta(days=7)).isoformat()
storage.schedule_block_change(block['id'], {'start_time': '07:00'}, same_dow_future)

segs_today = storage.block_segments_for(TODAY.isoformat())
check('today still starts at 09:00', segs_today[0]['start'] == 9 * 60, segs_today)
segs_later = storage.block_segments_for(same_dow_future)
check('the dated day starts at 07:00', segs_later[0]['start'] == 7 * 60, segs_later)
check('and that day is marked as changed',
      segs_later[0]['scheduled_change'] and not segs_today[0]['scheduled_change'],
      (segs_today, segs_later))

# Moving a block to another WEEKDAY has to add it there and remove it here,
# which a `WHERE day_of_week = ?` query cannot do.
fresh()
block = storage.create_block('Deep work', '#8fc6cf', dow, '09:00', '11:00', None, None)
other = (dow + 1) % 7
moves_on = (TODAY + timedelta(days=7)).isoformat()
storage.schedule_block_change(block['id'], {'day_of_week': other}, moves_on)
check('the old weekday keeps it until the date',
      len(storage.block_segments_for(TODAY.isoformat())) == 1)
check('the old weekday loses it after',
      storage.block_segments_for(moves_on) == [], storage.block_segments_for(moves_on))
check('and the new weekday gains it',
      len(storage.block_segments_for(
          (date_cls.fromisoformat(moves_on) + timedelta(days=1)).isoformat())) == 1)

# Cancelling. Nothing was applied, so calling it off leaves no trace.
storage.cancel_block_change(block['id'], 'day_of_week')
check('a cancelled change is gone from the store',
      storage.block_scheduled_changes(block['id']) == [],
      storage.block_scheduled_changes(block['id']))
check('...and the future draws the block where it always was',
      len(storage.block_segments_for(moves_on)) == 1)

# A dated change lands by itself once the day arrives — the row and the
# projection must not disagree afterwards.
fresh()
block = storage.create_block('Deep work', '#8fc6cf', dow, '09:00', '11:00', None, None)
storage.schedule_block_change(block['id'], {'start_time': '07:00'}, TODAY.isoformat())
rows = storage.get_blocks()
check('a change dated today lands on the next read',
      rows[0]['start_time'] == '07:00' and rows[0]['scheduled_changes'] == [], rows)

# Deleting a block takes its dated changes with it: the id would otherwise be
# reused and the change would arrive against a block nobody scheduled it on.
fresh()
block = storage.create_block('Deep work', '#8fc6cf', dow, '09:00', '11:00', None, None)
storage.schedule_block_change(block['id'], {'start_time': '07:00'}, NEXT_WEEK)
storage.delete_block(block['id'])
check('deleting a block clears what was dated onto it',
      storage.block_scheduled_changes(block['id']) == [],
      storage.block_scheduled_changes(block['id']))

print()
print(f'{"FAILED: " + "; ".join(fails) if fails else "All checks passed."}')
sys.exit(1 if fails else 0)
