"""One legible markdown file per day, for a history that outlives the schema.

The backups are a database: consistent, restorable, and unreadable without this
code. This is the other thing — a plain-text day you can read in ten years with
no app, no sqlite, and no idea what version of the schema wrote it.

THE DESIGN PROBLEM is that the schema changes constantly. A hand-written
formatter per table would be stale within a week and, worse, would go on
producing a confident-looking file with the new columns silently missing. So
nothing here lists columns. Every row is rendered from PRAGMA table_info at
write time, and which column DATES a row is INFERRED from a priority list
(TIME_COLS), with overrides only where inference is wrong.

The consequence, which is the point: add a table with a `date` column and it
appears in tomorrow's file by itself. Add one with no time column and it lands
in the file's own "not covered" footer, so the gap is visible in the artifact
rather than discovered years later.

Rewriting: today's file is rewritten on every run (the day is not over). A past
day is written once and then left alone — it is history, and a later schema
must not silently restate it.
"""

import os
import re
import sqlite3
from datetime import date as date_cls, timedelta

import storage

DAYBOOK_DIR = 'daybook'

# Which column dates a row, in order of preference. First one present wins.
TIME_COLS = ('date', 'captured_at', 'scanned_at', 'started_at', 'created_at')

# ...and which of those are stamped in UTC, so a prefix match on them would
# file the row under the wrong day.
#
# Only ONE, now. Every column that defaulted to SQLite's datetime('now') was
# UTC — and the app dates in local, so anything captured after ~20:00 filed
# under tomorrow and, because a past day is written once, was frozen out of
# its own file. Those DEFAULTs say 'localtime' as of 2026-08-17 and
# storage._migrate_utc_stamps converted what had already been written, so
# they are local at rest and converting them here again would shift them back.
#
# qr_scan.scanned_at stays: the scan server writes UTC-with-Z BY DESIGN (the
# judge matches scans against UTC window bounds), and no DEFAULT change will
# ever alter that.
# qr_tap_attempt.tapped_at joins it for the same reason: the scan server
# writes both, that process never applies setting.timezone, and a stamp it
# called "local" would be the VM's local rather than the app's.
UTC_COLS = {'scanned_at', 'tapped_at'}

# Where inference is wrong or too crude. A column name, matched by DATE PREFIX
# (which covers both a bare date and a naive local timestamp — every time column
# in this schema is one or the other).
OVERRIDES = {
    'flow_run': 'date',               # a PERIOD key — _flow_run_rows widens it
    'gtd_review': 'week_start_date',  # the week containing the day
    'gcal_event': 'start',            # the day's calendar, by prefix
    'gcal_move': 'start',             # dated by the event's ORIGINAL start:
                                      # the decision was about that day's
                                      # calendar, even when it pushed the
                                      # event onto the next one
    'habit_day': 'date',
    'inbox_item': 'captured_at',      # what was CAPTURED that day
    'occasion_mint': 'date',          # the actions an event brought with it
    'qr_tap_attempt': 'tapped_at',    # every tap of a gate's tag, verified or
                                      # refused — a fact about the day it was
                                      # made on, and the refusals are the half
                                      # that exists nowhere else
    'routine_item': 'done_date',      # ticked that day; done_date self-resets
}

# Excluded on purpose: caches, derived tables and retired ones. Nothing here is
# a fact about a day, and a rebuilt cache would make two runs of the same day
# disagree. Named in the file's footer, so the exclusion is visible.
SKIP = {'gcal_recurring_seen', 'todo_sync', 'qr_todo_push',
        # sheets_item_seed is an ADDRESS BOOK, not a fact about a day: which
        # row of which tab each seeded item came from, rewritten every refresh
        # as rows move. What it produced is an inbox_item, which the day file
        # already carries both ways (dated by capture, and listed whole as
        # state) - printing the addresses beside them would say the same thing
        # in row numbers.
        'sheets_item_seed',
        'timeline_dismissal', 'review_annotation', 'time_preset',
        # row_revision is not a fact about a day — it is what a SETTING used to
        # say, so that the days it covers can be resolved correctly. Its rows
        # are already visible through the thing they modify (a routine's window
        # on that day's file), and listing them here as well would print the
        # same change once per day it reaches back over.
        'row_revision'}

# The standing state a day carries beside its events, so the file is
# self-contained: reading 2026-08-12 tells you what the system WAS, not only what
# happened in it. Rendered compactly, one line per row.
#
# social_action and social_axis_level earn their place because a rep's price is
# STAMPED at log time — without the grid beside it, a later recalibration makes
# the day's numbers unreadable.
STATE = ('domain', 'area', 'qr_node', 'qr_tag', 'qr_pending_change', 'easing_pending',
         'flow', 'flow_step',
         'ref_list', 'recurring_block', 'recurring_task', 'routine_item',
         'location', 'bucket', 'person_bucket', 'calendar_source', 'deadline',
         'occasion',
         'schedule_source', 'social_action', 'social_axis_level',
         # The metric DEFINITIONS and which step asks each one. Standing state:
         # the answers are dated, but reading a day's numbers is meaningless
         # without the questions that produced them beside it — the same reason
         # social_axis_level is here.
         'metric', 'metric_step',
         'tag_time', 'tag_device', 'tag_location', 'tag_daily', 'setting')

# Both at once: dated for what came in that day, AND listed whole as standing
# state. `inbox_item` needs both because completion DELETES the row — the live
# inventory on a given day cannot be reconstructed from any later database, so if
# a day file does not carry it, it is gone.
STATE_ALSO_DATED = {'inbox_item', 'routine_item'}

# A heading a human wrote beats a table name. Anything absent falls back to the
# table name, which is the whole point of not requiring an entry.
TITLES = {
    'easing_pending': 'Easings waiting out their 24h',
    'qr_tap_attempt': 'Tag taps, accepted and refused',
    'inbox_item': 'Captured',
    'engage_placement': 'Placed on the day',
    'occasion_mint': 'Minted by an occasion',
    'flow_task_seed': 'Routines seeded as tasks',
    'flow_run': 'Routines run',
    'gtd_review': 'Weekly review',
    'journal_day': 'Journal',
    'metric_entry': 'Metrics answered',
    'habit_day': 'Habit marks',
    'gcal_event': 'Calendar',
    'qr_scan': 'Gate scans',
    'qr_charge_log': 'Gate judgments and charges',
    'qr_override': 'Gate overrides for the day',
    'social_log': 'Social — logged',
    'social_rep': 'Social — reps',
    'social_spec': 'Social — planned',
    'interaction': 'People — interactions',
    'observation': 'Observations',
    'block_override': 'Block changes',
    'block_feedback': 'Block feedback',
    'daily_todo': 'Day plan',
    'daily_review': 'Daily review',
    'crm_night': 'CRM night',
}


def _tables(conn):
    return sorted(r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))


def _cols(conn, table):
    return [r[1] for r in conn.execute(f'PRAGMA table_info({table})')]


def _time_col(cols, table):
    if table in OVERRIDES:
        return OVERRIDES[table]
    if table in STATE and table not in STATE_ALSO_DATED:
        return None
    for c in TIME_COLS:
        if c in cols:
            return c
    return None


def _fmt_value(v):
    if v is None:
        return ''
    s = str(v)
    # A JSON blob or a long note is still legible as one line if it is short
    # enough, and a day file is read, not parsed — so wrap rather than truncate.
    return s.replace('\r', '').replace('\n', ' ⏎ ')


def _fmt_row(cols, row):
    # Empty columns are omitted: a row that prints only what it says stays
    # readable as the schema grows a dozen nullable columns.
    parts = [f'{c}={_fmt_value(row[c])}' for c in cols
             if row[c] is not None and str(row[c]) != '']
    return ' · '.join(parts)


def _rows_for(conn, table, cols, col, day):
    conn.row_factory = sqlite3.Row
    if table == 'flow_run':
        return _flow_run_rows(conn, day)
    if table == 'gtd_review':
        return conn.execute('SELECT * FROM gtd_review WHERE week_start_date = ?',
                            (storage._week_start(date_cls.fromisoformat(day)),)).fetchall()
    # A UTC column is converted to local first; SQLite reads both shapes the
    # schema produces (naive 'YYYY-MM-DD HH:MM:SS' from datetime('now'), and
    # the scan server's '...Z'). Everything else is a bare local date or a
    # naive local timestamp, where the prefix IS the day.
    if col in UTC_COLS:
        return conn.execute(
            f'''SELECT * FROM "{table}" WHERE date(datetime({col}, 'localtime')) = ?
                ORDER BY {col}''', (day,)).fetchall()
    return conn.execute(
        f'SELECT * FROM "{table}" WHERE {col} LIKE ? ORDER BY {col}', (day + '%',)).fetchall()


def _flow_run_rows(conn, day):
    # A run is filed under its PERIOD (storage.flow_period_key), so a weekly
    # routine's run belongs to every day of its week — otherwise the weekly
    # review would appear in one file a week and be missing from the other six.
    week = storage._week_start(date_cls.fromisoformat(day))
    return conn.execute(
        """SELECT r.*, f.name AS flow_name, COALESCE(f.period, 'day') AS flow_period
             FROM flow_run r JOIN flow f ON f.id = r.flow_id
            WHERE (COALESCE(f.period, 'day') = 'day'  AND r.date = ?)
               OR (COALESCE(f.period, 'day') = 'week' AND r.date = ?)
            ORDER BY f.position, f.id""", (day, week)).fetchall()


def _collect(conn, day):
    """(events, uncovered) for one day. The classification, in one place."""
    events, uncovered = [], []
    for t in _tables(conn):
        if t in SKIP or (t in STATE and t not in STATE_ALSO_DATED):
            continue
        cols = _cols(conn, t)
        col = _time_col(cols, t)
        if col is None:
            uncovered.append(t)
            continue
        try:
            rows = _rows_for(conn, t, cols, col, day)
        except sqlite3.Error as e:
            # A table that cannot be read must SAY so in the file. Silence here
            # is the failure this whole module exists to prevent.
            events.append((t, None, f'could not be read: {e}'))
            continue
        if rows:
            events.append((t, rows, None))
    return events, uncovered


def render_day(day, conn=None):
    """The markdown for one day. Pure apart from the read."""
    close = conn is None
    if conn is None:
        conn = storage.get_conn()
    conn.row_factory = sqlite3.Row
    tables = _tables(conn)
    events, uncovered = _collect(conn, day)

    out = [f'# {day}', '',
           f'_Written by daybook.py. Every row is rendered from the schema as it '
           f'was on {date_cls.today().isoformat()}; column names are the app\'s own._', '']

    if not events:
        out += ['Nothing was recorded on this day.', '']
    for t, rows, err in events:
        out.append(f'## {TITLES.get(t, t)}' + (f'  `{t}`' if t in TITLES else ''))
        out.append('')
        if err:
            out += [f'⚠ {err}', '']
            continue
        cols = _cols(conn, t)
        for r in rows:
            keys = r.keys()          # may exceed cols (flow_run joins the name)
            out.append('- ' + _fmt_row(keys, r))
        out.append('')

    out += ['## The system as it stood', '']
    for t in STATE:
        if t not in tables:
            continue
        rows = conn.execute(f'SELECT * FROM "{t}"').fetchall()
        if not rows:
            continue
        out.append(f'### {t}')
        out.append('')
        for r in rows:
            out.append('- ' + _fmt_row(r.keys(), r))
        out.append('')

    # THE FILE ADMITS ITS OWN GAPS. A table with no time column and no place in
    # STATE is not silently dropped — it is named here with its size, so the
    # next person to read one of these files learns what it does not contain.
    out += ['## Not covered by this file', '']
    if uncovered:
        for t in uncovered:
            n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            out.append(f'- `{t}` — {n} row(s), no time column and not standing state')
    else:
        out.append('- nothing: every table is either dated, standing state, or a cache')
    out += ['', 'Excluded on purpose (caches, derived and retired tables): '
            + ', '.join(f'`{t}`' for t in sorted(SKIP)), '']

    if close:
        conn.close()
    return '\n'.join(out)


def _path(day):
    return os.path.join(DAYBOOK_DIR, day[:4], f'{day}.md')


def write_day(day, force=False):
    """Write one day's file. A PAST day is written once and never rewritten.

    A day with nothing recorded gets NO file (today excepted — it isn't over).
    An absent file reads as "nothing happened here", which is both true and
    shorter than 200 files saying so; and it keeps the history from claiming to
    cover years before the app existed.
    """
    p = _path(day)
    today = date_cls.today().isoformat()
    if os.path.exists(p) and not force and day != today:
        return False
    if day != today and not os.path.exists(p):
        conn = storage.get_conn()
        conn.row_factory = sqlite3.Row
        empty = not _collect(conn, day)[0]
        conn.close()
        if empty:
            return False
    os.makedirs(os.path.dirname(p), exist_ok=True)
    text = render_day(day)
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            if f.read() == text:
                return False
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return True


def _earliest_day(conn):
    # The first day the data knows about, so a catch-up on an old database
    # writes the whole history rather than starting from today.
    best = None
    for t in _tables(conn):
        if t in SKIP or (t in STATE and t not in STATE_ALSO_DATED):
            continue
        cols = _cols(conn, t)
        col = _time_col(cols, t)
        if col is None or t == 'gcal_event':      # gcal reaches into the future
            continue
        expr = f"date(datetime({col}, 'localtime'))" if col in UTC_COLS else col
        try:
            row = conn.execute(f'SELECT MIN({expr}) AS m FROM "{t}"').fetchone()
        except sqlite3.Error:
            continue
        m = row['m'] if row else None
        if not m:
            continue
        d = str(m)[:10]
        if re.match(r'^\d{4}-\d{2}-\d{2}$', d) and (best is None or d < best):
            best = d
    return best


def catch_up(limit_days=400):
    """Write every day file that is missing, up to and including today.

    Bounded: a database whose earliest row is years old should not spend an hour
    of a startup thread rendering empty days, and `limit_days` back from today
    is a history no one is reading on paper anyway.
    """
    conn = storage.get_conn()
    conn.row_factory = sqlite3.Row
    earliest = _earliest_day(conn)
    conn.close()
    today = date_cls.today()
    if not earliest:
        return [today.isoformat()] if write_day(today.isoformat()) else []
    start = max(date_cls.fromisoformat(earliest), today - timedelta(days=limit_days))
    written = []
    d = start
    while d <= today:
        if write_day(d.isoformat()):
            written.append(d.isoformat())
        d += timedelta(days=1)
    return written


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and re.match(r'^\d{4}-\d{2}-\d{2}$', sys.argv[1]):
        print(render_day(sys.argv[1]))
    else:
        w = catch_up()
        print(f'daybook: {len(w)} file(s) written' + (f' ({w[0]} … {w[-1]})' if w else ''))
