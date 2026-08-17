import os
import re
import json
import sqlite3
import time
import uuid

import recurrence
import schedule
import colorsys
from datetime import date as date_cls, datetime, timedelta, timezone

DB_PATH = 'tracker.db'


# 24 evenly-spaced hues (HLS l=.60 s=.55) — muted enough to sit on the dark UI,
# distinct enough to tell ~25 buckets apart at a glance. Bucket colors are drawn
# from here in order (first unused), cycling only past 24.
def _hsl_hex(h):
    r, g, b = colorsys.hls_to_rgb(h / 360.0, 0.60, 0.55)
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))


BUCKET_PALETTE = [_hsl_hex(h) for h in range(0, 360, 15)]


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# THE ONE CLOCK. The whole app dates things in LOCAL time (date_cls.today(),
# naive datetimes, the iCal expansion), so `setting.timezone` is applied by
# setting the PROCESS TZ — no call-site changes anywhere.
#
# It lives HERE, not in app.py, because the setting reaches a process only if
# that process asks for it, and three of them date things: Flask, qr_judge (on
# a systemd timer — it converts scan windows to UTC bounds and decides which
# day is "yesterday", with real money on the answer) and qr_scan_server. The
# judge ran under the OS zone for its whole life while a comment claimed
# otherwise; a VM in one zone and a setting in another judged a satisfied
# night absent. Every entrypoint calls this before touching a date.
def apply_timezone():
    # NEVER set TZ without tzset. Windows has no tzset, and its CRT does not
    # understand IANA names — it reads TZ once, fails to parse
    # 'America/New_York', and falls back to UTC, moving the whole process by
    # hours. That only stayed hidden while this ran late in app.py's import
    # (the CRT had already resolved local time); moving the lever to where it
    # belongs, before anything dates anything, is exactly what would expose it.
    # On Windows the OS zone is therefore the app's zone, deliberately.
    if not hasattr(time, 'tzset'):
        return None
    tz = get_settings().get('timezone')
    if not tz:
        return None
    os.environ['TZ'] = tz
    time.tzset()
    return tz


# "not passed" for the update_* functions, so None can mean "clear it". Defined
# at the top because the partial-update idiom is used all over the file, not
# only by update_inbox_item, which is where it used to sit.
_UNSET = object()


# `project` used to mean GTD's Horizon 2 (a standing area of responsibility);
# it is now `area`, and `project` means Horizon 1 — an outcome that completes.
# This has to run BEFORE the CREATE TABLE block, or `CREATE TABLE IF NOT EXISTS
# area` would make an empty area table and the rename would then be skipped,
# stranding the real rows in `project`.
def _migrate_project_to_area(conn):
    tables = {r['name'] for r in
              conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'project' in tables and 'area' not in tables:
        conn.execute('ALTER TABLE project RENAME TO area')
        conn.commit()
    for t in ('inbox_item', 'recurring_block', 'recurring_task', 'monthly_project_status'):
        if t not in tables:
            continue
        cols = {r['name'] for r in conn.execute(f'PRAGMA table_info({t})')}
        if 'project_id' in cols and 'area_id' not in cols:
            conn.execute(f'ALTER TABLE {t} RENAME COLUMN project_id TO area_id')
            conn.commit()
    # Only now is the name free for the Horizon 1 FK that was called parent_id.
    if 'inbox_item' in tables:
        cols = {r['name'] for r in conn.execute('PRAGMA table_info(inbox_item)')}
        if 'parent_id' in cols and 'project_id' not in cols:
            conn.execute('ALTER TABLE inbox_item RENAME COLUMN parent_id TO project_id')
            conn.commit()


def init_db():
    conn = get_conn()
    _migrate_project_to_area(conn)
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS domain (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS area (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            type TEXT NOT NULL DEFAULT 'standard',
            is_default INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS recurring_block (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            color TEXT NOT NULL,
            day_of_week INTEGER NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            area_id INTEGER REFERENCES area(id),
            location_id INTEGER REFERENCES location(id)
        );

        CREATE TABLE IF NOT EXISTS block_override (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id INTEGER NOT NULL REFERENCES recurring_block(id),
            date TEXT NOT NULL,
            cancelled INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS location (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            radius_m INTEGER NOT NULL DEFAULT 150
        );

        CREATE TABLE IF NOT EXISTS daily_todo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            planning_started_at TEXT,
            planning_finished_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS todo_sync (
            date TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS setting (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS qr_todo_push (
            node_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            PRIMARY KEY (node_id, date)
        );

        CREATE TABLE IF NOT EXISTS inbox_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            captured_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            status TEXT,
            area_id INTEGER REFERENCES area(id),
            defer_until TEXT
        );

        CREATE TABLE IF NOT EXISTS review (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            date TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS gcal_event (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL,
            summary TEXT NOT NULL,
            start TEXT NOT NULL,
            end TEXT NOT NULL,
            allday INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS gcal_recurring_seen (
            uid TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS calendar_source (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            color TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            last_fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS deadline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course TEXT NOT NULL,
            name TEXT NOT NULL,
            due_date TEXT NOT NULL,
            due_time TEXT NOT NULL DEFAULT '',
            done INTEGER NOT NULL DEFAULT 0,
            UNIQUE(course, name, due_date)
        );

        CREATE TABLE IF NOT EXISTS review_annotation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_hash TEXT NOT NULL,
            line_index INTEGER NOT NULL,
            annotation TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS sheets_inbox_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sheets_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            course TEXT NOT NULL,
            due_date TEXT NOT NULL,
            due_time TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS experiment (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            hypothesis TEXT NOT NULL,
            prediction TEXT NOT NULL,
            scope      TEXT NOT NULL DEFAULT 'operating' CHECK(scope IN ('operating','skill')),
            status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','graduated','killed')),
            started_at TEXT NOT NULL,
            ended_at   TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS yearly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            year             INTEGER NOT NULL UNIQUE,
            annual_theme     TEXT,
            major_goals      TEXT,
            paper_notes_path TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS quarterly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            quarter          TEXT NOT NULL UNIQUE,
            theme            TEXT,
            focuses          TEXT,
            hamming_insight  TEXT NOT NULL,
            paper_notes_path TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS life_area_rating (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            quarterly_review_id INTEGER REFERENCES quarterly_review(id),
            yearly_review_id    INTEGER REFERENCES yearly_review(id),
            life_area           TEXT NOT NULL CHECK(life_area IN (
                                    'values_purpose','contribution_impact','location_tangibles',
                                    'money_finances','career_work','health_fitness',
                                    'education_skills','social_relationships',
                                    'emotions_wellbeing','character_identity',
                                    'productivity_organization','adventure_creativity'
                                )),
            rating              INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 7),
            is_bottom_3         INTEGER NOT NULL DEFAULT 0,
            notes               TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS weekly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start_date  TEXT NOT NULL UNIQUE,
            learning_capture TEXT NOT NULL,
            next_focuses     TEXT,
            inbox_cleared_at TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS monthly_review (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            month        TEXT NOT NULL UNIQUE,
            synthesis    TEXT NOT NULL,
            next_focuses TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS monthly_experiment_verdict (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            monthly_review_id INTEGER NOT NULL REFERENCES monthly_review(id),
            experiment_id     INTEGER NOT NULL REFERENCES experiment(id),
            verdict           TEXT NOT NULL CHECK(verdict IN ('graduate','redesign','drop')),
            notes             TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS monthly_project_status (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            monthly_review_id INTEGER NOT NULL REFERENCES monthly_review(id),
            area_id        INTEGER NOT NULL REFERENCES area(id),
            status            TEXT NOT NULL CHECK(status IN ('on_track','stalled','completed')),
            notes             TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS daily_review (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            date           TEXT NOT NULL UNIQUE,
            pdsa_study     TEXT NOT NULL DEFAULT '',
            synthesis      TEXT NOT NULL DEFAULT '',
            tomorrow_focus TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS observation (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL CHECK(kind IN ('interruption','switch','note')),
            block_id    INTEGER REFERENCES recurring_block(id),
            note        TEXT NOT NULL DEFAULT '',
            captured_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS block_feedback (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id INTEGER NOT NULL REFERENCES recurring_block(id),
            date     TEXT NOT NULL,
            positive INTEGER NOT NULL DEFAULT 1,
            UNIQUE(block_id, date)
        );

        -- Right-click timeline dismissals (view-only, persisted across restarts):
        -- type block/qr keyed `id:date`, event keyed `uid|start`.
        CREATE TABLE IF NOT EXISTS timeline_dismissal (
            type       TEXT NOT NULL,
            key        TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            PRIMARY KEY (type, key)
        );

        CREATE TABLE IF NOT EXISTS recurring_task (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            area_id  INTEGER NOT NULL REFERENCES area(id),
            kind        TEXT NOT NULL CHECK(kind IN ('weekly','monthly_nth','monthly_date','every_n_days')),
            days_of_week TEXT,
            nth         INTEGER,
            weekday     INTEGER,
            interval    INTEGER NOT NULL DEFAULT 1,
            anchor_date TEXT NOT NULL,
            last_seeded TEXT,
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS person (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT NOT NULL,
            company           TEXT,
            location          TEXT,
            email             TEXT,
            linkedin          TEXT,
            birthday          TEXT,
            how_we_met        TEXT,
            next_action       TEXT,
            notes             TEXT,
            cadence           TEXT NOT NULL DEFAULT 'none',
            next_due_override TEXT,
            has_contact       INTEGER NOT NULL DEFAULT 0,
            archived          INTEGER NOT NULL DEFAULT 0,
            created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS interaction (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id  INTEGER NOT NULL REFERENCES person(id),
            date       TEXT NOT NULL,
            note       TEXT NOT NULL DEFAULT '',
            source     TEXT NOT NULL DEFAULT 'desktop',
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS bucket (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            name   TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            color  TEXT
        );

        CREATE TABLE IF NOT EXISTS person_bucket (
            person_id INTEGER NOT NULL REFERENCES person(id),
            bucket_id INTEGER NOT NULL REFERENCES bucket(id),
            UNIQUE(person_id, bucket_id)
        );

        CREATE TABLE IF NOT EXISTS crm_night (
            date         TEXT NOT NULL UNIQUE,
            satisfied_at TEXT,
            kind         TEXT
        );

        -- Nightly journal (filled on the sleep-QR phone form, mirrored here).
        -- bottleneck/active_experiment are written the night BEFORE (for this
        -- date); rating/habit_mark the night OF. All nullable — blanks are legal.
        CREATE TABLE IF NOT EXISTS journal_day (
            date              TEXT PRIMARY KEY,
            bottleneck        TEXT NOT NULL DEFAULT '',
            active_experiment TEXT NOT NULL DEFAULT '',
            rating            INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 7),
            habit_mark        TEXT CHECK(habit_mark IS NULL OR habit_mark IN ('ehh','good','great')),
            updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        -- One habit per week, set when the weekly review is filed; runs from
        -- week_start_date until the next weekly review. Rated daily via
        -- journal_day.habit_mark.
        CREATE TABLE IF NOT EXISTS habit_week (
            week_start_date TEXT PRIMARY KEY,
            habit           TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        -- Social gamification: editable point catalog + one row per logged
        -- interaction. points = max(1, value*effort), x1.5 if structural.
        -- Kept separate from the CRM person/interaction tables on purpose.
        CREATE TABLE IF NOT EXISTS social_action (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            label        TEXT NOT NULL UNIQUE,
            category     TEXT NOT NULL,
            value        INTEGER NOT NULL,
            effort       INTEGER NOT NULL,
            structural   INTEGER NOT NULL DEFAULT 0,
            initiation   INTEGER NOT NULL DEFAULT 0,
            once_per_day INTEGER NOT NULL DEFAULT 0,
            points       INTEGER NOT NULL,
            active       INTEGER NOT NULL DEFAULT 1,
            sort_order   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS social_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            action_id  INTEGER NOT NULL REFERENCES social_action(id),
            date       TEXT NOT NULL,
            points     INTEGER NOT NULL,
            person_id  INTEGER,
            note       TEXT NOT NULL DEFAULT '',
            source     TEXT NOT NULL DEFAULT 'desktop',
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
    ''')
    conn.execute(
        # noon UTC so the UTC→local date conversion still lands on Jan 1
        "INSERT OR IGNORE INTO yearly_review (year, annual_theme, major_goals, created_at) VALUES (2026, NULL, NULL, '2026-01-01 20:00:00')"
    )
    conn.commit()
    try:
        conn.execute('SELECT once_per_day FROM social_action LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE social_action ADD COLUMN once_per_day INTEGER NOT NULL DEFAULT 0')
        conn.commit()
    _seed_social_actions(conn)
    conn.execute("INSERT OR IGNORE INTO setting (key, value) VALUES ('social_floor', '40')")
    conn.commit()
    try:
        conn.execute('SELECT type FROM area LIMIT 1')
    except Exception:
        conn.execute("ALTER TABLE project ADD COLUMN type TEXT NOT NULL DEFAULT 'standard'")
        conn.commit()
    try:
        conn.execute('SELECT is_default FROM area LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE project ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0')
        conn.commit()
    exists = conn.execute('SELECT 1 FROM area WHERE is_default = 1').fetchone()
    if not exists:
        conn.execute("INSERT INTO area (name, type, is_default) VALUES ('General', 'standard', 1)")
        conn.commit()
    # Domains are the obligation level ABOVE areas: while one is in force, its
    # areas are the only thing you are supposed to be working on. Every area
    # belongs to exactly one, so the backfill below runs every startup and the
    # default domain can't be deleted — there is no "no domain" state.
    exists = conn.execute('SELECT 1 FROM domain WHERE is_default = 1').fetchone()
    if not exists:
        conn.execute("INSERT INTO domain (name, is_default) VALUES ('General', 1)")
        conn.commit()
    try:
        conn.execute('SELECT domain_id FROM area LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE area ADD COLUMN domain_id INTEGER')
        conn.commit()
    conn.execute('''UPDATE area SET domain_id = (SELECT id FROM domain WHERE is_default = 1)
                    WHERE domain_id IS NULL''')
    conn.commit()
    # A routine can anchor to a QR instead of a block: it nests directly under
    # that QR's hairline on Engage (Morning routine under Wake QR).
    try:
        conn.execute('SELECT qr_node_id FROM area LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE area ADD COLUMN qr_node_id INTEGER')
        conn.commit()
    try:
        conn.execute('SELECT updated_at FROM daily_todo LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE daily_todo ADD COLUMN updated_at TEXT')
        conn.commit()
    try:
        conn.execute('SELECT start_time FROM block_override LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE block_override ADD COLUMN start_time TEXT')
        conn.execute('ALTER TABLE block_override ADD COLUMN end_time TEXT')
        conn.commit()
    conn.execute('DELETE FROM daily_todo WHERE id NOT IN (SELECT MIN(id) FROM daily_todo GROUP BY date)')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_todo_date ON daily_todo (date)')
    conn.commit()
    try:
        conn.execute('SELECT source_id FROM gcal_event LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE gcal_event ADD COLUMN source_id INTEGER')
        conn.execute('DELETE FROM gcal_event')
        conn.execute('DELETE FROM gcal_recurring_seen')
        conn.commit()
    conn.execute('DROP INDEX IF EXISTS idx_gcal_event_uid_start')
    conn.execute('''CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_event_source_uid_start
        ON gcal_event (source_id, uid, start)''')
    conn.commit()
    try:
        conn.execute('SELECT recurring_task_id FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN recurring_task_id INTEGER')
        conn.commit()
    try:
        conn.execute('SELECT location_id FROM recurring_block LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE recurring_block ADD COLUMN location_id INTEGER')
        conn.commit()
    try:
        conn.execute('SELECT now_block FROM observation LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE observation ADD COLUMN now_block TEXT')
        conn.commit()
    try:
        conn.execute('SELECT has_contact FROM person LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE person ADD COLUMN has_contact INTEGER NOT NULL DEFAULT 0')
        conn.commit()
    try:
        conn.execute('SELECT color FROM bucket LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE bucket ADD COLUMN color TEXT')
        conn.commit()
    for i, r in enumerate(conn.execute('SELECT id FROM bucket WHERE color IS NULL ORDER BY id').fetchall()):
        conn.execute('UPDATE bucket SET color = ? WHERE id = ?',
                     (BUCKET_PALETTE[i % len(BUCKET_PALETTE)], r['id']))
    conn.commit()
    # GTD projects (Horizon 1). A project is an inbox_item with kind='project';
    # actions point at it via project_id. area_id stays the AREA on both, so a
    # project and its actions always agree on area.
    try:
        conn.execute('SELECT kind FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute("ALTER TABLE inbox_item ADD COLUMN kind TEXT NOT NULL DEFAULT 'item'")
        conn.commit()
    try:
        conn.execute('SELECT project_id FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN project_id INTEGER')
        conn.commit()
    # How many times "not today" has pushed this item. The daily list never
    # shows it — a running tally there is a guilt tax on a surface you glance at
    # dozens of times a day. It is a WEEKLY REVIEW signal: an item pushed over
    # and over is too big, not real, or being avoided.
    try:
        conn.execute('SELECT pushed FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0')
        conn.commit()
    # Free-form tags: space-separated lowercase tokens ('light errand'). Inert
    # metadata — no cascade, no invariant; the GTD tab and NOW filter on them.
    try:
        conn.execute('SELECT tags FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute("ALTER TABLE inbox_item ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
        conn.commit()
    # Project support material (Allen ch.7): notes that live WITH the project,
    # not on the action lists. Any item can carry them; the GTD projects list
    # is where they're written and read.
    try:
        conn.execute('SELECT notes FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute("ALTER TABLE inbox_item ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
        conn.commit()
    # In-progress mark (long-press on an Engage checkbox): a glance state,
    # not availability — NULL until started, cleared only by completion.
    try:
        conn.execute('SELECT started_at FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN started_at TEXT')
        conn.commit()
    # Delegation (Allen: date everything you hand off): who has it and when to
    # chase. chase_on may stay blank — the date is optional by design.
    try:
        conn.execute('SELECT waiting_on FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN waiting_on TEXT')
        conn.execute('ALTER TABLE inbox_item ADD COLUMN chase_on TEXT')
        conn.commit()
    # Hard due date (YMD) — for REAL deadlines only, on an action or a project.
    # It is display/priority metadata: defer_until stays the start gate, and no
    # availability predicate reads deadline.
    try:
        conn.execute('SELECT deadline FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN deadline TEXT')
        conn.commit()
    # Dependency chains: after_id points at the SIBLING action this one waits
    # on. Blocked = the target row still EXISTS — completion deletes rows here,
    # so a dangling after_id IS the unblock, with no state to maintain. Unlike
    # deadline this one DOES gate availability (a dependent action is not a
    # next action); the predicate lives in the two get_active_items_* WHERE
    # clauses, in lockstep.
    try:
        conn.execute('SELECT after_id FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN after_id INTEGER')
        conn.commit()
    try:
        conn.execute('SELECT project_id FROM recurring_task LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE recurring_task ADD COLUMN project_id INTEGER')
        conn.commit()
    # An occasion's TEMPLATE actions are ordinary inbox_item rows carrying
    # status 'occasion'. That status is what keeps them out of the inventory
    # with no query edits anywhere: every availability predicate wants
    # status = 'active', MAP wants active/waiting/on_hold, the inbox wants a
    # NULL status, and the review counts name their statuses one by one. A
    # template matches none of them. Minting COPIES the row into a real active
    # item; the template itself is never scheduled and never completes.
    try:
        conn.execute('SELECT occasion_id FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN occasion_id INTEGER')
        conn.commit()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS gtd_review (
            week_start_date TEXT PRIMARY KEY,
            steps           TEXT NOT NULL DEFAULT '{}',
            note            TEXT NOT NULL DEFAULT '',
            started_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            completed_at    TEXT
        )''')
    # Engage-panel day placements: an action dropped between the day's fixed
    # points (events/QRs/blocks). minute is a semantic-minute sort key, NOT a
    # commitment — the item itself stays an ordinary next action.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS engage_placement (
            date    TEXT NOT NULL,
            item_id INTEGER NOT NULL,
            minute  REAL NOT NULL,
            PRIMARY KEY (date, item_id)
        )''')
    # OCCASIONS: the actions a KIND of event always brings with it.
    #
    # An occasion is recognised by TEXT, not by a calendar series uid: the same
    # meeting is often booked ad hoc — Tuesday 14:00, then Friday 17:00 — as two
    # unrelated events with two different uids, so a uid rule would fire on
    # neither. `match_text` is a case-insensitive substring of the event's
    # summary, which is the one thing both bookings share.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS occasion (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            match_text TEXT NOT NULL,
            active     INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    # One row per (day, template) the moment it is minted — and it OUTLIVES the
    # item, which is the whole point: completing a minted action DELETES the row
    # (see delete_inbox_item), so "has this already been minted today" cannot be
    # answered by looking for the item. Without this table the day would re-mint
    # every action the moment you finished it.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS occasion_mint (
            date        TEXT NOT NULL,
            template_id INTEGER NOT NULL,
            item_id     INTEGER,
            PRIMARY KEY (date, template_id)
        )''')
    # Routine checklists: their OWN datatype, attached to a routine-type AREA
    # — not inbox items, not recurring-task seeds. done_date makes the check
    # daily: checked iff done_date == today, so it resets itself at midnight.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS routine_item (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            area_id   INTEGER NOT NULL,
            content   TEXT NOT NULL,
            position  INTEGER NOT NULL DEFAULT 0,
            done_date TEXT
        )''')
    # GTD Reference: non-actionable keeps (books, movies, gifts, places…).
    # Their OWN datatype, deliberately OUTSIDE the inbox_item inventory — no
    # availability predicate, no MAP row, no review count reads these. Unlike
    # routine_item's daily done_date, ref_item.done is PERMANENT (a book read
    # stays read).
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ref_list (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    # Interactive routines (surface name; 'flow' because routine_item was
    # taken by the area checklists). A flow is an ORDERED list of steps run
    # page-by-page; steps are plain text (soft = a smaller version still
    # credits, hard = the real thing or nothing) or FEATURE pages (social
    # spec, nightly journal, CRM fill). flow_run is the per-day wizard state,
    # so a half-finished routine resumes. qr_node_id/offset_min/before_node_id
    # anchor the deadline to a QR and (per 2026-08-07 decision, reversing
    # presence-only) gate that QR's judgment on completion — the Worker learns
    # the link via /internal/routine-config and completion via
    # /internal/routine-done.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS flow (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            name           TEXT NOT NULL,
            position       INTEGER NOT NULL DEFAULT 0,
            qr_node_id     INTEGER,
            offset_min     INTEGER,
            before_node_id INTEGER
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS flow_step (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            flow_id     INTEGER NOT NULL REFERENCES flow(id),
            position    INTEGER NOT NULL DEFAULT 0,
            kind        TEXT NOT NULL DEFAULT 'text',
            content     TEXT NOT NULL DEFAULT '',
            requirement TEXT NOT NULL DEFAULT 'hard'
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS flow_run (
            flow_id      INTEGER NOT NULL,
            date         TEXT NOT NULL,
            steps        TEXT NOT NULL DEFAULT '{}',
            completed_at TEXT,
            PRIMARY KEY (flow_id, date)
        )''')
    # PAUSING is a verb every settings item now has (2026-08-15): areas,
    # recurring tasks, calendars, gates and blocks already carried `active`, so
    # domains and locations get the same column rather than a second idiom.
    # Paused means "stop offering it" — never a deletion, and never a change to
    # anything already pointing at it (a gate copies a location's coordinates,
    # it does not reference them).
    for table in ('domain', 'location'):
        try:
            conn.execute(f'SELECT active FROM {table} LIMIT 1')
        except Exception:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
            conn.commit()
    # Which days a routine step runs. Same grammar the rest of the app already
    # speaks — a digit string, '0'=Mon..'6'=Sun, NULL = every day (exactly how
    # recurring_task.days_of_week and nodes.days_of_week read). NULL meaning
    # every day is what keeps every step written before this column running.
    try:
        conn.execute('SELECT days_of_week FROM flow_step LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow_step ADD COLUMN days_of_week TEXT')
        conn.commit()
    # ONE recurrence grammar for everything that repeats (RFC 5545 RRULE, see
    # recurrence.py). Both tables keep their older, narrower columns as the
    # fallback: rrule wins where it is set, so nothing written before this
    # has to be migrated and the two can coexist indefinitely.
    for table in ('recurring_task', 'flow_step'):
        try:
            conn.execute(f'SELECT rrule FROM {table} LIMIT 1')
        except Exception:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN rrule TEXT')
            conn.commit()
    # A rule needs a start date to have a PHASE: "every 10 days" is meaningless
    # without one, and anchoring it to a fixed epoch would put the cycle on an
    # arbitrary footing the user never chose. recurring_task already has
    # anchor_date; flow_step gets its own, stamped when a rule is set.
    try:
        conn.execute('SELECT dtstart FROM flow_step LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow_step ADD COLUMN dtstart TEXT')
        conn.commit()
    # TIME PRESETS — RETIRED 2026-08-11, superseded by schedule_source (a
    # preset was a Rule in all but name). The table is kept unread: it is the
    # only copy of what _migrate_time_presets derived the rule sources from, so
    # dropping it would make a bad conversion unrecoverable. Nothing reads it.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS time_preset (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            rrule      TEXT,
            start_time TEXT,
            end_time   TEXT,
            dtstart    TEXT
        )''')
    # The three things a CONTEXT TAG can be bound to. One row per tag per axis,
    # keyed by the tag string — tags have no id, they are just tokens in
    # inbox_item.tags, which is what keeps them free to invent.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_time (
            tag        TEXT PRIMARY KEY,
            source_uid TEXT NOT NULL REFERENCES schedule_source(uid)
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_device (
            tag    TEXT PRIMARY KEY,
            device TEXT NOT NULL
        )''')
    # A tag ASKED ABOUT EACH DAY (2026-08-12). Some contexts are contingent on
    # the day rather than on a place, a device or a clock: whether you will see
    # a particular person. `tag_daily` is which tags to ask about; `tag_day` is
    # the answer for one date. NO ROW MEANS NO EXCLUSION (Quentin) — skipping
    # the morning routine must never hide work, exactly like the other three
    # gates fail open. Only an explicit "not today" hides anything, and the pool
    # header counts what it hid.
    # ── Self-monitoring (2026-08-16) ─────────────────────────
    #
    # A metric is a QUESTION you answer on a routine step, and `metric_entry` is
    # the answers. The definition/instance split is the one flow/flow_run and
    # ref_list/ref_item already use.
    #
    # `metric_step` is a JOIN, not a column on metric, because a metric may be
    # asked TWICE A DAY (Quentin, 2026-08-16): morning AND night. That is also
    # why an entry records the STEP that asked it — without it the night answer
    # would land on the morning's row and silently overwrite it.
    #
    # There is no time-of-day column anywhere here. The routine already knows
    # when it runs, so "morning" and "night" are WHICH ROUTINE the step is in;
    # a `when` field would be a second grammar for what the calendar answers.
    #
    # NO ROW MEANS NO DATA — never zero. Same rule as tag_day above: skipping
    # the routine must leave the series silent rather than record a false zero,
    # which would lie in the one direction that ruins a trend.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS metric (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            name      TEXT NOT NULL,
            kind      TEXT NOT NULL DEFAULT 'scale',
            prompt    TEXT NOT NULL DEFAULT '',
            scale_min INTEGER NOT NULL DEFAULT 1,
            scale_max INTEGER NOT NULL DEFAULT 7,
            unit      TEXT NOT NULL DEFAULT '',
            active    INTEGER NOT NULL DEFAULT 1,
            position  INTEGER NOT NULL DEFAULT 0,
            -- WHICH DAYS this question is asked on, in the app's one weekday
            -- grammar ('0'=Mon … '6'=Sun; NULL = every day, see step_due_on).
            -- A SECOND filter under the step's own days, not a copy of them:
            -- the step decides whether the routine asks anything today, this
            -- decides whether THIS question is one of the things it asks.
            days_of_week TEXT
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS metric_step (
            metric_id INTEGER NOT NULL REFERENCES metric(id),
            step_id   INTEGER NOT NULL REFERENCES flow_step(id),
            PRIMARY KEY (metric_id, step_id)
        )''')
    # value_num carries scale, count and yes/no (0/1); value_text carries text.
    # Both nullable: an entry exists only because something was answered, and
    # which column holds it is the metric's kind, not a guess.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS metric_entry (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT NOT NULL,
            metric_id  INTEGER NOT NULL REFERENCES metric(id),
            step_id    INTEGER NOT NULL,
            value_num  REAL,
            value_text TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE (date, metric_id, step_id)
        )''')
    # Here rather than with the other ALTERs above: those run before this block,
    # and on a fresh database there is no `metric` table yet to alter.
    try:
        conn.execute('SELECT days_of_week FROM metric LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE metric ADD COLUMN days_of_week TEXT')
        conn.commit()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_daily (
            tag TEXT PRIMARY KEY
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_day (
            tag     TEXT NOT NULL,
            date    TEXT NOT NULL,
            applies INTEGER NOT NULL,
            PRIMARY KEY (tag, date)
        )''')
    # A tag bound to a location preset: items carrying the tag are only
    # AVAILABLE (pool-side, client-enforced) while the device is inside that
    # location's geofence. GTD's @contexts, literally.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_location (
            tag         TEXT PRIMARY KEY,
            location_id INTEGER NOT NULL REFERENCES location(id)
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ref_item (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id    INTEGER NOT NULL REFERENCES ref_list(id),
            content    TEXT NOT NULL,
            done       INTEGER NOT NULL DEFAULT 0,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    # Social exposure v1 (dryrun — no money path). The GRID: every social move
    # is a cell of axis levels; a rep's price is the sum of its levels' ratings
    # (the calibration). Distinct from the dormant social_action/social_log
    # points system — different currency (anticipatory pressure, not
    # value×effort), so a separate datatype rather than a migration.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS social_axis_level (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            axis     TEXT NOT NULL,
            label    TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            rating   INTEGER,
            UNIQUE (axis, label)
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS social_rep (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT NOT NULL,
            family     TEXT NOT NULL,
            levels     TEXT NOT NULL DEFAULT '{}',
            price      INTEGER NOT NULL,
            planned    INTEGER NOT NULL DEFAULT 0,
            person     TEXT NOT NULL DEFAULT '',
            pre_rating INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS social_spec (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT NOT NULL,
            family     TEXT NOT NULL,
            levels     TEXT NOT NULL DEFAULT '{}',
            person     TEXT NOT NULL DEFAULT '',
            opener     TEXT NOT NULL DEFAULT '',
            price      INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    # A day used to hold ONE spec (date was the primary key); a plan can be
    # several interactions now (2026-08-11), so specs are id-keyed rows. The
    # old shape has no id column — rebuild in place, keeping the rows.
    try:
        conn.execute('SELECT id FROM social_spec LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE social_spec RENAME TO social_spec_v1')
        conn.execute('''
            CREATE TABLE social_spec (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                date       TEXT NOT NULL,
                family     TEXT NOT NULL,
                levels     TEXT NOT NULL DEFAULT '{}',
                person     TEXT NOT NULL DEFAULT '',
                opener     TEXT NOT NULL DEFAULT '',
                price      INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )''')
        conn.execute('''INSERT INTO social_spec
                        (date, family, levels, person, opener, price, created_at)
                        SELECT date, family, levels, person, opener, price, created_at
                        FROM social_spec_v1''')
        conn.execute('DROP TABLE social_spec_v1')
        conn.commit()
    # QR accountability (2026-08-08, migrated off Cloudflare Workers + D1).
    # Prefixed qr_ because 'nodes' is too generic to share a 50-table schema.
    # The Worker's routine gate, /todo page and phone capture pages are NOT
    # ported: in-app flows replaced them, so a QR URL is location proof again.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qr_node (
            id                     INTEGER PRIMARY KEY,
            label                  TEXT NOT NULL,
            token                  TEXT UNIQUE NOT NULL,
            window_start           TEXT NOT NULL,
            window_end             TEXT NOT NULL,
            window_end_offset_days INTEGER DEFAULT 0,
            geofence_lat           REAL,
            geofence_lng           REAL,
            geofence_radius_m      INTEGER,
            active                 INTEGER DEFAULT 1,
            days_of_week           TEXT NOT NULL DEFAULT '0123456',
            weekly_windows         TEXT
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qr_scan (
            id            INTEGER PRIMARY KEY,
            node_id       INTEGER NOT NULL REFERENCES qr_node(id),
            scanned_at    TEXT NOT NULL,
            lat           REAL,
            lng           REAL,
            geofence_pass INTEGER,
            accuracy_m    REAL
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qr_override (
            id                     INTEGER PRIMARY KEY,
            node_id                INTEGER NOT NULL REFERENCES qr_node(id),
            date                   TEXT NOT NULL,
            window_start           TEXT NOT NULL,
            window_end             TEXT NOT NULL,
            window_end_offset_days INTEGER DEFAULT 0,
            UNIQUE(node_id, date)
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qr_pending_change (
            id        INTEGER PRIMARY KEY,
            node_id   INTEGER NOT NULL REFERENCES qr_node(id),
            field     TEXT NOT NULL,
            new_value TEXT NOT NULL,
            apply_at  TEXT NOT NULL
        )''')
    # ONE EASING STORE (2026-08-17). The 24h delay had two implementations
    # wearing one name: this qr_pending_change table for gates, and a JSON blob
    # on flow / flow_step for routines. Two stores, two appliers, two cancel
    # paths — and the doors that bypassed both (delete_flow, update_schedule_
    # source) were not bypassing anything in particular, because there was no
    # single thing to bypass. "Every door owes the rule" is only enforceable
    # when there is one door.
    #
    # kind is the owning table ('gate' for qr_node, 'flow', 'flow_step'), and
    # the PRIMARY KEY is the per-field guarantee: queueing a second easing can
    # never silently delete another field's countdown, which the one-slot blob
    # did. qr_pending_change and the two `pending` columns are kept as the
    # MIGRATION SOURCE and never written again — the same reason
    # gtd_review.steps and time_preset are still there.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS easing_pending (
            kind     TEXT NOT NULL,
            row_id   INTEGER NOT NULL,
            field    TEXT NOT NULL,
            value    TEXT,
            apply_at TEXT NOT NULL,
            PRIMARY KEY (kind, row_id, field)
        )''')
    # UNIQUE(node_id, date) is the reservation that stops a re-judge — the
    # judge INSERTs before acting, so a second tick is a no-op rather than a
    # duplicate. Kept from the Worker verbatim; it was the anti-double-charge
    # guard and it is still the anti-double-judge guard.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS qr_charge_log (
            id             INTEGER PRIMARY KEY,
            node_id        INTEGER NOT NULL REFERENCES qr_node(id),
            date           TEXT NOT NULL,
            failure_reason TEXT,
            charge_status  TEXT,
            charge_ref     TEXT,
            amount_cents   INTEGER,
            created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(node_id, date)
        )''')
    # THE SCHEDULE STORE (2026-08-11) — one occurrence source, three
    # constructors; see schedule.py and CLAUDE.md's "Schedule model". Columns
    # are JSCalendar (RFC 8984) field names, so what is stored reads as the
    # standard rather than as a private vocabulary; `kind`, `ends` and
    # `follows` are the three sf: additions. A NULL title is an UNNAMED source,
    # private to whatever holds it — naming is what makes it shared, which is
    # why only named ones appear in Settings → Times.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS schedule_source (
            uid              TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            title            TEXT,
            start            TEXT,
            duration         TEXT,
            recurrence_rules TEXT,
            overrides        TEXT,
            entries          TEXT,
            follows          TEXT,
            ends             TEXT,
            used_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )''')
    _migrate_time_presets(conn)
    _repair_time_preset_conversion(conn)
    _adopt_gate_schedules(conn)
    _migrate_easing_pendings(conn)
    _migrate_utc_stamps(conn)
    # Pawning a routine step onto a later routine — see pawn_flow_step. Three
    # lazy ALTERs: two settings and one per-day state — plus (2026-08-11) the
    # NAMED soft version, the checklist link, and the 24h easing gate
    # (`pending` JSON {field, value, apply_at}, applied on read — see
    # apply_due_flow_pendings).
    # `duration_min` (2026-08-16) is how long the step TAKES — a description of
    # the step, NULL when you have not said. Deliberately not the same field as
    # `pawn_minutes`, which is what carrying the step COSTS the routine that
    # receives it: that one shortens a gate on the money path, so the two stay
    # independent and setting a duration never moves a deadline.
    for column, ddl in (('pawn_to_flow_id', 'INTEGER'),
                        ('pawn_minutes', 'INTEGER'),
                        ('pawned_date', 'TEXT'),
                        ('soft_content', 'TEXT'),
                        ('ref_list_id', 'INTEGER'),
                        ('duration_min', 'INTEGER'),
                        ('pending', 'TEXT')):
        try:
            conn.execute(f'SELECT {column} FROM flow_step LIMIT 1')
        except Exception:
            conn.execute(f'ALTER TABLE flow_step ADD COLUMN {column} {ddl}')
            conn.commit()
    try:
        conn.execute('SELECT pending FROM flow LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow ADD COLUMN pending TEXT')
        conn.commit()
    # A ROUTINE HOLDS ITS OWN WINDOW (2026-08-12): open at one time, due at
    # another, set independently of the gate it gates. `offset_min` stays as the
    # fallback for routines that never got one — the source WINS where set, the
    # same additive shape gates use. Because it is a schedule source it can also
    # be DERIVED: "ends 30 min before the work scan closes" is one follow.
    try:
        conn.execute('SELECT source_uid FROM flow LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow ADD COLUMN source_uid TEXT')
        conn.commit()
    # How OFTEN a routine runs (2026-08-12). NULL/'day' = the daily routine every
    # flow was until now; 'week' = once per week, which is what the weekly review
    # is. It changes exactly one thing: the KEY a flow_run is filed under
    # (flow_period_key) — a weekly run is keyed by its Monday, so ticking on
    # Saturday and finishing on Sunday are the same run. Everything else about a
    # flow is unchanged.
    try:
        conn.execute('SELECT period FROM flow LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow ADD COLUMN period TEXT')
    # A ROUTINE CAN ALSO BE A TASK (2026-08-16). Running it was only ever
    # reachable from the Lists surface or the GTD fold-out's ▶ — so a routine
    # you do weekly was invisible on the day you were supposed to do it. With
    # `as_task` on, the routine seeds an ordinary next action on the days it
    # runs, and that action is the door back into the runner.
    #
    # `days_of_week` is the app's one weekday grammar ('0'=Mon … '6'=Sun, NULL =
    # every day) read by the same step_due_on predicate — on the FLOW it says
    # which day the task appears, which is a different question from which day a
    # STEP is due, and the two never meet.
    try:
        conn.execute('SELECT as_task FROM flow LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow ADD COLUMN as_task INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE flow ADD COLUMN days_of_week TEXT')
        conn.execute('ALTER TABLE flow ADD COLUMN area_id INTEGER')
        conn.commit()
    # The seeded action's way back to the routine that made it.
    try:
        conn.execute('SELECT flow_id FROM inbox_item LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE inbox_item ADD COLUMN flow_id INTEGER')
        conn.commit()
    # ONE row per routine per PERIOD, written the moment its task is seeded and
    # OUTLIVING that task — the same reason occasion_mint is a table and not a
    # lookup. Completing an action deletes the row, so "is one already out
    # there?" cannot be answered by looking for one: without this ledger,
    # ticking the task off would re-seed it on the very next pool read and the
    # task could never be finished at all.
    #
    # Keyed by the flow's period (storage.flow_period_key), so a daily routine
    # asks again tomorrow and a weekly one not until next week.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS flow_task_seed (
            flow_id INTEGER NOT NULL,
            date    TEXT NOT NULL,
            item_id INTEGER,
            PRIMARY KEY (flow_id, date)
        )''')
    conn.commit()
    _seed_review_flow(conn)
    _backfill_review_steps(conn)
    _merge_review_next_actions(conn)
    # Reference lists NEST (2026-08-11): a list can live inside a list. The
    # split at the root is what the index shows; delete splices children up a
    # level, the same rule projects follow.
    try:
        conn.execute('SELECT parent_id FROM ref_list LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE ref_list ADD COLUMN parent_id INTEGER')
        conn.commit()
    # Habits v2 (2026-08-11). An EXPERIMENT is an object with an ending: it
    # runs (one at a time), resolves with a note, and is EVALUATED only at the
    # weekly review — extend / habit / drop. A HABIT is a standing commitment
    # rated nightly on two axes: mark (adherence — did it happen) and effort
    # (automaticity — did it run on its own; SRBAI-style, asked not inferred).
    # Value is the experiment's question and is settled before a habit exists,
    # which is why habit_day carries no 1-7. habit_week stays untouched as
    # read-only history.
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS habit_experiment (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT NOT NULL,
            started_on   TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'running',
            resolution   TEXT,
            resolved_on  TEXT,
            outcome      TEXT,
            evaluated_on TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS habit (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            content       TEXT NOT NULL,
            started_on    TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'forming',
            verdict       TEXT,
            ended_on      TEXT,
            experiment_id INTEGER,
            created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS habit_day (
            habit_id INTEGER NOT NULL,
            date     TEXT NOT NULL,
            mark     TEXT CHECK(mark IS NULL OR mark IN ('ehh','good','great')),
            effort   TEXT CHECK(effort IS NULL OR effort IN ('auto','deliberate')),
            PRIMARY KEY (habit_id, date)
        );
    ''')
    _seed_social_axes(conn)
    conn.commit()
    conn.close()


# The time presets were the closest thing the app already had to a Rule: a name,
# the DAYS as an RRULE, and a time-of-day window. They become rule sources, and
# the tag bindings follow them by uid — a preset's id was an integer and a
# source's identity is a uid, so the binding table is rebuilt rather than
# widened. Runs once; the marker is tag_time already having source_uid.
def _migrate_time_presets(conn):
    cols = [r[1] for r in conn.execute('PRAGMA table_info(tag_time)').fetchall()]
    if 'preset_id' not in cols:
        return                      # fresh database, or already migrated
    presets = conn.execute('SELECT * FROM time_preset').fetchall()
    mapping = {}
    for p in presets:
        uid = _new_uid('rule')
        mapping[p['id']] = uid
        start_time = p['start_time'] or '00:00'
        # A preset with no dtstart was answered against RRULE_EPOCH, so it was
        # due on ANY date. Anchoring the converted rule to today instead would
        # silently empty every PAST date — which the pool's time gate reads
        # whenever you look at a day that isn't today.
        anchor = p['dtstart'] or RRULE_EPOCH.isoformat()
        rules = schedule.rules_from_rrule(p['rrule'])
        conn.execute(
            'INSERT INTO schedule_source (uid, kind, title, start, duration,'
            ' recurrence_rules, ends) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (uid, 'rule', p['name'], f'{anchor[:10]}T{start_time}:00',
             _window_duration(p['start_time'], p['end_time']),
             json.dumps(rules), None))
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tag_time_new (
            tag        TEXT PRIMARY KEY,
            source_uid TEXT NOT NULL REFERENCES schedule_source(uid)
        )''')
    for row in conn.execute('SELECT tag, preset_id FROM tag_time').fetchall():
        uid = mapping.get(row['preset_id'])
        if uid:
            conn.execute('INSERT OR REPLACE INTO tag_time_new (tag, source_uid)'
                         ' VALUES (?, ?)', (row['tag'], uid))
    conn.execute('DROP TABLE tag_time')
    conn.execute('ALTER TABLE tag_time_new RENAME TO tag_time')
    # time_preset itself is left in place, unread. It is the only copy of what
    # the migration was derived from, and dropping it would make a bad
    # conversion unrecoverable.
    conn.commit()


# The first version of the migration above shipped (swept into 50a217a and
# pushed before it was finished) with two defaults that narrowed what a preset
# meant, and it is ONE-SHOT — the guard is tag_time no longer having preset_id,
# so fixing the derivation does not re-derive anything already converted. This
# repairs those rows instead:
#
#   1. A preset with no dtstart was due on ANY date (it was answered against
#      RRULE_EPOCH). Anchoring the rule to the deploy date emptied every past
#      date, which the pool's time gate reads whenever you look at another day.
#   2. A preset with no end_time meant "until midnight", and one with no window
#      at all meant "all of those days". A null duration means a MOMENT, so a
#      tag bound to such a preset was gated to a single instant.
#
# Safe to run every start-up: it rewrites a row only when the row still holds
# exactly what the buggy derivation produced from the preset it came from, so a
# source that has since been edited in the picker is left alone, and a correct
# row is already equal to its target and is skipped.
def _repair_time_preset_conversion(conn):
    try:
        presets = conn.execute('SELECT * FROM time_preset').fetchall()
    except sqlite3.OperationalError:
        return                       # no legacy table, nothing to repair
    for p in presets:
        want_rules = json.dumps(schedule.rules_from_rrule(p['rrule']))
        rows = conn.execute(
            'SELECT * FROM schedule_source WHERE kind = ? AND title IS ?'
            ' AND recurrence_rules = ?', ('rule', p['name'], want_rules)).fetchall()
        if len(rows) != 1:
            continue                 # ambiguous or already reshaped — leave it
        row = rows[0]
        anchor = p['dtstart'] or RRULE_EPOCH.isoformat()
        want_start = f"{anchor[:10]}T{p['start_time'] or '00:00'}:00"
        want_duration = _window_duration(p['start_time'], p['end_time'])
        # Untouched means the TIME OF DAY is still the preset's, and the date is
        # either already right or is the deploy date the bug stamped on it (only
        # possible when the preset had no dtstart of its own). Anything else is
        # somebody's edit, and their value wins.
        same_time = row['start'][11:16] == (p['start_time'] or '00:00')
        date_ok = row['start'][:10] == want_start[:10] or not p['dtstart']
        if not (same_time and date_ok):
            continue
        if row['start'] == want_start and row['duration'] == want_duration:
            continue                 # already correct
        conn.execute('UPDATE schedule_source SET start = ?, duration = ? WHERE uid = ?',
                     (want_start, want_duration, row['uid']))
    conn.commit()


# A gate's hours become a schedule source (2026-08-11). Additive, the way every
# other adoption in this repo is: `qr_node.source_uid` WINS where set, and
# window_start / window_end / window_end_offset_days / days_of_week /
# weekly_windows stay as the fallback and as the record the conversion came from.
# Nothing is dropped, so a bad conversion is re-derivable and the Worker-side
# copy of those columns keeps working.
#
# The shape falls out of the data: a gate with no per-day windows is ONE rule; a
# gate with weekly_windows is a SCHEDULE, one rule per day, each with its own
# duration — which is exactly the case the model exists for ("Wednesday is
# shorter"). The source is UNNAMED, so a gate's hours stay private to it and
# Settings → Times is not filled with one entry per gate; naming one in the
# picker is what would share it.
# One-time, and idempotent: it only ever moves rows that are still in the old
# stores, and it empties them as it goes, so a second run finds nothing.
# THE UTC STAMPS (2026-08-17). SQLite's datetime('now') is UTC and does NOT
# follow setting.timezone, while the whole app dates in LOCAL — so every
# column defaulting to it was stamped hours ahead. Anything captured after
# ~20:00 EDT carried tomorrow's date: it never appeared in its own daybook
# file (and a past day is written once, so it could be lost outright) and
# clarify showed it captured a day late.
#
# The DEFAULTs now say 'localtime'. This converts what was already written,
# ONCE — and CLAUDE.md is right that history must not be rewritten SILENTLY,
# so it records what it did in a setting rather than doing it quietly. The
# alternative was worse than the bug: half a column in UTC and half in local,
# with nothing to tell them apart.
#
# The SETTING is the only guard against a double shift — the conversion is not
# idempotent by shape, because a converted stamp still looks like one. Do not
# clear utc_stamps_localised to "re-run" it.
#
# It converts ONLY the shape SQLite's default produces — 'YYYY-MM-DD HH:MM:SS',
# space-separated, no zone. Every stamp written by Python is ISO with a 'T'
# (and often an offset), carries its own convention, and is left alone. That
# is what keeps flow_run.completed_at, journal_day.updated_at and the scan
# server's '...Z' out of this.
_UTC_SHAPE = "%_-__-__ __:__:__"


def _migrate_utc_stamps(conn):
    if conn.execute("SELECT value FROM setting WHERE key = 'utc_stamps_localised'"
                    ).fetchone():
        return
    pairs = []
    for r in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table'").fetchall():
        for line in (r['sql'] or '').splitlines():
            if 'datetime(' in line and "'now'" in line and 'DEFAULT' in line:
                pairs.append((r['name'], line.strip().split()[0]))
    moved = 0
    for table, col in pairs:
        try:
            cur = conn.execute(
                f'''UPDATE "{table}" SET {col} = datetime({col}, 'localtime')
                    WHERE {col} LIKE ? AND length({col}) = 19''', (_UTC_SHAPE,))
            moved += cur.rowcount or 0
        except sqlite3.OperationalError:
            continue
    conn.execute(
        "INSERT OR REPLACE INTO setting (key, value) VALUES ('utc_stamps_localised', ?)",
        (f'{date_cls.today().isoformat()}: {moved} stamp(s) UTC->local '
         f'across {len(pairs)} column(s)',))
    conn.commit()
    if moved:
        print(f'timezone: localised {moved} UTC stamp(s) written before the '
              f'DEFAULTs were fixed')


def _migrate_easing_pendings(conn):
    # `value` is JSON in the new store, always. The gate table's new_value was
    # raw TEXT NOT NULL, which quietly turned a False into 0 and None into an
    # error; the flow blob already held native JSON. One encoding, decoded in
    # one place (_pending_value).
    try:
        rows = conn.execute('SELECT * FROM qr_pending_change').fetchall()
    except sqlite3.OperationalError:
        rows = []
    for r in rows:
        conn.execute(
            '''INSERT OR IGNORE INTO easing_pending (kind, row_id, field, value, apply_at)
               VALUES (?,?,?,?,?)''',
            ('gate', r['node_id'], r['field'], json.dumps(r['new_value']),
             r['apply_at']))
    if rows:
        conn.execute('DELETE FROM qr_pending_change')
    for table in ('flow', 'flow_step'):
        try:
            live = conn.execute(
                f'SELECT id, pending FROM {table} WHERE pending IS NOT NULL').fetchall()
        except sqlite3.OperationalError:
            continue
        for r in live:
            for pnd in _pendings(r['pending']):
                conn.execute(
                    '''INSERT OR IGNORE INTO easing_pending
                         (kind, row_id, field, value, apply_at)
                       VALUES (?,?,?,?,?)''',
                    (table, r['id'], pnd.get('field'),
                     json.dumps(pnd.get('value')), pnd.get('apply_at')))
            conn.execute(f'UPDATE {table} SET pending = NULL WHERE id = ?', (r['id'],))
    conn.commit()


def _adopt_gate_schedules(conn):
    cols = [r[1] for r in conn.execute('PRAGMA table_info(qr_node)').fetchall()]
    if not cols:
        return
    if 'source_uid' not in cols:
        conn.execute('ALTER TABLE qr_node ADD COLUMN source_uid TEXT')
        conn.commit()
    rows = conn.execute('SELECT * FROM qr_node WHERE source_uid IS NULL').fetchall()
    for n in rows:
        uid = _gate_source_from_windows(conn, n)
        conn.execute('UPDATE qr_node SET source_uid = ? WHERE id = ?', (uid, n['id']))
    if rows:
        conn.commit()


def qr_ensure_node_source(node_id):
    """Derive a gate's source from its window columns if it has none yet. Called
    when a gate is created, so a new gate arrives with a schedule rather than
    waiting for the next start-up's adoption pass."""
    conn = get_conn()
    row = conn.execute('SELECT * FROM qr_node WHERE id = ?', (node_id,)).fetchone()
    if row is None or row['source_uid']:
        conn.close()
        return None
    uid = _gate_source_from_windows(conn, row)
    conn.execute('UPDATE qr_node SET source_uid = ? WHERE id = ?', (uid, node_id))
    conn.commit()
    conn.close()
    return uid


def qr_windows_from_source(uid, days=21):
    """The legacy window columns a gate needs, derived from a source.

    A gate created from the picker has no window fields of its own, but
    `window_start` / `window_end` / `days_of_week` are still the fallback and are
    what the Worker-side copy reads, so they are derived here rather than left to
    a default that would disagree with the schedule.
    """
    resolve, _ = schedule_resolver()
    src = resolve(uid)
    if not src:
        return {}
    today = date_cls.today()
    try:
        occs = schedule.occurrences(src, resolve, today, today + timedelta(days=days))
    except schedule.Cycle:
        return {}
    if not occs:
        return {}
    # days_of_week is Mon=0..Sun=6 (qr_judge._dow_of uses weekday()), which is
    # the same convention as weekly_windows' keys.
    dows = sorted({str(s.weekday()) for s, _ in occs})
    first_start, first_end = occs[0]
    return {
        'window_start': first_start.strftime('%H:%M'),
        'window_end': first_end.strftime('%H:%M'),
        'window_end_offset_days': (first_end.date() - first_start.date()).days,
        'days_of_week': ''.join(dows),
    }


def qr_gate_day_windows(node, days=17, start=None):
    """The gate's effective window for each of `days` dates, as the JUDGE
    resolves it (qr_judge.resolve_window). The client is given this rather
    than a rule, so the timeline, the engage day and the panel cannot disagree
    with what will actually be judged.

    Starts THREE DAYS BACK by default, matching navBounds()' clamp: the client
    looks a date up exactly, so a past day inside the nav range must be in the
    map or it falls back to scanning for a weekday — which is the flattening
    this map exists to replace."""
    import qr_judge
    start = start or (date_cls.today() - timedelta(days=3))
    resolve, _ = schedule_resolver()
    out = {}
    for i in range(days):
        day = (start + timedelta(days=i)).isoformat()
        if not qr_judge.applies_on(node, day):
            continue
        w = qr_judge.resolve_window(node, day)
        out[day] = {'window_start': w[0], 'window_end': w[1],
                    'window_end_offset_days': w[2]}
    return out


def _gate_source_from_windows(conn, node):
    """One rule, or a schedule of per-day rules. Returns the new source's uid."""
    days = str(node['days_of_week'] or '0123456')
    weekly = {}
    if node['weekly_windows']:
        try:
            weekly = json.loads(node['weekly_windows']) or {}
        except (ValueError, TypeError):
            weekly = {}

    def rule_uid(day_nums, start, end, offset):
        # RRULE_EPOCH as the anchor, so no past date is left empty — a gate is
        # judged against days that have already happened.
        minutes = _hhmm(end) + (int(offset or 0) * 24 * 60) - _hhmm(start)
        if minutes <= 0:
            minutes += 24 * 60            # a window that crosses midnight
        uid = _new_uid('rule')
        rule = {'@type': 'RecurrenceRule', 'frequency': 'weekly',
                'byDay': [{'@type': 'NDay', 'day': schedule._DAYS[int(d)]}
                          for d in sorted(day_nums)]}
        conn.execute(
            'INSERT INTO schedule_source (uid, kind, title, start, duration,'
            ' recurrence_rules) VALUES (?, ?, NULL, ?, ?, ?)',
            (uid, 'rule', f'{RRULE_EPOCH.isoformat()}T{start}:00',
             schedule.format_duration(timedelta(minutes=minutes)), json.dumps([rule])))
        return uid

    # Days that have their own window are grouped by that window, so five
    # identical per-day entries collapse to one rule rather than five.
    groups = {}
    for d in days:
        w = weekly.get(str(d)) or {}
        key = (w.get('window_start') or node['window_start'],
               w.get('window_end') or node['window_end'],
               int(w.get('window_end_offset_days') or node['window_end_offset_days'] or 0))
        groups.setdefault(key, []).append(d)

    if len(groups) == 1:
        (start, end, offset), day_nums = next(iter(groups.items()))
        return rule_uid(day_nums, start, end, offset)

    entries = [rule_uid(day_nums, start, end, offset)
               for (start, end, offset), day_nums in groups.items()]
    uid = _new_uid('schedule')
    conn.execute(
        'INSERT INTO schedule_source (uid, kind, title, entries)'
        ' VALUES (?, ?, NULL, ?)', (uid, 'schedule', json.dumps(entries)))
    return uid


def _window_duration(start_time, end_time):
    """A preset's start/end window becomes a DURATION — the model never stores
    an end time, because a duration is what survives a start moving.

    The defaults have to match what the old time gate did, or the conversion
    silently narrows a period: a MISSING end meant midnight (`to = 1440`), and
    a preset with no window at all meant "all of those days" — not a moment at
    00:00, which is what a null duration would now mean.
    """
    s = _hhmm(start_time or '00:00')
    e = _hhmm(end_time) if end_time else 24 * 60
    minutes = (e - s) if e > s else (e + 24 * 60 - s)   # a window over midnight
    return schedule.format_duration(timedelta(minutes=minutes))


def _hhmm(text):
    parts = str(text).split(':')
    return int(parts[0]) * 60 + int(parts[1] if len(parts) > 1 else 0)


def _new_uid(kind):
    return f'{kind}-{uuid.uuid4().hex[:12]}'


def get_areas():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM area ORDER BY is_default DESC, name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_area(name, type, domain_id=None):
    conn = get_conn()
    if domain_id is None:
        row = conn.execute('SELECT id FROM domain WHERE is_default = 1').fetchone()
        domain_id = row['id'] if row else None
    cur = conn.execute('INSERT INTO area (name, type, domain_id) VALUES (?, ?, ?)',
                       (name, type, domain_id))
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM area WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def set_area_domain(id, domain_id):
    conn = get_conn()
    conn.execute('UPDATE area SET domain_id = ? WHERE id = ?', (domain_id, id))
    conn.commit()
    row = conn.execute('SELECT * FROM area WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def set_area_qr_node(id, qr_node_id):
    conn = get_conn()
    conn.execute('UPDATE area SET qr_node_id = ? WHERE id = ?', (qr_node_id, id))
    conn.commit()
    row = conn.execute('SELECT * FROM area WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


# --- Domains (the level above areas) -----------------------------------

def get_domains():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM domain ORDER BY is_default DESC, name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_domain(name):
    conn = get_conn()
    cur = conn.execute('INSERT INTO domain (name) VALUES (?)', (name,))
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM domain WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_domain(id, name=None, active=None):
    conn = get_conn()
    if name is not None:
        conn.execute('UPDATE domain SET name = ? WHERE id = ?', (name, id))
    if active is not None:
        conn.execute('UPDATE domain SET active = ? WHERE id = ?', (1 if active else 0, id))
    conn.commit()
    row = conn.execute('SELECT * FROM domain WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_domain(id):
    # The default domain is where every area falls back to, so it stays. Deleting
    # any other moves its areas there rather than leaving them domainless.
    conn = get_conn()
    row = conn.execute('SELECT is_default FROM domain WHERE id = ?', (id,)).fetchone()
    if not row or row['is_default']:
        conn.close()
        return
    conn.execute('''UPDATE area SET domain_id = (SELECT id FROM domain WHERE is_default = 1)
                    WHERE domain_id = ?''', (id,))
    conn.execute('DELETE FROM domain WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def get_inbox_items():
    today = date_cls.today().isoformat()
    conn = get_conn()
    rows = conn.execute(
        '''SELECT * FROM inbox_item
           WHERE (defer_until IS NULL OR defer_until <= ?)
             AND (status IS NULL OR area_id IS NULL)
             AND kind = 'item'
           ORDER BY captured_at ASC, id ASC''',
        (today,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# AVAILABILITY, written ONCE. Active, not waiting, no future defer date, and
# either unblocked or blocked by a row that no longer exists (completion deletes
# rows, so a dangling after_id IS the unblock). Every query that answers "what
# could I do now" interpolates this fragment and binds `today` where the ? sits.
#
# It used to be hand-copied into each of them and kept in step by a comment
# saying they must be. They were not: the per-area query had drifted out of the
# inherited-deadline pass. A constant cannot drift (2026-08-16). Callers must
# alias inbox_item as `i` — the correlated sub-select names it.
_AVAILABLE = """i.status = 'active'
             AND (i.defer_until IS NULL OR i.defer_until <= ?)
             AND (i.after_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM inbox_item p WHERE p.id = i.after_id))"""


# DEFERRED is the same kind of shared predicate, and for the same reason: the
# calendar's "what comes back that day" list required status = 'active' and the
# review's count did not, so a waiting or someday item with a future date was
# COUNTED as deferred and then never appeared on the day it was said to return.
# (It was also counted twice — once as deferred, once as someday.) Active is
# the right half: a deferred item is a live thing parked until a date; one that
# is waiting or on hold is already on another list. Callers alias inbox_item as
# `i` and bind today where the ? sits.
_DEFERRED = """i.kind = 'item' AND i.status = 'active'
             AND i.defer_until IS NOT NULL AND i.defer_until > ?"""


# A PROJECT'S DEADLINE BINDS EVERYTHING UNDER IT. If the outcome is due today
# then so is every next action that serves it — an action can't be later than
# the thing it is for. So `effective_deadline` is the EARLIEST deadline on the
# walk from the row up through its ancestor projects.
#
# DERIVED, never written: cascading the date onto children would make clearing
# the project's deadline un-doable (which child dates were inherited and which
# were typed?), and `deadline` is the user's own discipline — the app must not
# invent one on a row he set by hand. It also stays out of every availability
# predicate, exactly as a plain deadline does.
def _deadline_chain(conn):
    return {r['id']: (r['project_id'], r['deadline'])
            for r in conn.execute('SELECT id, project_id, deadline FROM inbox_item')}


def _effective_deadline(chain, item_id):
    best = None
    seen = set()
    cur = item_id
    # The seen-set is the cycle guard: update_inbox_item refuses to create one,
    # but a walk that trusts the data is a walk that hangs the server if it ever
    # is wrong.
    while cur is not None and cur not in seen:
        seen.add(cur)
        node = chain.get(cur)
        if node is None:
            break
        parent, deadline = node
        if deadline and (best is None or deadline < best):
            best = deadline
        cur = parent
    return best


def _apply_inherited_deadlines(conn, rows):
    chain = _deadline_chain(conn)
    for r in rows:
        r['effective_deadline'] = _effective_deadline(chain, r['id'])
    return rows


def get_active_items_all():
    # Every AVAILABLE item, whatever domain it belongs to — the universe the
    # Engage context filter selects from client-side. Predicates are identical
    # to get_active_items_for_domain (status='active', no future defer date);
    # they must stay in lockstep or the review counts stop agreeing.
    today = date_cls.today().isoformat()
    conn = get_conn()
    rows = conn.execute(
        f'''SELECT i.*, a.domain_id AS domain_id, a.name AS area_name
           FROM inbox_item i JOIN area a ON a.id = i.area_id
           WHERE {_AVAILABLE}
           ORDER BY i.captured_at DESC''',
        (today,)
    ).fetchall()
    out = _apply_inherited_deadlines(conn, [dict(r) for r in rows])
    conn.close()
    return out


def get_active_items_for_domain(domain_id):
    # The same rows get_active_items_for_area returns, for every area in the
    # domain at once. Still flat: the client groups by area_id and builds each
    # area's tree from project_id.
    today = date_cls.today().isoformat()
    conn = get_conn()
    rows = conn.execute(
        f'''SELECT i.* FROM inbox_item i JOIN area a ON a.id = i.area_id
           WHERE a.domain_id = ? AND {_AVAILABLE}
           ORDER BY i.captured_at DESC''',
        (domain_id, today)
    ).fetchall()
    out = _apply_inherited_deadlines(conn, [dict(r) for r in rows])
    conn.close()
    return out


def get_map_items():
    # MAP is the whole inventory in one tree: every triaged item, regardless of
    # whether it is available today. Untriaged rows (status NULL) are still "in"
    # and belong to the inbox, not here. Rows go out flat; the client builds the
    # tree from project_id, same as the NOW list does.
    conn = get_conn()
    rows = conn.execute(
        '''SELECT i.*, a.name AS area_name, a.domain_id AS domain_id,
                  d.name AS domain_name
           FROM inbox_item i
           LEFT JOIN area a ON a.id = i.area_id
           LEFT JOIN domain d ON d.id = a.domain_id
           WHERE i.status IN ('active', 'waiting', 'on_hold')
           ORDER BY d.name, a.name, i.id'''
    ).fetchall()
    out = _apply_inherited_deadlines(conn, [dict(r) for r in rows])
    conn.close()
    return out


def get_deferred_items():
    # Everything parked on a FUTURE date, so the day view can show what is
    # scheduled to come back on the day you are looking at. Fetched once with
    # no date and filtered client-side, the same way the pool is — walking the
    # calendar then costs no round trip.
    today = date_cls.today().isoformat()
    conn = get_conn()
    rows = conn.execute(
        f'''SELECT i.*, a.name AS area_name, a.domain_id AS domain_id,
                   p.content AS project_name
            FROM inbox_item i
            LEFT JOIN area a ON a.id = i.area_id
            LEFT JOIN inbox_item p ON p.id = i.project_id
            WHERE {_DEFERRED}
            ORDER BY i.defer_until, i.captured_at''',
        (today,)
    ).fetchall()
    out = _apply_inherited_deadlines(conn, [dict(r) for r in rows])
    conn.close()
    return out


def push_item_to_tomorrow(id):
    # "not today" as a verb, not a date — the whole point is that parking
    # something costs no decision. Local date, to match the rest of the app.
    tomorrow = (date_cls.today() + timedelta(days=1)).isoformat()
    conn = get_conn()
    conn.execute('UPDATE inbox_item SET defer_until = ?, pushed = pushed + 1 WHERE id = ?',
                 (tomorrow, id))
    conn.commit()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def get_area_projects(area_id):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT * FROM inbox_item
           WHERE kind = 'project' AND area_id = ?
           ORDER BY captured_at ASC''',
        (area_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_projects():
    # Every project with its area name and live action count. A zero count is
    # the GTD stall signal — the project has no next action. Projects nest, so
    # an action anywhere in the subtree counts toward every ancestor. A handed-off
    # action ('waiting') still counts: the project is moving, just not by you —
    # chasing it is the waiting-for review step's job, not the stall list's.
    # A future-deferred action counts too: a tickler IS a decided next action,
    # so a project waiting on a date is parked, not stalled.
    conn = get_conn()
    rows = conn.execute(
        '''WITH RECURSIVE tree(root, id) AS (
               SELECT id, id FROM inbox_item WHERE kind = 'project'
               UNION
               SELECT t.root, i.id FROM inbox_item i JOIN tree t ON i.project_id = t.id
           )
           SELECT pr.*, a.name AS area_name,
                  (SELECT COUNT(*) FROM tree t JOIN inbox_item c ON c.id = t.id
                    WHERE t.root = pr.id AND c.status IN ('active', 'waiting')
                      AND c.kind = 'item') AS action_count
           FROM inbox_item pr
           LEFT JOIN area a ON a.id = pr.area_id
           WHERE pr.kind = 'project'
           ORDER BY a.name, pr.captured_at ASC'''
    ).fetchall()
    # Projects nest, so a sub-project inherits its parent's deadline too.
    out = _apply_inherited_deadlines(conn, [dict(r) for r in rows])
    conn.close()
    return out


def _week_start(d=None):
    d = d or date_cls.today()
    return (d - timedelta(days=d.weekday())).isoformat()


def get_gtd_review(week_start_date=None):
    week = week_start_date or _week_start()
    conn = get_conn()
    row = conn.execute('SELECT * FROM gtd_review WHERE week_start_date = ?', (week,)).fetchone()
    if not row:
        conn.execute('INSERT INTO gtd_review (week_start_date) VALUES (?)', (week,))
        conn.commit()
        row = conn.execute('SELECT * FROM gtd_review WHERE week_start_date = ?', (week,)).fetchone()
    conn.close()
    out = dict(row)
    out['steps'] = json.loads(out['steps'] or '{}')
    return out


# gtd_review.steps IS NO LONGER WRITTEN (2026-08-12): the ticks belong to the
# review's flow_run now, one store for both the fold-out and the runner. The
# column stays as the only copy of what _seed_review_flow migrated from, so a
# bad conversion is recoverable — the same reason time_preset was kept.


def finish_gtd_review(week_start_date, note=''):
    conn = get_conn()
    conn.execute('''UPDATE gtd_review SET completed_at = datetime('now','localtime'), note = ?
                    WHERE week_start_date = ?''', (note, week_start_date))
    conn.commit()
    conn.close()
    return get_gtd_review(week_start_date)


def get_gtd_review_counts():
    # The live numbers the review reads: "in" depth, the someday pile, the
    # waiting-for list, the items that keep getting pushed, and the stalled
    # projects — the check GTD leans on hardest and the one that is impossible
    # to run by hand.
    today = date_cls.today().isoformat()
    conn = get_conn()
    inbox = conn.execute(
        '''SELECT COUNT(*) n FROM inbox_item
           WHERE kind = 'item' AND (status IS NULL OR area_id IS NULL)
             AND (defer_until IS NULL OR defer_until <= ?)''', (today,)).fetchone()['n']
    someday = conn.execute(
        "SELECT COUNT(*) n FROM inbox_item WHERE kind = 'item' AND status = 'on_hold'").fetchone()['n']
    deferred = conn.execute(
        f'''SELECT COUNT(*) n FROM inbox_item i WHERE {_DEFERRED}''',
        (today,)).fetchone()['n']
    # Waiting-for is what the review step of that name has always asked for and
    # never had: the things handed off, with how long they have been out.
    waiting_list = [dict(r) for r in conn.execute(
        '''SELECT i.id, i.content, i.captured_at, a.name AS area_name
           FROM inbox_item i LEFT JOIN area a ON a.id = i.area_id
           WHERE i.status = 'waiting'
           ORDER BY i.captured_at''').fetchall()]
    # Items "not today"-ed repeatedly. Three is the point where it stops being a
    # scheduling accident and starts being information about the item itself.
    pushed_list = [dict(r) for r in conn.execute(
        '''SELECT i.id, i.content, i.pushed, a.name AS area_name
           FROM inbox_item i LEFT JOIN area a ON a.id = i.area_id
           WHERE i.status = 'active' AND i.pushed >= 3
           ORDER BY i.pushed DESC, i.content''').fetchall()]
    # EVERY active project WITH its next actions, and `stalled` DERIVED from it
    # (2026-08-17). The review used to ask two questions — "review your
    # next-action lists" and "every project has a next action" — and answer the
    # second with its own query. They are one question: per project, is there a
    # next action? Deriving the stalled set from the same rows is what keeps the
    # list you read and the verdict you are given from ever disagreeing.
    #
    # A someday/maybe project is EXCLUDED: it is not expected to have a next
    # action, so counting it as stalled was noise in the one check GTD leans on
    # hardest. Predicate otherwise in lockstep with get_all_projects'
    # action_count — waiting AND future-deferred children both count as live,
    # because parked-on-a-date is not stalled, it just isn't startable today.
    # Actions are gathered over the whole SUBTREE, so a project whose only live
    # work sits in a sub-project is not stalled either.
    project_rows = [dict(r) for r in conn.execute(
        '''SELECT pr.id, pr.content, a.name AS area_name FROM inbox_item pr
           LEFT JOIN area a ON a.id = pr.area_id
           WHERE pr.kind = 'project' AND COALESCE(pr.status, 'active') <> 'on_hold'
           ORDER BY a.name, pr.content''').fetchall()]
    action_rows = conn.execute(
        '''WITH RECURSIVE tree(root, id) AS (
               SELECT id, id FROM inbox_item WHERE kind = 'project'
               UNION
               SELECT t.root, i.id FROM inbox_item i JOIN tree t ON i.project_id = t.id
           )
           SELECT t.root AS root_id, c.id, c.content, c.status, c.defer_until,
                  c.deadline, c.pushed
           FROM tree t JOIN inbox_item c ON c.id = t.id
           WHERE c.kind = 'item' AND c.status IN ('active', 'waiting')
           ORDER BY c.content''').fetchall()
    by_project = {}
    for r in action_rows:
        by_project.setdefault(r['root_id'], []).append(
            {k: r[k] for k in ('id', 'content', 'status', 'defer_until', 'deadline', 'pushed')})
    for p in project_rows:
        p['actions'] = by_project.get(p['id'], [])
    stalled = [{'id': p['id'], 'content': p['content'], 'area_name': p['area_name']}
               for p in project_rows if not p['actions']]
    projects = conn.execute(
        "SELECT COUNT(*) n FROM inbox_item WHERE kind = 'project'").fetchone()['n']
    conn.close()
    return {'inbox': inbox, 'someday': someday, 'deferred': deferred,
            'projects': projects, 'stalled': stalled,
            'project_list': project_rows,
            'waiting': len(waiting_list), 'waiting_list': waiting_list,
            'pushed_list': pushed_list}


def create_project(content, area_id):
    conn = get_conn()
    cur = conn.execute(
        '''INSERT INTO inbox_item (content, status, area_id, kind)
           VALUES (?, 'active', ?, 'project')''',
        (content, area_id)
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def delete_project(id):
    # Children move up one level: under the deleted project's own parent, or
    # loose in the same area when there isn't one.
    conn = get_conn()
    conn.execute('''UPDATE inbox_item
                    SET project_id = (SELECT project_id FROM inbox_item WHERE id = ?)
                    WHERE project_id = ?''', (id, id))
    conn.execute("DELETE FROM inbox_item WHERE id = ? AND kind = 'project'", (id,))
    conn.commit()
    conn.close()


def create_inbox_item(content, status=None, area_id=None, project_id=None, tags=None):
    # Bare capture (no status/area) is still the default — that is "in".
    # The next-actions prompt bar passes status='active' plus an area to write
    # straight onto a list, skipping the inbox.
    conn = get_conn()
    cur = conn.execute('INSERT INTO inbox_item (content, status, area_id, tags) VALUES (?, ?, ?, ?)',
                       (content, status, area_id, tags or ''))
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    # Filing at capture time goes through the same path as filing later, so the
    # parent still becomes a project and area still follows it.
    if project_id is not None:
        return update_inbox_item(row_id, project_id=project_id)
    return dict(row)


def delete_inbox_item(id):
    # Children of a completed/deleted project move up one level instead of
    # dangling against a missing parent.
    conn = get_conn()
    conn.execute('''UPDATE inbox_item
                    SET project_id = (SELECT project_id FROM inbox_item WHERE id = ?)
                    WHERE project_id = ?''', (id, id))
    # Chains splice the same way: whatever waited on this row now waits on
    # whatever THIS row waited on (or nothing) — completing [2] out of order
    # from MAP re-links [3] to [1] rather than silently unblocking it.
    conn.execute('''UPDATE inbox_item
                    SET after_id = (SELECT after_id FROM inbox_item WHERE id = ?)
                    WHERE after_id = ?''', (id, id))
    conn.execute('DELETE FROM inbox_item WHERE id = ?', (id,))
    conn.execute('DELETE FROM engage_placement WHERE item_id = ?', (id,))
    conn.commit()
    conn.close()


def get_inbox_snapshot(id):
    # Everything a delete would destroy: the row, the children it would splice
    # up a level, and its day placements. Undo replays this verbatim.
    conn = get_conn()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (id,)).fetchone()
    if not row:
        conn.close()
        return None
    kids = [r['id'] for r in conn.execute(
        'SELECT id FROM inbox_item WHERE project_id = ?', (id,)).fetchall()]
    places = [dict(r) for r in conn.execute(
        'SELECT date, minute FROM engage_placement WHERE item_id = ?', (id,)).fetchall()]
    # Chain successors: delete splices them past this row, so undo has to
    # re-point them back at it.
    chain = [r['id'] for r in conn.execute(
        'SELECT id FROM inbox_item WHERE after_id = ?', (id,)).fetchall()]
    conn.close()
    return {'row': dict(row), 'children': kids, 'placements': places, 'chain': chain}


def restore_inbox_item(snap):
    # Re-insert with the ORIGINAL id: everything that referenced this item
    # (children, placements, recurring links) stays coherent.
    row = dict(snap.get('row') or {})
    if not row.get('id'):
        return None
    conn = get_conn()
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(inbox_item)').fetchall()]
    keep = [c for c in cols if c in row]
    conn.execute(
        f"INSERT OR REPLACE INTO inbox_item ({', '.join(keep)}) VALUES ({', '.join('?' * len(keep))})",
        [row[c] for c in keep])
    for kid in snap.get('children') or []:
        conn.execute('UPDATE inbox_item SET project_id = ? WHERE id = ?', (row['id'], kid))
    # Verbatim means placements added AFTER the snapshot (a clarify that
    # scheduled a time) go away too, not just the snapshotted ones coming back.
    conn.execute('DELETE FROM engage_placement WHERE item_id = ?', (row['id'],))
    for p in snap.get('placements') or []:
        conn.execute('INSERT OR REPLACE INTO engage_placement (date, item_id, minute) VALUES (?, ?, ?)',
                     (p['date'], row['id'], p['minute']))
    for cid in snap.get('chain') or []:
        conn.execute('UPDATE inbox_item SET after_id = ? WHERE id = ?', (row['id'], cid))
    conn.commit()
    out = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (row['id'],)).fetchone()
    conn.close()
    return dict(out)


def restore_routine_item(row):
    conn = get_conn()
    conn.execute('''INSERT OR REPLACE INTO routine_item (id, area_id, content, position, done_date)
                    VALUES (?, ?, ?, ?, ?)''',
                 (row['id'], row['area_id'], row['content'], row.get('position', 0),
                  row.get('done_date')))
    conn.commit()
    out = conn.execute('SELECT * FROM routine_item WHERE id = ?', (row['id'],)).fetchone()
    conn.close()
    return dict(out) if out else None


def get_engage_placements(date):
    conn = get_conn()
    rows = conn.execute('SELECT * FROM engage_placement WHERE date = ? ORDER BY minute',
                        (date,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_engage_placements_from(date):
    # Every placement on/after a date — the pool's "already scheduled" test.
    # An item placed on a future day is committed and leaves "Not scheduled"
    # on all days before it; a placement whose day has PASSED is deliberately
    # not included, so an unfinished item surfaces in the pool again.
    conn = get_conn()
    rows = conn.execute('SELECT * FROM engage_placement WHERE date >= ? ORDER BY date, minute',
                        (date,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_engage_placement(date, item_id, minute):
    conn = get_conn()
    conn.execute('INSERT OR REPLACE INTO engage_placement (date, item_id, minute) VALUES (?, ?, ?)',
                 (date, item_id, minute))
    conn.commit()
    conn.close()


def delete_engage_placement(date, item_id):
    conn = get_conn()
    conn.execute('DELETE FROM engage_placement WHERE date = ? AND item_id = ?', (date, item_id))
    conn.commit()
    conn.close()


# ── OCCASIONS ────────────────────────────────────────────────────
#
# "Every time I meet this guy I have to do X and Y." The occasion holds the
# TEMPLATE actions; a calendar event whose summary contains `match_text`
# (case-insensitively) mints copies of them onto that day, placed at the
# event's start.
#
# Template rows are inbox_item rows with status 'occasion' — see the migration
# note on inbox_item.occasion_id. Keeping them in inbox_item is what lets the
# clarify sheet author them: a template carries an area, a project, tags and
# notes because it IS an item, not a parallel little schema that would drift.

_OCC_COPIED = ('content', 'area_id', 'project_id', 'tags', 'notes')


def get_occasions():
    conn = get_conn()
    occs = [dict(r) for r in conn.execute(
        'SELECT * FROM occasion ORDER BY active DESC, name').fetchall()]
    for o in occs:
        o['items'] = [dict(r) for r in conn.execute(
            """SELECT * FROM inbox_item
               WHERE occasion_id = ? AND status = 'occasion' ORDER BY id""",
            (o['id'],)).fetchall()]
    conn.close()
    return occs


def get_occasion(id):
    conn = get_conn()
    row = conn.execute('SELECT * FROM occasion WHERE id = ?', (id,)).fetchone()
    if row is None:
        conn.close()
        return None
    occ = dict(row)
    occ['items'] = [dict(r) for r in conn.execute(
        """SELECT * FROM inbox_item
           WHERE occasion_id = ? AND status = 'occasion' ORDER BY id""",
        (id,)).fetchall()]
    conn.close()
    return occ


def create_occasion(name, match_text):
    conn = get_conn()
    cur = conn.execute('INSERT INTO occasion (name, match_text) VALUES (?, ?)',
                       (name, match_text))
    new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return get_occasion(new_id)


def update_occasion(id, name=_UNSET, match_text=_UNSET, active=_UNSET):
    conn = get_conn()
    if name is not _UNSET:
        conn.execute('UPDATE occasion SET name = ? WHERE id = ?', (name, id))
    if match_text is not _UNSET:
        conn.execute('UPDATE occasion SET match_text = ? WHERE id = ?', (match_text, id))
    if active is not _UNSET:
        conn.execute('UPDATE occasion SET active = ? WHERE id = ?', (1 if active else 0, id))
    conn.commit()
    conn.close()
    return get_occasion(id)


def delete_occasion(id):
    # The templates go with it — they are the occasion's own rows and belong to
    # nothing else. Already-minted actions are ordinary items and STAY: they are
    # on a day you may have already started, and deleting the rule is not a
    # statement about work that has already landed.
    conn = get_conn()
    tpl = [r['id'] for r in conn.execute(
        """SELECT id FROM inbox_item
           WHERE occasion_id = ? AND status = 'occasion'""", (id,)).fetchall()]
    for t in tpl:
        conn.execute('DELETE FROM occasion_mint WHERE template_id = ?', (t,))
        conn.execute('DELETE FROM inbox_item WHERE id = ?', (t,))
    conn.execute('DELETE FROM occasion WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def add_occasion_item(occasion_id, content, area_id=None, project_id=None,
                      tags='', notes=''):
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO inbox_item (content, status, kind, area_id, project_id,
                                   tags, notes, occasion_id)
           VALUES (?, 'occasion', 'item', ?, ?, ?, ?, ?)""",
        (content, area_id, project_id, tags, notes, occasion_id))
    new_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (new_id,)).fetchone()
    conn.close()
    return dict(row)


def delete_occasion_item(item_id):
    conn = get_conn()
    conn.execute('DELETE FROM occasion_mint WHERE template_id = ?', (item_id,))
    conn.execute("DELETE FROM inbox_item WHERE id = ? AND status = 'occasion'", (item_id,))
    conn.commit()
    conn.close()


# The reconciliation the mint comment always claimed: "an event that moved to
# another day takes its actions with it". The ledger was insert-only, so it did
# not — the old day kept orphaned actions and the new day minted a SECOND set,
# and the prep for one meeting existed twice.
#
# Only what is still OUTSTANDING is retracted. A mint whose item is already
# gone was completed or deleted by hand, and its ledger row stays exactly where
# it is: that row is what stops a finished action being minted again. A mint
# still sitting in the pool for an event that is no longer on the day is work
# that was never owed, so it goes — ledger row included, so the event coming
# back mints it afresh.
def _retract_stale_mints(conn, day):
    summaries = [(r['summary'] or '').lower() for r in conn.execute(
        """SELECT e.summary FROM gcal_event e
           JOIN calendar_source c ON e.source_id = c.id
           WHERE c.active = 1 AND substr(e.start, 1, 10) = ?""", (day,)).fetchall()]
    rows = conn.execute(
        """SELECT m.template_id, m.item_id, o.match_text
           FROM occasion_mint m
           JOIN inbox_item t ON t.id = m.template_id
           JOIN occasion o ON o.id = t.occasion_id
           WHERE m.date = ?""", (day,)).fetchall()
    for m in rows:
        needle = (m['match_text'] or '').strip().lower()
        if needle and any(needle in s for s in summaries):
            continue                       # still on the day; nothing to do
        live = conn.execute('SELECT 1 FROM inbox_item WHERE id = ?',
                            (m['item_id'],)).fetchone()
        if not live:
            continue                       # already finished — the ledger stands
        conn.execute('DELETE FROM engage_placement WHERE item_id = ?', (m['item_id'],))
        conn.execute('DELETE FROM inbox_item WHERE id = ?', (m['item_id'],))
        conn.execute('DELETE FROM occasion_mint WHERE date = ? AND template_id = ?',
                     (day, m['template_id']))


def mint_occasions(day):
    # Idempotent, and TODAY-FORWARD only: a past day is what it was, and minting
    # into it would invent work that never existed (the same rule the daybook
    # keeps). Runs off the day's calendar mirror, so an event that moved to
    # another day takes its actions with it — that is the entire reason this is
    # anchored to the event rather than to a weekday.
    today = date_cls.today().isoformat()
    if day < today:
        return
    conn = get_conn()
    # Committed here on purpose: the no-events path below returns early, and an
    # uncommitted retraction would be rolled back by the close — which is
    # exactly the case that matters, a day whose event has GONE.
    _retract_stale_mints(conn, day)
    conn.commit()
    # Same JOIN get_gcal_events uses: an event on a calendar you switched OFF is
    # not on your day, so it may not bring actions onto it either.
    events = [dict(r) for r in conn.execute(
        """SELECT e.summary, e.start FROM gcal_event e
           JOIN calendar_source c ON e.source_id = c.id
           WHERE c.active = 1 AND substr(e.start, 1, 10) = ?
           ORDER BY e.start""",
        (day,)).fetchall()]
    if not events:
        conn.close()
        return
    occs = [dict(r) for r in conn.execute(
        'SELECT * FROM occasion WHERE active = 1').fetchall()]
    for o in occs:
        needle = (o['match_text'] or '').strip().lower()
        if not needle:
            continue
        hit = next((e for e in events if needle in (e['summary'] or '').lower()), None)
        if hit is None:
            continue
        # The EARLIEST matching event of the day decides the slot: two bookings
        # of the same occasion on one day are still one set of actions.
        minute = 0
        if 'T' in (hit['start'] or ''):
            try:
                minute = _hhmm_to_min(hit['start'].split('T')[1][:5])
            except Exception:
                minute = 0
        for t in conn.execute(
                """SELECT * FROM inbox_item
                   WHERE occasion_id = ? AND status = 'occasion' ORDER BY id""",
                (o['id'],)).fetchall():
            done = conn.execute(
                'SELECT 1 FROM occasion_mint WHERE date = ? AND template_id = ?',
                (day, t['id'])).fetchone()
            if done:
                continue
            # FILING UNDER A PROJECT ADOPTS ITS AREA, unconditionally — the
            # inventory's rule, and a raw INSERT was the one path that skipped
            # it, minting children into a split no interactive path can create.
            area_id = t['area_id']
            if t['project_id']:
                parent = conn.execute('SELECT area_id FROM inbox_item WHERE id = ?',
                                      (t['project_id'],)).fetchone()
                if parent:
                    area_id = parent['area_id']
            # A mint for a FUTURE day is deferred to it. Without this, walking
            # the timeline to Friday put Friday's prep in TODAY's pool, MAP and
            # review counts — the pool's availability predicate reads
            # defer_until and knows nothing about placements.
            cur = conn.execute(
                """INSERT INTO inbox_item (content, status, kind, area_id, project_id,
                                           tags, notes, occasion_id, defer_until)
                   VALUES (?, 'active', 'item', ?, ?, ?, ?, ?, ?)""",
                (t['content'], area_id, t['project_id'], t['tags'], t['notes'],
                 o['id'], day if day > today else None))
            item_id = cur.lastrowid
            conn.execute(
                'INSERT OR REPLACE INTO engage_placement (date, item_id, minute) VALUES (?, ?, ?)',
                (day, item_id, minute))
            conn.execute(
                'INSERT INTO occasion_mint (date, template_id, item_id) VALUES (?, ?, ?)',
                (day, t['id'], item_id))
    conn.commit()
    conn.close()


def _hhmm_to_min(t):
    h, m = t.split(':')
    return int(h) * 60 + int(m)


# THE ONE BLOCK RESOLUTION (2026-08-17). "Which blocks are in force on date D,
# and when" was answered in six places that disagreed: get_engage_day wrapped a
# past-midnight block and added yesterday's continuation at -1440, while
# app.js's detectCurrentStandardBlock compared 'HH:MM' strings with no wrap and
# never looked at yesterday — so a 22:00–01:00 block matched at NEITHER 23:00
# ('23:00' < '01:00' is false) NOR 00:30 (wrong weekday), and the DOMAIN IN
# FORCE was wrong for the block's whole span.
#
# Segments are in semantic minutes: a continuation from the previous day starts
# negative, and an overnight block ends past 1440. Overrides are applied here,
# cancellations dropped here, and nothing downstream re-decides any of it.
def block_segments_for(date_str):
    day = date_cls.fromisoformat(date_str)
    conn = get_conn()
    out = []

    def add(day_dow, on_date, offset):
        for b in conn.execute(
                'SELECT * FROM recurring_block WHERE active = 1 AND day_of_week = ?',
                (day_dow,)).fetchall():
            ov = conn.execute('SELECT * FROM block_override WHERE block_id = ? AND date = ?',
                              (b['id'], on_date)).fetchone()
            if ov and ov['cancelled'] == 1:
                continue
            start_t = ov['start_time'] if ov and ov['start_time'] else b['start_time']
            end_t = ov['end_time'] if ov and ov['end_time'] else b['end_time']
            start = _hhmm_to_min(start_t) + offset
            end = _hhmm_to_min(end_t) + (1440 if end_t < start_t else 0) + offset
            if end <= 0:
                continue
            out.append({'block_id': b['id'], 'area_id': b['area_id'], 'label': b['label'],
                        'start': start, 'end': end, 'date': on_date,
                        'overridden': bool(ov)})

    add(day.weekday(), date_str, 0)
    add((day.weekday() - 1) % 7, (day - timedelta(days=1)).isoformat(), -1440)
    conn.close()
    out.sort(key=lambda r: r['start'])
    return out


def get_engage_day():
    # The whole day as Engage models it, assembled server-side so the NOW
    # panel (a separate document) can render the active section without
    # duplicating the client's build. Rows in semantic minutes; yesterday's
    # overnight blocks continue as negative-start rows.
    today = date_cls.today()
    today_str = today.isoformat()
    conn = get_conn()
    routine_areas = {r['id']: r['name'] for r in conn.execute(
        "SELECT id, name FROM area WHERE type = 'routine'").fetchall()}
    rows = []
    groups = {}

    # One resolution, shared with the panel and the client — see
    # block_segments_for. Routine areas collapse into one group per area.
    for seg in block_segments_for(today_str):
        if seg['area_id'] in routine_areas:
            g = groups.get(seg['area_id'])
            if g:
                g['start'] = min(g['start'], seg['start'])
                g['end'] = max(g['end'], seg['end'])
            else:
                groups[seg['area_id']] = {'kind': 'routine', 'area_id': seg['area_id'],
                                          'label': routine_areas[seg['area_id']],
                                          'start': seg['start'], 'end': seg['end']}
        else:
            rows.append({'kind': 'block', 'label': seg['label'],
                         'start': seg['start'], 'end': seg['end']})
    rows.extend(groups.values())

    for e in conn.execute('SELECT * FROM gcal_event WHERE allday = 0').fetchall():
        try:
            s = datetime.fromisoformat(e['start'].replace('Z', '+00:00'))
            t = datetime.fromisoformat(e['end'].replace('Z', '+00:00'))
        except ValueError:
            continue
        if s.tzinfo is not None:
            s = s.astimezone()
            t = t.astimezone()
        if s.date() != today:
            continue
        rows.append({'kind': 'event', 'label': e['summary'],
                     'start': s.hour * 60 + s.minute,
                     'end': t.hour * 60 + t.minute + (1440 if t.date() > s.date() else 0)})

    routine_items = [dict(r) for r in conn.execute(
        'SELECT * FROM routine_item ORDER BY area_id, position, id').fetchall()]
    placed = [dict(r) for r in conn.execute(
        '''SELECT i.id, i.content, ep.minute FROM engage_placement ep
           JOIN inbox_item i ON i.id = ep.item_id
           WHERE ep.date = ? AND i.status = 'active'
           ORDER BY ep.minute''', (today_str,)).fetchall()]
    conn.close()
    rows.sort(key=lambda r: r['start'])
    return {'date': today_str, 'rows': rows,
            'routine_items': routine_items, 'placed': placed}


def get_routine_items():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM routine_item ORDER BY area_id, position, id').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_routine_item(area_id, content):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM routine_item WHERE area_id = ?',
                       (area_id,)).fetchone()
    cur = conn.execute('INSERT INTO routine_item (area_id, content, position) VALUES (?, ?, ?)',
                       (area_id, content, row['p']))
    row_id = cur.lastrowid
    conn.commit()
    out = conn.execute('SELECT * FROM routine_item WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(out)


def update_routine_item(id, content=None, done=None):
    conn = get_conn()
    if content is not None:
        conn.execute('UPDATE routine_item SET content = ? WHERE id = ?', (content, id))
    if done is not None:
        done_date = date_cls.today().isoformat() if done else None
        conn.execute('UPDATE routine_item SET done_date = ? WHERE id = ?', (done_date, id))
    conn.commit()
    row = conn.execute('SELECT * FROM routine_item WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_routine_item(id):
    conn = get_conn()
    conn.execute('DELETE FROM routine_item WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def get_ref_lists():
    # Lists with their items nested — the whole reference inventory is small
    # and the overlay always shows one level or the other, so one payload.
    conn = get_conn()
    lists = [dict(r) for r in conn.execute(
        'SELECT * FROM ref_list ORDER BY position, id').fetchall()]
    for l in lists:
        l['items'] = [dict(r) for r in conn.execute(
            'SELECT * FROM ref_item WHERE list_id = ? ORDER BY done, position, id',
            (l['id'],)).fetchall()]
    conn.close()
    return lists


def create_ref_list(name, parent_id=None):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ref_list').fetchone()
    cur = conn.execute('INSERT INTO ref_list (name, position, parent_id) VALUES (?, ?, ?)',
                       (name, row['p'], parent_id or None))
    out = conn.execute('SELECT * FROM ref_list WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    d = dict(out)
    d['items'] = []
    return d


def update_ref_list(id, name):
    conn = get_conn()
    conn.execute('UPDATE ref_list SET name = ? WHERE id = ?', (name, id))
    conn.commit()
    row = conn.execute('SELECT * FROM ref_list WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_ref_list(id):
    conn = get_conn()
    # Children splice up one level rather than vanishing with the parent —
    # deleting a folder-of-lists must not silently take the lists.
    row = conn.execute('SELECT parent_id FROM ref_list WHERE id = ?', (id,)).fetchone()
    conn.execute('UPDATE ref_list SET parent_id = ? WHERE parent_id = ?',
                 (row['parent_id'] if row else None, id))
    conn.execute('DELETE FROM ref_item WHERE list_id = ?', (id,))
    conn.execute('DELETE FROM ref_list WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def create_ref_item(list_id, content, done=0):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ref_item WHERE list_id = ?',
                       (list_id,)).fetchone()
    cur = conn.execute('INSERT INTO ref_item (list_id, content, done, position) VALUES (?, ?, ?, ?)',
                       (list_id, content, 1 if done else 0, row['p']))
    out = conn.execute('SELECT * FROM ref_item WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    return dict(out)


def update_ref_item(id, content=None, done=None):
    conn = get_conn()
    if content is not None:
        conn.execute('UPDATE ref_item SET content = ? WHERE id = ?', (content, id))
    if done is not None:
        conn.execute('UPDATE ref_item SET done = ? WHERE id = ?', (1 if done else 0, id))
    conn.commit()
    row = conn.execute('SELECT * FROM ref_item WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_ref_item(id):
    conn = get_conn()
    conn.execute('DELETE FROM ref_item WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def update_inbox_item(id, content=_UNSET, status=_UNSET, area_id=_UNSET, defer_until=_UNSET,
                      project_id=_UNSET, tags=_UNSET, waiting_on=_UNSET, chase_on=_UNSET,
                      notes=_UNSET, pushed=_UNSET, started_at=_UNSET, deadline=_UNSET,
                      after_id=_UNSET):
    # Projects nest, so filing must not close a loop: an item can't land under
    # itself or under anything in its own subtree. A cycle-making file is a
    # silent no-op (the client refuses it too; this is the backstop).
    if project_id is not _UNSET and project_id is not None:
        conn = get_conn()
        cur, seen = project_id, set()
        while cur is not None and cur != id and cur not in seen:
            seen.add(cur)
            row = conn.execute('SELECT project_id FROM inbox_item WHERE id = ?', (cur,)).fetchone()
            cur = row['project_id'] if row else None
        conn.close()
        if cur == id:
            project_id = _UNSET
    # A TEMPLATE never changes status. 'occasion' is the only thing keeping it
    # out of the pool, MAP and the review counts, so a stray status in a PATCH
    # would spring it into the inventory as an action nobody wrote — silently,
    # and on every lens at once. The client's template mode doesn't send one;
    # this is the backstop, same policy as the cycle guards above.
    if status is not _UNSET:
        conn = get_conn()
        row = conn.execute('SELECT status FROM inbox_item WHERE id = ?', (id,)).fetchone()
        conn.close()
        if row and row['status'] == 'occasion' and status != 'occasion':
            status = _UNSET
    updates = {}
    if content is not _UNSET:
        updates['content'] = content
    if status is not _UNSET:
        updates['status'] = status
    if area_id is not _UNSET:
        updates['area_id'] = area_id
    if defer_until is not _UNSET:
        updates['defer_until'] = defer_until
    if tags is not _UNSET:
        updates['tags'] = tags or ''
    if waiting_on is not _UNSET:
        updates['waiting_on'] = waiting_on
    if chase_on is not _UNSET:
        updates['chase_on'] = chase_on
    if notes is not _UNSET:
        updates['notes'] = notes or ''
    if pushed is not _UNSET:
        updates['pushed'] = pushed
    if started_at is not _UNSET:
        updates['started_at'] = started_at
    if deadline is not _UNSET:
        updates['deadline'] = deadline
    if after_id is not _UNSET:
        # A chain may not loop: walking after_id from the target must never
        # reach this item. A loop-making link is a silent no-op — same policy
        # as project cycles (the client refuses it too; this is the backstop).
        ok = True
        if after_id is not None:
            conn = get_conn()
            cur, seen = after_id, set()
            while cur is not None and cur not in seen:
                if cur == id:
                    ok = False
                    break
                seen.add(cur)
                row = conn.execute('SELECT after_id FROM inbox_item WHERE id = ?', (cur,)).fetchone()
                cur = row['after_id'] if row else None
            conn.close()
        if ok:
            updates['after_id'] = after_id
    if project_id is not _UNSET:
        updates['project_id'] = project_id
        # Being filed under an item is what MAKES that item a project. This is
        # the model invariant, so it belongs here rather than in one caller.
        if project_id is not None:
            conn = get_conn()
            conn.execute("UPDATE inbox_item SET kind = 'project' WHERE id = ?", (project_id,))
            conn.commit()
            conn.close()
        # Filing under a project adopts that project's area, ALWAYS — an
        # explicit area_id in the same call does NOT win.
        #
        # It used to, and that was the "items randomly leave their project" bug.
        # A single PATCH carrying both (which is exactly what clarify's filing
        # does) left the item in area A under a project in area B. That breaks
        # the stated invariant that a project and its actions can never disagree
        # about area, and the breakage is SILENT until the next write that
        # touches area alone — which hits the orphan rule below, sees the
        # mismatch, and clears project_id. The item looked fine when filed and
        # fell out of the project later, for no reason visible at the time.
        #
        # Deliberately unconditional: "file it here" is a statement about
        # position, and position decides area. To move an item OUT of a project
        # into another area, send area_id WITHOUT project_id (the orphan rule) or
        # send project_id = None alongside it.
        if project_id is not None:
            conn = get_conn()
            row = conn.execute('SELECT area_id FROM inbox_item WHERE id = ?', (project_id,)).fetchone()
            conn.close()
            if row and row['area_id'] is not None:
                updates['area_id'] = row['area_id']
    elif area_id is not _UNSET and area_id is not None:
        # Moving an item to a different area orphans it from a project that
        # lives in the old one.
        conn = get_conn()
        row = conn.execute(
            '''SELECT p.area_id AS parent_area FROM inbox_item i
               JOIN inbox_item p ON p.id = i.project_id WHERE i.id = ?''', (id,)
        ).fetchone()
        conn.close()
        if row and row['parent_area'] != area_id:
            updates['project_id'] = None
    if not updates:
        conn = get_conn()
        row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (id,)).fetchone()
        conn.close()
        return dict(row)
    fields = ', '.join(f'{k} = ?' for k in updates)
    values = list(updates.values()) + [id]
    conn = get_conn()
    conn.execute(f'UPDATE inbox_item SET {fields} WHERE id = ?', values)
    # Area flows down the whole subtree, so a project and everything under it
    # can never disagree about area.
    if 'area_id' in updates:
        conn.execute('''WITH RECURSIVE sub(sid) AS (
                            SELECT id FROM inbox_item WHERE project_id = ?
                            UNION
                            SELECT i.id FROM inbox_item i JOIN sub ON i.project_id = sub.sid
                        )
                        UPDATE inbox_item SET area_id = ? WHERE id IN (SELECT sid FROM sub)''',
                     (id, updates['area_id']))
    conn.commit()
    row = conn.execute('SELECT * FROM inbox_item WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


# Recurring tasks: calendar-anchored chores seeded into active items when due.
# Weekday convention matches the rest of the app: 0=Mon .. 6=Sun.
# 2001-01-01 was a Monday; used as the epoch for week-parity math.

# 2001-01-01 was a Monday — the phase anchor for any rule that has no start
# date of its own.
RRULE_EPOCH = date_cls(2001, 1, 1)


def _recurring_due(task, today):
    rule = task.get('rrule') if hasattr(task, 'get') else None
    if rule:
        anchor = date_cls.fromisoformat(task['anchor_date']) if task.get('anchor_date') else RRULE_EPOCH
        return recurrence.occurs_on(rule, anchor, today)
    anchor = date_cls.fromisoformat(task['anchor_date'])
    if today < anchor:
        return False
    interval = max(1, task['interval'] or 1)
    if task['kind'] == 'every_n_days':
        return (today - anchor).days % interval == 0
    if task['kind'] == 'weekly':
        if str(today.weekday()) not in (task['days_of_week'] or ''):
            return False
        epoch = date_cls(2001, 1, 1)
        weeks = (today - epoch).days // 7 - (anchor - epoch).days // 7
        return weeks % interval == 0
    months = (today.year - anchor.year) * 12 + (today.month - anchor.month)
    if months % interval != 0:
        return False
    if task['kind'] == 'monthly_nth':
        return today.weekday() == task['weekday'] and (today.day - 1) // 7 + 1 == task['nth']
    next_month = date_cls(today.year + (today.month == 12), today.month % 12 + 1, 1)
    last_dom = (next_month - timedelta(days=1)).day
    return today.day == min(anchor.day, last_dom)


def seed_recurring_tasks():
    today = date_cls.today()
    today_str = today.isoformat()
    conn = get_conn()
    tasks = [dict(r) for r in conn.execute('SELECT * FROM recurring_task WHERE active = 1').fetchall()]
    for t in tasks:
        if t['last_seeded'] == today_str or not _recurring_due(t, today):
            continue
        live = conn.execute('SELECT 1 FROM inbox_item WHERE recurring_task_id = ?', (t['id'],)).fetchone()
        if not live:
            # Seeded occurrences inherit the task's project, so a recurring
            # chore that belongs to an outcome lands inside its run.
            conn.execute(
                '''INSERT INTO inbox_item (content, status, area_id, project_id, recurring_task_id)
                   VALUES (?, 'active', ?, ?, ?)''',
                (t['name'], t['area_id'], t['project_id'], t['id'])
            )
        conn.execute('UPDATE recurring_task SET last_seeded = ? WHERE id = ?', (today_str, t['id']))
    conn.commit()
    conn.close()


def seed_flow_tasks():
    # ONE action per routine per PERIOD, and once seeded that is the end of it —
    # ticking the action off has to mean something, so flow_task_seed remembers
    # the seeding even after the action it made is gone.
    #
    # The run is the other half: a routine already completed for its period has
    # nothing left to ask, so its task is retired rather than left in the pool
    # looking outstanding (you finished it from the Lists surface).
    today = date_cls.today()
    conn = get_conn()
    flows = [dict(r) for r in conn.execute(
        'SELECT * FROM flow WHERE COALESCE(as_task, 0) = 1').fetchall()]
    default_area = conn.execute(
        """SELECT id FROM area WHERE is_default = 1 AND active = 1
           AND type = 'standard' LIMIT 1""").fetchone()
    for f in flows:
        key = flow_period_key(f.get('period'), today)
        live = conn.execute(
            "SELECT id FROM inbox_item WHERE flow_id = ? AND status = 'active'",
            (f['id'],)).fetchone()
        done = conn.execute(
            'SELECT completed_at FROM flow_run WHERE flow_id = ? AND date = ?',
            (f['id'], key)).fetchone()
        if done and done['completed_at']:
            if live:
                conn.execute('DELETE FROM engage_placement WHERE item_id = ?', (live['id'],))
                conn.execute('DELETE FROM inbox_item WHERE id = ?', (live['id'],))
            continue
        if live:
            continue
        already = conn.execute(
            'SELECT 1 FROM flow_task_seed WHERE flow_id = ? AND date = ?',
            (f['id'], key)).fetchone()
        if already or not step_due_on(f, today):
            continue
        area_id = f['area_id'] or (default_area['id'] if default_area else None)
        if area_id is None:
            continue          # nothing to file it under; the pool JOINs area
        cur = conn.execute(
            """INSERT INTO inbox_item (content, status, kind, area_id, flow_id)
               VALUES (?, 'active', 'item', ?, ?)""",
            (f['name'], area_id, f['id']))
        conn.execute(
            'INSERT INTO flow_task_seed (flow_id, date, item_id) VALUES (?, ?, ?)',
            (f['id'], key, cur.lastrowid))
    conn.commit()
    conn.close()


def get_recurring_tasks():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM recurring_task ORDER BY active DESC, name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_recurring_task(name, area_id, kind, days_of_week, nth, weekday, interval, anchor_date,
                          project_id=None):
    conn = get_conn()
    cur = conn.execute(
        '''INSERT INTO recurring_task (name, area_id, kind, days_of_week, nth, weekday, interval, anchor_date, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (name, area_id, kind, days_of_week, nth, weekday, interval, anchor_date, project_id)
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM recurring_task WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_recurring_task(id, active=_UNSET, project_id=_UNSET):
    conn = get_conn()
    if active is not _UNSET:
        conn.execute('UPDATE recurring_task SET active = ? WHERE id = ?', (1 if active else 0, id))
        conn.commit()
    if project_id is not _UNSET:
        conn.execute('UPDATE recurring_task SET project_id = ? WHERE id = ?', (project_id, id))
        conn.commit()
    row = conn.execute('SELECT * FROM recurring_task WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_recurring_task(id):
    conn = get_conn()
    conn.execute('DELETE FROM recurring_task WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def upsert_deadlines(rows):
    conn = get_conn()
    conn.executemany('''
        INSERT INTO deadline (course, name, due_date, due_time)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(course, name, due_date) DO UPDATE SET
            due_time = excluded.due_time
    ''', [(r['course'], r['name'], r['due_date'], r['due_time']) for r in rows])
    conn.commit()
    conn.close()


def get_deadlines():
    conn = get_conn()
    rows = conn.execute(
        'SELECT rowid AS row_index, course, name, due_date, due_time, done FROM deadline WHERE done = 0 ORDER BY due_date, due_time'
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def mark_deadline_done(row_index):
    conn = get_conn()
    conn.execute('UPDATE deadline SET done = 1 WHERE rowid = ?', (row_index,))
    conn.commit()
    conn.close()


# How far back the day view can see. The weekly review's "previous calendar,
# 2-3 weeks back" step needs 21; 30 gives it headroom without turning this
# into an archive query. Retention itself is unbounded (see
# replace_source_events) — this is only the READ window.
GCAL_DAYS_BACK = 30


def get_gcal_events():
    today = date_cls.today()
    window_start = (today - timedelta(days=GCAL_DAYS_BACK)).isoformat()
    window_end = (today + timedelta(days=90)).isoformat()
    conn = get_conn()
    rows = conn.execute(
        '''SELECT e.uid, e.summary, e.start, e.end, e.allday, c.color
           FROM gcal_event e
           JOIN calendar_source c ON e.source_id = c.id
           WHERE c.active = 1 AND e.start >= ? AND e.start <= ?
           ORDER BY e.start''',
        (window_start, window_end)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# The optimistic half of a calendar WRITE: the event just created on Google,
# inserted locally so it renders before the (hours-stale) iCal feed catches
# up. Same uid the feed will publish, so replace_source_events re-asserts it
# rather than duplicating it on the next refresh.
def insert_gcal_event(source_id, uid, summary, start, end):
    conn = get_conn()
    conn.execute(
        '''INSERT OR REPLACE INTO gcal_event (uid, summary, start, end, allday, source_id)
           VALUES (?,?,?,?,0,?)''',
        (uid, summary, start, end, source_id))
    conn.commit()
    conn.close()


def delete_gcal_event_by_uid(source_id, uid):
    conn = get_conn()
    conn.execute('DELETE FROM gcal_event WHERE source_id = ? AND uid = ?',
                 (source_id, uid))
    conn.commit()
    conn.close()


def get_calendar_sources():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM calendar_source ORDER BY id').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_calendar_source(name, url, color):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO calendar_source (name, url, color) VALUES (?,?,?)',
        (name, url, color)
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM calendar_source WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_calendar_source(id, name=_UNSET, color=_UNSET, active=_UNSET):
    updates = {}
    if name is not _UNSET:
        updates['name'] = name
    if color is not _UNSET:
        updates['color'] = color
    if active is not _UNSET:
        updates['active'] = active
    conn = get_conn()
    if updates:
        fields = ', '.join(f'{k} = ?' for k in updates)
        conn.execute(f'UPDATE calendar_source SET {fields} WHERE id = ?', list(updates.values()) + [id])
        conn.commit()
    row = conn.execute('SELECT * FROM calendar_source WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def delete_calendar_source(id):
    conn = get_conn()
    conn.execute('DELETE FROM gcal_event WHERE source_id = ?', (id,))
    conn.execute('DELETE FROM calendar_source WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def replace_source_events(source_id, occurrences, fetched_at):
    # THE PAST IS KEPT. This used to delete every row for the source and
    # re-insert whatever the feed currently returns — and an iCal feed only
    # publishes a rolling window, so each refresh silently threw the past
    # away. The calendar was a cache of the future, which is exactly the data
    # the weekly review's "review previous calendar, 2-3 weeks back" step
    # needs and never had.
    #
    # Only from TODAY forward is replaced; anything already stored with an
    # earlier start stays. Incoming past occurrences are dropped rather than
    # merged: the feed's version of a past event is not more authoritative
    # than what we recorded at the time, and re-inserting would resurrect
    # events you deleted from the calendar after they happened.
    today = date_cls.today().isoformat()
    future = [o for o in occurrences if (o.get('start') or '') >= today]
    occurrences = future
    conn = get_conn()
    try:
        conn.execute('BEGIN')
        conn.execute('DELETE FROM gcal_event WHERE source_id = ? AND start >= ?',
                     (source_id, today))
        conn.executemany(
            'INSERT INTO gcal_event (uid, summary, start, end, allday, source_id) VALUES (?,?,?,?,?,?)',
            [(o['uid'], o['summary'], o['start'], o['end'], o['allday'], source_id) for o in occurrences]
        )
        conn.execute('UPDATE calendar_source SET last_fetched_at = ? WHERE id = ?', (fetched_at, source_id))
        conn.execute('COMMIT')
    except Exception:
        conn.execute('ROLLBACK')
        conn.close()
        raise
    conn.close()


def delete_area(id):
    conn = get_conn()
    conn.execute('DELETE FROM area WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def set_project_active(id, active):
    conn = get_conn()
    conn.execute('UPDATE area SET active = ? WHERE id = ?', (active, id))
    conn.commit()
    row = conn.execute('SELECT * FROM area WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def set_project_type(id, type):
    conn = get_conn()
    conn.execute('UPDATE area SET type = ? WHERE id = ?', (type, id))
    conn.commit()
    row = conn.execute('SELECT * FROM area WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def get_blocks():
    conn = get_conn()
    rows = conn.execute('''
        SELECT rb.*, p.name AS project_name, l.name AS location_name
        FROM recurring_block rb
        LEFT JOIN area p ON rb.area_id = p.id
        LEFT JOIN location l ON rb.location_id = l.id
        ORDER BY rb.day_of_week, rb.start_time
    ''').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _fetch_block(conn, id):
    return dict(conn.execute(
        'SELECT rb.*, p.name AS project_name, l.name AS location_name FROM recurring_block rb LEFT JOIN area p ON rb.area_id = p.id LEFT JOIN location l ON rb.location_id = l.id WHERE rb.id = ?',
        (id,)
    ).fetchone())


def create_block(label, color, day_of_week, start_time, end_time, area_id, location_id):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO recurring_block (label, color, day_of_week, start_time, end_time, area_id, location_id) VALUES (?,?,?,?,?,?,?)',
        (label, color, day_of_week, start_time, end_time, area_id, location_id)
    )
    row_id = cur.lastrowid
    conn.commit()
    result = _fetch_block(conn, row_id)
    conn.close()
    return result


def update_block(id, label, color, day_of_week, start_time, end_time, area_id, location_id):
    conn = get_conn()
    conn.execute(
        'UPDATE recurring_block SET label=?, color=?, day_of_week=?, start_time=?, end_time=?, area_id=?, location_id=? WHERE id=?',
        (label, color, day_of_week, start_time, end_time, area_id, location_id, id)
    )
    conn.commit()
    result = _fetch_block(conn, id)
    conn.close()
    return result


def get_todo(date):
    conn = get_conn()
    row = conn.execute('SELECT * FROM daily_todo WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_or_get_todo(date):
    conn = get_conn()
    cur = conn.execute('INSERT OR IGNORE INTO daily_todo (date) VALUES (?)', (date,))
    if cur.rowcount:
        conn.commit()
    row = conn.execute('SELECT * FROM daily_todo WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row)


def update_todo(date, content=None, planning_started_at=None, planning_finished_at=None):
    updates = {}
    if content is not None:
        updates['content'] = content
        updates['updated_at'] = datetime.now(timezone.utc).isoformat()
    if planning_started_at is not None:
        updates['planning_started_at'] = planning_started_at
    if planning_finished_at is not None:
        updates['planning_finished_at'] = planning_finished_at
    if not updates:
        return get_todo(date)
    fields = ', '.join(f'{k} = ?' for k in updates)
    values = list(updates.values()) + [date]
    conn = get_conn()
    conn.execute(f'UPDATE daily_todo SET {fields} WHERE date = ?', values)
    conn.commit()
    row = conn.execute('SELECT * FROM daily_todo WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row)


def mark_todo_unsynced(date):
    conn = get_conn()
    conn.execute('INSERT OR IGNORE INTO todo_sync (date) VALUES (?)', (date,))
    conn.commit()
    conn.close()


def get_unsynced_todos():
    conn = get_conn()
    rows = conn.execute(
        'SELECT t.date, t.content, t.updated_at, t.created_at FROM daily_todo t JOIN todo_sync s ON s.date = t.date'
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_todo_synced(date):
    conn = get_conn()
    conn.execute('DELETE FROM todo_sync WHERE date = ?', (date,))
    conn.commit()
    conn.close()


def apply_remote_todo(date, content, updated_at):
    conn = get_conn()
    conn.execute('INSERT OR IGNORE INTO daily_todo (date) VALUES (?)', (date,))
    conn.execute(
        'UPDATE daily_todo SET content = ?, updated_at = ? WHERE date = ?',
        (content, updated_at, date)
    )
    conn.execute('DELETE FROM todo_sync WHERE date = ?', (date,))
    conn.commit()
    conn.close()


# Inbox cloud sync mirrors the todo design: the unprocessed inbox view is a
# newline blob, LWW by inbox_updated_at, dirty flag inbox_unsynced (settings).

def inbox_content_blob():
    return '\n'.join(i['content'] for i in get_inbox_items())


def get_inbox_sync_state():
    settings = get_settings()
    return {
        'updated_at': settings.get('inbox_updated_at'),
        'unsynced': settings.get('inbox_unsynced') == '1',
    }


def touch_inbox():
    set_setting('inbox_updated_at', datetime.now(timezone.utc).isoformat())
    set_setting('inbox_unsynced', '1')


def mark_inbox_unsynced():
    set_setting('inbox_unsynced', '1')


def clear_inbox_synced():
    set_setting('inbox_unsynced', '0')


def apply_remote_inbox(content, updated_at):
    remote_counts = {}
    for line in (content or '').splitlines():
        line = line.strip()
        if line:
            remote_counts[line] = remote_counts.get(line, 0) + 1
    conn = get_conn()
    # Reconcile only the synced (unprocessed) view; processed items are untouched
    for item in get_inbox_items():
        c = item['content'].strip()
        if remote_counts.get(c):
            remote_counts[c] -= 1
        else:
            conn.execute('DELETE FROM inbox_item WHERE id = ?', (item['id'],))
    for line, count in remote_counts.items():
        for _ in range(count):
            conn.execute('INSERT INTO inbox_item (content) VALUES (?)', (line,))
    conn.commit()
    conn.close()
    set_setting('inbox_updated_at', updated_at)
    set_setting('inbox_unsynced', '0')


# Pending todo-submitted pushes to the QR Worker: queued on planning finish,
# retried until the Worker confirms, dropped once the date has passed (the
# charge window has already been judged by then).

def queue_todo_push(node_id, date):
    conn = get_conn()
    conn.execute('INSERT OR IGNORE INTO qr_todo_push (node_id, date) VALUES (?, ?)', (node_id, date))
    conn.commit()
    conn.close()


def pending_todo_pushes():
    conn = get_conn()
    conn.execute('DELETE FROM qr_todo_push WHERE date < ?', (date_cls.today().isoformat(),))
    conn.commit()
    rows = conn.execute('SELECT node_id, date FROM qr_todo_push').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_todo_push(node_id, date):
    conn = get_conn()
    conn.execute('DELETE FROM qr_todo_push WHERE node_id = ? AND date = ?', (node_id, date))
    conn.commit()
    conn.close()


# Daily db backup: binary snapshot (backups/tracker-<date>.db, local only,
# pruned) + deterministic SQL dump (backups/tracker.sql, git-tracked so git
# history doubles as point-in-time recovery). Restore: copy a snapshot over
# tracker.db, or `sqlite3 tracker.db ".read backups/tracker.sql"` on an
# empty file.

BACKUPS_DIR = 'backups'
BACKUP_KEEP = 14


def backup_db():
    os.makedirs(BACKUPS_DIR, exist_ok=True)
    today = date_cls.today().isoformat()
    src = get_conn()
    dest = sqlite3.connect(os.path.join(BACKUPS_DIR, f'tracker-{today}.db'))
    src.backup(dest)
    dest.close()
    with open(os.path.join(BACKUPS_DIR, 'tracker.sql'), 'w', encoding='utf-8', newline='\n') as f:
        for line in src.iterdump():
            f.write(line + '\n')
    src.close()
    snapshots = sorted(f for f in os.listdir(BACKUPS_DIR)
                       if re.match(r'tracker-\d{4}-\d{2}-\d{2}\.db$', f))
    for old in snapshots[:-BACKUP_KEEP]:
        os.remove(os.path.join(BACKUPS_DIR, old))
    set_setting('last_backup_date', today)


# Log docs: long-term markdown files in logs/, gitignored and carried by restic
# with the rest of the data dir, edited from the Logs view. Names are sanitized
# to a safe charset; content is the raw file.

LOGS_DIR = 'logs'


def _log_name(name):
    return re.sub(r'[^A-Za-z0-9 _\-]', '', name).strip()


# A log's FILENAME keeps its date; its title never shows one (2026-08-17).
#
# The date stays on disk because it is the file's IDENTITY, not decoration: two
# logs on the same topic a month apart would otherwise be one filename and one
# would silently overwrite the other. It also keeps `ls` and restic in date
# order, which is most of why logs are files at all.
#
# Both spellings parse. Old logs are 'YY-M-D topic', unpadded, which sorts
# WRONG as text ('26-8-11' before '26-8-2', November before August) — the
# reason the list order was nonsense. New ones are written zero-padded, so the
# directory sorts right too, and nothing has to be renamed.
_LOG_DATE = re.compile(r'^(\d{2})-(\d{1,2})-(\d{1,2})[ _-]+(.*)$')


# -> (created ISO date or None, title without the date)
def _split_log_name(name):
    m = _LOG_DATE.match(name)
    if not m:
        return None, name
    yy, mm, dd, rest = m.groups()
    try:
        d = date_cls(2000 + int(yy), int(mm), int(dd))
    except ValueError:
        return None, name
    return d.isoformat(), (rest.strip() or name)


# Tags live in the FILE, as a first line of #tokens — not in a table. A log is
# a markdown file whose point is being readable in ten years with no app and no
# sqlite, and `grep -l '#meeting' logs/` has to keep working. Same token
# grammar as the inventory's inert tags.
_LOG_TAG_LINE = re.compile(r'^\s*(#[a-z0-9_-]+[ \t]*)+$', re.I)


def _log_tags(content):
    first = (content or '').split('\n', 1)[0]
    if not first.strip() or not _LOG_TAG_LINE.match(first):
        return []
    return sorted({t.lower() for t in re.findall(r'#([a-z0-9_-]+)', first, re.I)})


def _log_meta(name, content, mtime):
    created, title = _split_log_name(name)
    return {'name': name, 'title': title, 'created': created,
            'tags': _log_tags(content),
            'updated_at': datetime.fromtimestamp(mtime).isoformat()}


def list_logs():
    os.makedirs(LOGS_DIR, exist_ok=True)
    logs = []
    for f in sorted(os.listdir(LOGS_DIR)):
        if not f.endswith('.md'):
            continue
        path = os.path.join(LOGS_DIR, f)
        # Only the first line is needed for tags; reading whole files to find it
        # would make listing cost the size of the corpus.
        try:
            with open(path, encoding='utf-8') as fh:
                head = fh.readline()
        except OSError:
            head = ''
        logs.append(_log_meta(f[:-3], head, os.path.getmtime(path)))
    return logs


# CONTENT search. Tags answer "what kind of log is this"; only this answers
# "what was in it", which is the question a corpus is actually kept for.
#
# Server-side because the bodies are FILES and the client has never seen them.
# Returns the matching LINES, not just the filenames: a hit you cannot read is
# a filename you still have to open to evaluate, which is the work you were
# trying to skip. Case-insensitive substring, not a query language — the corpus
# is a few hundred files of prose.
def search_logs(q, per_file=3):
    q = (q or '').strip().lower()
    if not q:
        return {}
    os.makedirs(LOGS_DIR, exist_ok=True)
    hits = {}
    for f in sorted(os.listdir(LOGS_DIR)):
        if not f.endswith('.md'):
            continue
        try:
            with open(os.path.join(LOGS_DIR, f), encoding='utf-8') as fh:
                body = fh.read()
        except OSError:
            continue
        name = f[:-3]
        found = []
        for line in body.split('\n'):
            if q in line.lower():
                line = line.strip()
                if line:
                    found.append(line[:200])
            if len(found) >= per_file:
                break
        # A title match counts even when the body never says it — the name is
        # part of the log, and the whole point was to stop reading names as
        # filenames.
        if not found and q in name.lower():
            found = ['']
        if found:
            hits[name] = found
    return hits


def read_log(name):
    name = _log_name(name)
    path = os.path.join(LOGS_DIR, name + '.md')
    content = ''
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            content = f.read()
    return {'name': name, 'content': content}


def write_log(name, content):
    name = _log_name(name)
    os.makedirs(LOGS_DIR, exist_ok=True)
    with open(os.path.join(LOGS_DIR, name + '.md'), 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    return name


def create_log(name, tags=None, created=None):
    # The DATE is stamped here, not typed. It used to be part of what you had
    # to write in the name; the name is just the topic now.
    name = _log_name(name)
    if not _LOG_DATE.match(name):
        try:
            d = date_cls.fromisoformat(created or date_cls.today().isoformat())
        except ValueError:
            d = date_cls.today()
        name = ('%s %s' % (d.strftime('%y-%m-%d'), name)).strip()
    path = os.path.join(LOGS_DIR, name + '.md')
    if not os.path.exists(path):
        clean = sorted({re.sub(r'[^a-z0-9_-]', '', str(t).lower().lstrip('#'))
                        for t in (tags or [])} - {''})
        write_log(name, (' '.join('#' + t for t in clean) + '\n\n') if clean else '')
    return read_log(name)


# A photo is a FILE beside the log and a markdown link inside it — no table, no
# blob column. A log is a markdown file whose point is being readable in ten
# years with no app and no sqlite, and `![](media/x.jpg)` is still readable
# there; a row in a database it outlives is not. The bytes ride restic with the
# rest of the data dir, and logs/ is gitignored, so a phone photo can't reach
# the repo.
LOGS_MEDIA_DIR = os.path.join(LOGS_DIR, 'media')

# An extension ALLOWLIST, not a content sniff. The extension is what any viewer
# will decide by, so an unlisted one is refused rather than guessed at.
LOG_PHOTO_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'}


# -> the log-relative path to write into the markdown, or None if refused
def save_log_photo(name, filename, data):
    name = _log_name(name)
    ext = (filename or '').rsplit('.', 1)[-1].lower()
    if not name or ext not in LOG_PHOTO_EXTS:
        return None
    os.makedirs(LOGS_MEDIA_DIR, exist_ok=True)
    # The log's own name is the prefix, so `ls logs/media` reads in the same
    # order the corpus does and a photo is never orphaned from the log holding
    # it. Spaces become dashes because the link has to survive a markdown
    # parser. The counter never reuses a number: overwriting a file some older
    # revision of the log still points at would break that link silently.
    slug = re.sub(r'\s+', '-', name).strip('-')
    n = 1
    while os.path.exists(os.path.join(LOGS_MEDIA_DIR, '%s-%d.%s' % (slug, n, ext))):
        n += 1
    rel = 'media/%s-%d.%s' % (slug, n, ext)
    with open(os.path.join(LOGS_DIR, rel), 'wb') as f:
        f.write(data)
    return rel


def get_settings():
    conn = get_conn()
    rows = conn.execute('SELECT key, value FROM setting').fetchall()
    conn.close()
    return {r['key']: r['value'] for r in rows}


def set_setting(key, value):
    conn = get_conn()
    if value is None:
        conn.execute('DELETE FROM setting WHERE key = ?', (key,))
    else:
        conn.execute(
            'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            (key, value)
        )
    conn.commit()
    conn.close()


def delete_block(id):
    conn = get_conn()
    conn.execute('DELETE FROM recurring_block WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def get_overrides_for_date(date):
    prev = (date_cls.fromisoformat(date) - timedelta(days=1)).isoformat()
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM block_override WHERE date IN (?, ?)', (date, prev)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def upsert_override(block_id, date, **fields):
    conn = get_conn()
    row = conn.execute(
        'SELECT * FROM block_override WHERE block_id = ? AND date = ?', (block_id, date)
    ).fetchone()
    if row:
        sets = ', '.join(f'{k} = ?' for k in fields)
        conn.execute(f'UPDATE block_override SET {sets} WHERE id = ?', list(fields.values()) + [row['id']])
        row_id = row['id']
    else:
        if 'cancelled' not in fields:
            fields['cancelled'] = 0
        cols = ['block_id', 'date'] + list(fields)
        placeholders = ', '.join('?' * len(cols))
        cur = conn.execute(
            f'INSERT INTO block_override ({", ".join(cols)}) VALUES ({placeholders})',
            [block_id, date] + list(fields.values())
        )
        row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM block_override WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def delete_override(id):
    conn = get_conn()
    conn.execute('DELETE FROM block_override WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def get_overrides_for_window(start_date, end_date):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM block_override WHERE date >= ? AND date <= ? AND cancelled = 1',
        (start_date, end_date)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def validate_no_overlap(day_of_week, start_time, end_time, exclude_id=None):
    conn = get_conn()
    query = '''
        SELECT label FROM recurring_block
        WHERE day_of_week = ? AND active = 1
          AND start_time < ? AND end_time > ?
    '''
    params = [day_of_week, end_time, start_time]
    if exclude_id is not None:
        query += ' AND id != ?'
        params.append(exclude_id)
    row = conn.execute(query, params).fetchone()
    conn.close()
    return row['label'] if row else None


def upsert_sheets_inbox_items(rows):
    qualifying = [r for r in rows if r.get('due_yes') and not r.get('done')]
    qualifying_keys = [f"{r['course']}:{r['title']}:{r['due_date']}" for r in qualifying]
    conn = get_conn()
    if qualifying_keys:
        placeholders = ','.join('?' * len(qualifying_keys))
        conn.execute(
            f'DELETE FROM sheets_inbox_item WHERE sheets_key NOT IN ({placeholders})',
            qualifying_keys
        )
        conn.executemany(
            '''INSERT OR IGNORE INTO sheets_inbox_item (sheets_key, title, course, due_date, due_time)
               VALUES (?, ?, ?, ?, ?)''',
            [(f"{r['course']}:{r['title']}:{r['due_date']}", r['title'], r['course'], r['due_date'], r.get('due_time'))
             for r in qualifying]
        )
    else:
        conn.execute('DELETE FROM sheets_inbox_item')
    conn.commit()
    conn.close()


def get_sheets_inbox_items():
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM sheets_inbox_item ORDER BY due_date, due_time'
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- Experiments ---

def get_experiments():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM experiment ORDER BY created_at DESC').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_experiment(data):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO experiment (title, hypothesis, prediction, scope, started_at) VALUES (?,?,?,?,?)',
        (data['title'], data['hypothesis'], data['prediction'],
         data.get('scope', 'operating'), data['started_at'])
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM experiment WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_experiment(id, data):
    allowed = ('status', 'ended_at')
    updates = {k: data[k] for k in allowed if k in data}
    if not updates:
        conn = get_conn()
        row = conn.execute('SELECT * FROM experiment WHERE id = ?', (id,)).fetchone()
        conn.close()
        return dict(row)
    fields = ', '.join(f'{k} = ?' for k in updates)
    values = list(updates.values()) + [id]
    conn = get_conn()
    conn.execute(f'UPDATE experiment SET {fields} WHERE id = ?', values)
    conn.commit()
    row = conn.execute('SELECT * FROM experiment WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


# --- Block Feedback ---

def upsert_block_feedback(block_id, date, positive):
    conn = get_conn()
    cur = conn.execute(
        'INSERT OR REPLACE INTO block_feedback (block_id, date, positive) VALUES (?,?,?)',
        (block_id, date, 1 if positive else 0)
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM block_feedback WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def get_block_hit_rate(area_id=None, since=None, until=None):
    conn = get_conn()
    params = []
    where = []
    if area_id is not None:
        where.append('rb.area_id = ?')
        params.append(area_id)
    if since:
        where.append('bf.date >= ?')
        params.append(since)
    if until:
        where.append('bf.date <= ?')
        params.append(until)
    where_clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(f'''
        SELECT bf.positive FROM block_feedback bf
        JOIN recurring_block rb ON bf.block_id = rb.id
        {where_clause}
    ''', params).fetchall()
    conn.close()
    total = len(rows)
    pos = sum(1 for r in rows if r['positive'])
    if total == 0:
        return {'positive': 0, 'total': 0, 'display': '–'}
    return {'positive': pos, 'total': total, 'display': f'{pos}/{total}'}


# --- Review Status ---

def get_review_status():
    import json as _json
    from datetime import datetime, timedelta
    conn = get_conn()
    rows = conn.execute('''
        SELECT 'yearly' AS cadence, MAX(created_at) AS last_date FROM yearly_review
        UNION ALL
        SELECT 'quarterly', MAX(created_at) FROM (
            SELECT created_at FROM quarterly_review
            UNION ALL SELECT created_at FROM yearly_review
        )
        UNION ALL
        SELECT 'monthly', MAX(created_at) FROM (
            SELECT created_at FROM monthly_review
            UNION ALL SELECT created_at FROM quarterly_review
            UNION ALL SELECT created_at FROM yearly_review
        )
        UNION ALL
        SELECT 'weekly', MAX(created_at) FROM (
            SELECT created_at FROM weekly_review
            UNION ALL SELECT created_at FROM monthly_review
            UNION ALL SELECT created_at FROM quarterly_review
            UNION ALL SELECT created_at FROM yearly_review
        )
    ''').fetchall()
    conn.close()
    dates = {r['cadence']: r['last_date'] for r in rows}
    priority = ['yearly', 'quarterly', 'monthly', 'weekly']
    # Calendar-anchored: each cadence is due from its period start (Sunday /
    # 1st of month / quarter start / Jan 1) until completed within the period,
    # even if the previous one was completed late
    today = date_cls.today()
    period_start = {
        'yearly': today.replace(month=1, day=1),
        'quarterly': today.replace(month=((today.month - 1) // 3) * 3 + 1, day=1),
        'monthly': today.replace(day=1),
        'weekly': today - timedelta(days=(today.weekday() + 1) % 7),
    }
    due = None
    for cadence in priority:
        last = dates.get(cadence)
        if last is None:
            due = cadence
            break
        last_dt = datetime.fromisoformat(last.replace(' ', 'T').split('.')[0])
        last_local = last_dt.replace(tzinfo=timezone.utc).astimezone().date()
        if last_local < period_start[cadence]:
            due = cadence
            break

    def _fmt(d):
        return d[:10] if d else None

    return {
        'due': due,
        'last_weekly': _fmt(dates.get('weekly')),
        'last_monthly': _fmt(dates.get('monthly')),
        'last_quarterly': _fmt(dates.get('quarterly')),
        'last_yearly': _fmt(dates.get('yearly')),
    }


# --- Weekly Reviews ---

def create_weekly_review(data):
    import json as _json
    focuses = data.get('next_focuses')
    if isinstance(focuses, list):
        focuses = _json.dumps(focuses)
    conn = get_conn()
    conn.execute(
        '''INSERT INTO weekly_review (week_start_date, learning_capture, next_focuses, inbox_cleared_at)
           VALUES (?,?,?,?)
           ON CONFLICT(week_start_date) DO UPDATE SET
             learning_capture = excluded.learning_capture,
             next_focuses = excluded.next_focuses,
             inbox_cleared_at = excluded.inbox_cleared_at,
             created_at = datetime('now','localtime')''',
        (data['week_start_date'], data['learning_capture'], focuses,
         data.get('inbox_cleared_at'))
    )
    conn.commit()
    row = conn.execute(
        'SELECT * FROM weekly_review WHERE week_start_date = ?', (data['week_start_date'],)
    ).fetchone()
    conn.close()
    r = dict(row)
    if r.get('next_focuses'):
        r['next_focuses'] = _json.loads(r['next_focuses'])
    return r


def get_weekly_reviews(limit=4):
    import json as _json
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM weekly_review ORDER BY week_start_date DESC LIMIT ?', (limit,)
    ).fetchall()
    conn.close()
    result = []
    for row in rows:
        r = dict(row)
        if r.get('next_focuses'):
            r['next_focuses'] = _json.loads(r['next_focuses'])
        result.append(r)
    return result


# --- Journal (daily bottleneck / experiment / rating + weekly habit) ---

def _ts_key(ts):
    if not ts:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00').replace(' ', 'T'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def get_journal_days(since=None, until=None):
    conn = get_conn()
    q = 'SELECT * FROM journal_day'
    clauses, params = [], []
    if since:
        clauses.append('date >= ?'); params.append(since)
    if until:
        clauses.append('date <= ?'); params.append(until)
    if clauses:
        q += ' WHERE ' + ' AND '.join(clauses)
    q += ' ORDER BY date DESC'
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_journal_day(date):
    conn = get_conn()
    row = conn.execute('SELECT * FROM journal_day WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row) if row else None


def upsert_journal_day(date, fields, updated_at=None):
    ts = updated_at or datetime.now(timezone.utc).isoformat()
    cols = [k for k in ('bottleneck', 'active_experiment', 'rating', 'habit_mark') if k in fields]
    conn = get_conn()
    conn.execute('INSERT OR IGNORE INTO journal_day (date, updated_at) VALUES (?, ?)', (date, ts))
    if cols:
        sets = ', '.join(f'{c} = ?' for c in cols) + ', updated_at = ?'
        params = [fields[c] for c in cols] + [ts, date]
        conn.execute(f'UPDATE journal_day SET {sets} WHERE date = ?', params)
    else:
        conn.execute('UPDATE journal_day SET updated_at = ? WHERE date = ?', (ts, date))
    conn.commit()
    row = conn.execute('SELECT * FROM journal_day WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row)


# Last-write-wins merge of Worker-sourced rows (each carries a full row +
# updated_at). A local row is overwritten only when the incoming stamp is newer.
def merge_journal_entries(entries):
    conn = get_conn()
    changed = 0
    for e in entries or []:
        d = e.get('date')
        if not d:
            continue
        ts = e.get('updated_at') or datetime.now(timezone.utc).isoformat()
        existing = conn.execute('SELECT updated_at FROM journal_day WHERE date = ?', (d,)).fetchone()
        if existing and _ts_key(existing['updated_at']) >= _ts_key(ts):
            continue
        conn.execute(
            '''INSERT INTO journal_day (date, bottleneck, active_experiment, rating, habit_mark, updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(date) DO UPDATE SET
                 bottleneck = excluded.bottleneck,
                 active_experiment = excluded.active_experiment,
                 rating = excluded.rating,
                 habit_mark = excluded.habit_mark,
                 updated_at = excluded.updated_at''',
            (d, e.get('bottleneck') or '', e.get('active_experiment') or '',
             e.get('rating'), e.get('habit_mark'), ts)
        )
        changed += 1
    conn.commit()
    conn.close()
    return changed


def set_habit_week(week_start_date, habit):
    conn = get_conn()
    conn.execute(
        '''INSERT INTO habit_week (week_start_date, habit) VALUES (?, ?)
           ON CONFLICT(week_start_date) DO UPDATE SET habit = excluded.habit''',
        (week_start_date, habit)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM habit_week WHERE week_start_date = ?', (week_start_date,)).fetchone()
    conn.close()
    return dict(row)


# The habit in force on a given date = the most recent habit_week that started
# on or before it.
def get_habit_week_for(date):
    conn = get_conn()
    row = conn.execute(
        'SELECT * FROM habit_week WHERE week_start_date <= ? ORDER BY week_start_date DESC LIMIT 1',
        (date,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_habit_weeks(limit=12):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM habit_week ORDER BY week_start_date DESC LIMIT ?', (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _habit_stats(conn, habit_id, today):
    # Three windows, three questions. Last 14 days of MARKS -> the health
    # spectrum (grey under 5 marks — two data points must not render a
    # confident colour). Last 10 days of EFFORT answers -> graduation (>= 70%
    # ran-on-its-own, and at least 5 answers so 1/1 can't read as 100%).
    # All-time counts -> the review tally.
    d14 = (date_cls.fromisoformat(today) - timedelta(days=14)).isoformat()
    d10 = (date_cls.fromisoformat(today) - timedelta(days=10)).isoformat()
    rows = conn.execute(
        'SELECT date, mark, effort FROM habit_day WHERE habit_id = ?', (habit_id,)).fetchall()
    t = {'ehh': 0, 'good': 0, 'great': 0, 'days': 0}
    recent_n = recent_score = auto = answered = 0
    for r in rows:
        if r['mark']:
            t[r['mark']] += 1
            t['days'] += 1
            if r['date'] > d14:
                recent_n += 1
                recent_score += {'ehh': 0, 'good': 1, 'great': 2}[r['mark']]
        if r['effort'] and r['date'] > d10:
            answered += 1
            auto += 1 if r['effort'] == 'auto' else 0
    t['health'] = None if recent_n < 5 else round(recent_score / (2 * recent_n), 2)
    t['auto_recent'] = auto
    t['effort_answered'] = answered
    return t


def get_habits_overview(today):
    conn = get_conn()
    habits = [dict(r) for r in conn.execute(
        'SELECT * FROM habit ORDER BY started_on DESC, id DESC').fetchall()]
    for h in habits:
        h['tally'] = _habit_stats(conn, h['id'], today)
        t = h['tally']
        age = (date_cls.fromisoformat(today) - date_cls.fromisoformat(h['started_on'])).days
        # Quentin's rule (2026-08-11): habits take a while — ~30 days old, and
        # the last 10 days mostly running on their own. Adherence is NOT a
        # condition here: the spectrum shows behaviour health, the effort probe
        # decides formation, and a deep-green white-knuckle habit is not done.
        h['suggest'] = bool(h['status'] == 'forming' and age >= 30
                            and t['effort_answered'] >= 5
                            and t['auto_recent'] / t['effort_answered'] >= 0.7)
    legacy = [dict(r) for r in conn.execute(
        'SELECT * FROM habit_week ORDER BY week_start_date DESC').fetchall()]
    conn.close()
    return {'forming': [h for h in habits if h['status'] == 'forming'],
            'ledger': [h for h in habits if h['status'] != 'forming'],
            'legacy': legacy}


def create_habit(content, started_on, experiment_id=None):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO habit (content, started_on, experiment_id) VALUES (?,?,?)',
        (content, started_on, experiment_id))
    conn.commit()
    row = conn.execute('SELECT * FROM habit WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def set_habit_status(id, status, verdict=None, today=None):
    conn = get_conn()
    conn.execute(
        'UPDATE habit SET status = ?, verdict = ?, ended_on = ? WHERE id = ?',
        (status, verdict,
         None if status == 'forming' else (today or date_cls.today().isoformat()), id))
    conn.commit()
    row = conn.execute('SELECT * FROM habit WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def mark_habit_day(habit_id, date, mark=_UNSET, effort=_UNSET):
    # Partial upsert: each axis lands independently, and re-tapping overwrites —
    # which is why the nightly marks need no undo entry.
    conn = get_conn()
    conn.execute('INSERT OR IGNORE INTO habit_day (habit_id, date) VALUES (?,?)',
                 (habit_id, date))
    if mark is not _UNSET:
        conn.execute('UPDATE habit_day SET mark = ? WHERE habit_id = ? AND date = ?',
                     (mark, habit_id, date))
    if effort is not _UNSET:
        conn.execute('UPDATE habit_day SET effort = ? WHERE habit_id = ? AND date = ?',
                     (effort, habit_id, date))
    conn.commit()
    row = conn.execute('SELECT * FROM habit_day WHERE habit_id = ? AND date = ?',
                       (habit_id, date)).fetchone()
    conn.close()
    return dict(row)


def habit_marks_for(date):
    conn = get_conn()
    rows = conn.execute('SELECT * FROM habit_day WHERE date = ?', (date,)).fetchall()
    conn.close()
    return {r['habit_id']: dict(r) for r in rows}


def create_habit_experiment(content, started_on):
    # ONE experiment at a time — one variable is what makes it an experiment,
    # and it is what keeps the nightly 1-7 unambiguous. Refusing here is the
    # backstop; the review only offers "start" when nothing is running.
    conn = get_conn()
    if conn.execute("SELECT id FROM habit_experiment WHERE status = 'running'").fetchone():
        conn.close()
        return None
    cur = conn.execute('INSERT INTO habit_experiment (content, started_on) VALUES (?,?)',
                       (content, started_on))
    conn.commit()
    row = conn.execute('SELECT * FROM habit_experiment WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def rename_habit_experiment(id, content):
    # A RUNNING experiment can be reworded: you keep the same variable but say
    # it better than you did last night. Only while running — rewriting one the
    # review is about to judge would change the thing being judged.
    conn = get_conn()
    conn.execute("UPDATE habit_experiment SET content = ? WHERE id = ? AND status = 'running'",
                 (content, id))
    conn.commit()
    row = conn.execute('SELECT * FROM habit_experiment WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def resolve_habit_experiment(id, resolution, today=None):
    conn = get_conn()
    conn.execute(
        """UPDATE habit_experiment SET status = 'resolved', resolution = ?, resolved_on = ?
           WHERE id = ? AND status = 'running'""",
        (resolution, today or date_cls.today().isoformat(), id))
    conn.commit()
    row = conn.execute('SELECT * FROM habit_experiment WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def evaluate_habit_experiment(id, outcome, today=None):
    # The verb is passed at the WEEKLY REVIEW, never before: a resolved
    # experiment stays awaiting-evaluation however long ago it resolved, and
    # 'wait' is simply not acting. 'habit' is the one outcome with a side
    # effect — the habit starts here — and only ONE promotion per review week
    # (Quentin, 2026-08-11): a week's attention goes to one new habit, and the
    # rest keep waiting. Refused here as well as hidden in the UI, so the rule
    # survives a second surface later.
    today = today or date_cls.today().isoformat()
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM habit_experiment WHERE id = ? AND status = 'resolved'", (id,)).fetchone()
    if not row:
        conn.close()
        return None
    if outcome == 'habit':
        week = _week_start(date_cls.fromisoformat(today))
        taken = conn.execute(
            """SELECT id FROM habit_experiment
               WHERE outcome = 'habit' AND evaluated_on >= ?""", (week,)).fetchone()
        if taken:
            conn.close()
            return {'error': 'promoted'}
    conn.execute(
        """UPDATE habit_experiment SET status = 'evaluated', outcome = ?, evaluated_on = ?
           WHERE id = ?""", (outcome, today, id))
    conn.commit()
    conn.close()
    habit = create_habit(row['content'], today, id) if outcome == 'habit' else None
    return {'experiment': dict(row, status='evaluated', outcome=outcome,
                               evaluated_on=today), 'habit': habit}


def unevaluate_habit_experiment(id):
    # The undo half of evaluate: back to awaiting, and the habit it minted (if
    # any) goes with it — half an undo would strand a habit nothing decided on.
    conn = get_conn()
    conn.execute(
        """UPDATE habit_experiment SET status = 'resolved', outcome = NULL, evaluated_on = NULL
           WHERE id = ?""", (id,))
    conn.execute('DELETE FROM habit WHERE experiment_id = ?', (id,))
    conn.commit()
    conn.close()


def reopen_habit_experiment(id):
    # The undo half of ending one at night, whichever end it was: back to
    # running, with the resolution and any evaluation wiped, and any habit it
    # minted removed. Refused while another is running — one at a time is the
    # invariant, and an undo must not be the way around it.
    conn = get_conn()
    other = conn.execute(
        "SELECT id FROM habit_experiment WHERE status = 'running' AND id != ?", (id,)).fetchone()
    if other:
        conn.close()
        return {'error': 'another experiment is running'}
    conn.execute('DELETE FROM habit WHERE experiment_id = ?', (id,))
    conn.execute(
        """UPDATE habit_experiment SET status = 'running', resolution = NULL,
           resolved_on = NULL, outcome = NULL, evaluated_on = NULL WHERE id = ?""", (id,))
    conn.commit()
    row = conn.execute('SELECT * FROM habit_experiment WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_habit_experiments_overview(today):
    d30 = (date_cls.fromisoformat(today) - timedelta(days=30)).isoformat()
    conn = get_conn()
    running = conn.execute("SELECT * FROM habit_experiment WHERE status = 'running'").fetchone()
    awaiting = [dict(r) for r in conn.execute(
        "SELECT * FROM habit_experiment WHERE status = 'resolved' ORDER BY resolved_on").fetchall()]
    evaluated = [dict(r) for r in conn.execute(
        "SELECT * FROM habit_experiment WHERE status = 'evaluated' AND evaluated_on >= ? ORDER BY evaluated_on DESC",
        (d30,)).fetchall()]
    week = _week_start(date_cls.fromisoformat(today))
    promoted = [dict(r) for r in conn.execute(
        """SELECT * FROM habit_experiment
           WHERE outcome = 'habit' AND evaluated_on >= ?""", (week,)).fetchall()]
    conn.close()
    return {'running': dict(running) if running else None,
            'awaiting': awaiting, 'evaluated': evaluated,
            'promoted_this_week': promoted}


# --- Monthly Reviews ---

def create_monthly_review(data):
    import json as _json
    focuses = data.get('next_focuses')
    if isinstance(focuses, list):
        focuses = _json.dumps(focuses)
    conn = get_conn()
    try:
        conn.execute('BEGIN')
        cur = conn.execute(
            'INSERT INTO monthly_review (month, synthesis, next_focuses) VALUES (?,?,?)',
            (data['month'], data['synthesis'], focuses)
        )
        review_id = cur.lastrowid
        for v in data.get('verdicts') or []:
            conn.execute(
                '''INSERT INTO monthly_experiment_verdict
                   (monthly_review_id, experiment_id, verdict, notes) VALUES (?,?,?,?)''',
                (review_id, v['experiment_id'], v['verdict'], v.get('notes'))
            )
        for ps in data.get('project_statuses') or []:
            conn.execute(
                '''INSERT INTO monthly_project_status
                   (monthly_review_id, area_id, status, notes) VALUES (?,?,?,?)''',
                (review_id, ps['area_id'], ps['status'], ps.get('notes'))
            )
        conn.execute('COMMIT')
        row = conn.execute('SELECT * FROM monthly_review WHERE id = ?', (review_id,)).fetchone()
        conn.close()
        r = dict(row)
        if r.get('next_focuses'):
            r['next_focuses'] = _json.loads(r['next_focuses'])
        return r
    except Exception:
        conn.execute('ROLLBACK')
        conn.close()
        raise


def get_monthly_reviews(limit=3):
    import json as _json
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM monthly_review ORDER BY month DESC LIMIT ?', (limit,)
    ).fetchall()
    conn.close()
    result = []
    for row in rows:
        r = dict(row)
        if r.get('next_focuses'):
            r['next_focuses'] = _json.loads(r['next_focuses'])
        result.append(r)
    return result


def get_monthly_brief(month):
    import json as _json
    from datetime import datetime, timedelta
    conn = get_conn()
    try:
        month_dt = datetime.fromisoformat(month)
    except Exception:
        month_dt = datetime.utcnow().replace(day=1)
    month_start = month_dt.strftime('%Y-%m-01')
    next_month = (month_dt.replace(day=28) + timedelta(days=4)).replace(day=1)
    month_end = (next_month - timedelta(days=1)).strftime('%Y-%m-%d')

    weekly_rows = conn.execute(
        '''SELECT week_start_date, learning_capture, next_focuses FROM weekly_review
           WHERE week_start_date >= ? AND week_start_date <= ?
           ORDER BY week_start_date DESC LIMIT 4''',
        (month_start, month_end)
    ).fetchall()

    project_rows = conn.execute(
        '''SELECT rb.area_id, p.name,
           SUM(bf.positive) as positive, COUNT(bf.id) as total
           FROM block_feedback bf
           JOIN recurring_block rb ON bf.block_id = rb.id
           JOIN area p ON rb.area_id = p.id
           WHERE bf.date >= ? AND bf.date <= ?
           GROUP BY rb.area_id, p.name''',
        (month_start, month_end)
    ).fetchall()

    daily_rows = conn.execute(
        '''SELECT date, synthesis FROM daily_review
           WHERE date >= ? AND date <= ? AND synthesis != ''
           ORDER BY date DESC''',
        (month_start, month_end)
    ).fetchall()

    active_exp = conn.execute(
        "SELECT * FROM experiment WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()

    standing = conn.execute(
        "SELECT id, title, ended_at FROM experiment WHERE status = 'graduated' ORDER BY ended_at DESC"
    ).fetchall()

    conn.close()

    weekly_learnings = [
        {'week_start_date': r['week_start_date'], 'learning_capture': r['learning_capture']}
        for r in weekly_rows
    ]
    weekly_focuses = []
    for r in weekly_rows:
        focuses = r['next_focuses']
        if focuses:
            weekly_focuses.append({
                'week_start_date': r['week_start_date'],
                'next_focuses': _json.loads(focuses)
            })

    project_hit_rates = []
    for r in project_rows:
        total = r['total'] or 0
        pos = r['positive'] or 0
        project_hit_rates.append({
            'area_id': r['area_id'],
            'name': r['name'],
            'positive': pos,
            'total': total,
            'display': f'{pos}/{total}' if total else '–'
        })

    active_experiment = None
    if active_exp:
        from datetime import date as _date
        try:
            started = datetime.fromisoformat(active_exp['started_at'])
            days_running = (datetime.utcnow() - started).days
        except Exception:
            days_running = 0
        active_experiment = {
            'id': active_exp['id'],
            'title': active_exp['title'],
            'prediction': active_exp['prediction'],
            'days_running': days_running
        }

    return {
        'weekly_learnings': weekly_learnings,
        'weekly_focuses': weekly_focuses,
        'project_hit_rates': project_hit_rates,
        'daily_syntheses': [dict(r) for r in daily_rows],
        'active_experiment': active_experiment,
        'standing_practices': [dict(r) for r in standing]
    }


# --- Daily Reviews ---

def create_daily_review(data):
    conn = get_conn()
    conn.execute(
        '''INSERT INTO daily_review (date, pdsa_study, synthesis, tomorrow_focus)
           VALUES (?,?,?,?)
           ON CONFLICT(date) DO UPDATE SET
               pdsa_study=excluded.pdsa_study,
               synthesis=excluded.synthesis,
               tomorrow_focus=excluded.tomorrow_focus''',
        (data['date'], data.get('pdsa_study', ''),
         data.get('synthesis', ''), data.get('tomorrow_focus', ''))
    )
    conn.commit()
    row = conn.execute('SELECT * FROM daily_review WHERE date = ?', (data['date'],)).fetchone()
    conn.close()
    return dict(row)


def get_daily_reviews(since=None, until=None):
    conn = get_conn()
    params = []
    where = []
    if since:
        where.append('date >= ?')
        params.append(since)
    if until:
        where.append('date <= ?')
        params.append(until)
    where_clause = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = conn.execute(
        f'SELECT * FROM daily_review {where_clause} ORDER BY date DESC', params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- Quarterly Reviews ---

def create_quarterly_review(data):
    import json as _json
    focuses = data.get('focuses')
    if isinstance(focuses, list):
        focuses = _json.dumps(focuses)
    conn = get_conn()
    try:
        conn.execute('BEGIN')
        cur = conn.execute(
            '''INSERT INTO quarterly_review (quarter, theme, focuses, hamming_insight, paper_notes_path)
               VALUES (?,?,?,?,?)''',
            (data['quarter'], data.get('theme'), focuses,
             data['hamming_insight'], data.get('paper_notes_path'))
        )
        review_id = cur.lastrowid
        for lar in data.get('life_area_ratings') or []:
            conn.execute(
                '''INSERT INTO life_area_rating
                   (quarterly_review_id, life_area, rating, is_bottom_3, notes)
                   VALUES (?,?,?,?,?)''',
                (review_id, lar['life_area'], lar['rating'],
                 1 if lar.get('is_bottom_3') else 0, lar.get('notes'))
            )
        conn.execute('COMMIT')
        row = conn.execute('SELECT * FROM quarterly_review WHERE id = ?', (review_id,)).fetchone()
        conn.close()
        r = dict(row)
        if r.get('focuses'):
            r['focuses'] = _json.loads(r['focuses'])
        return r
    except Exception:
        conn.execute('ROLLBACK')
        conn.close()
        raise


def get_quarterly_reviews(limit=4):
    import json as _json
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM quarterly_review ORDER BY created_at DESC LIMIT ?', (limit,)
    ).fetchall()
    conn.close()
    result = []
    for row in rows:
        r = dict(row)
        if r.get('focuses'):
            r['focuses'] = _json.loads(r['focuses'])
        result.append(r)
    return result


def get_quarterly_brief(quarter):
    import json as _json
    conn = get_conn()

    monthly_rows = conn.execute(
        'SELECT month, synthesis, next_focuses FROM monthly_review ORDER BY month DESC LIMIT 3'
    ).fetchall()

    verdict_rows = conn.execute(
        '''SELECT mev.experiment_id, e.title, mev.verdict, mr.month
           FROM monthly_experiment_verdict mev
           JOIN experiment e ON mev.experiment_id = e.id
           JOIN monthly_review mr ON mev.monthly_review_id = mr.id
           ORDER BY mr.month DESC LIMIT 20'''
    ).fetchall()

    project_rows = conn.execute(
        '''SELECT mps.area_id, p.name, mps.status, mr.month
           FROM monthly_project_status mps
           JOIN area p ON mps.area_id = p.id
           JOIN monthly_review mr ON mps.monthly_review_id = mr.id
           ORDER BY mr.month DESC LIMIT 20'''
    ).fetchall()

    prev_ratings = conn.execute(
        '''SELECT life_area, rating, is_bottom_3
           FROM life_area_rating
           WHERE quarterly_review_id = (
               SELECT id FROM quarterly_review ORDER BY created_at DESC LIMIT 1
           )'''
    ).fetchall()

    yearly = conn.execute(
        'SELECT annual_theme, major_goals FROM yearly_review ORDER BY year DESC LIMIT 1'
    ).fetchone()

    conn.close()

    life_area_labels = {
        'values_purpose': 'Values & Purpose',
        'contribution_impact': 'Contribution & Impact',
        'location_tangibles': 'Location & Tangibles',
        'money_finances': 'Money & Finances',
        'career_work': 'Career & Work',
        'health_fitness': 'Health & Fitness',
        'education_skills': 'Education & Skills',
        'social_relationships': 'Social Relationships',
        'emotions_wellbeing': 'Emotions & Wellbeing',
        'character_identity': 'Character & Identity',
        'productivity_organization': 'Productivity & Organization',
        'adventure_creativity': 'Adventure & Creativity',
    }
    canonical_order = list(life_area_labels.keys())
    ratings_map = {r['life_area']: r for r in prev_ratings}
    previous_ratings = []
    for la in canonical_order:
        r = ratings_map.get(la)
        previous_ratings.append({
            'life_area': la,
            'display': life_area_labels[la],
            'rating': r['rating'] if r else None,
            'is_bottom_3': bool(r['is_bottom_3']) if r else False
        })

    monthly_syntheses = []
    for row in monthly_rows:
        entry = {'month': row['month'], 'synthesis': row['synthesis'], 'next_focuses': []}
        if row['next_focuses']:
            entry['next_focuses'] = _json.loads(row['next_focuses'])
        monthly_syntheses.append(entry)

    annual_theme = None
    major_goals = None
    if yearly:
        annual_theme = yearly['annual_theme']
        if yearly['major_goals']:
            major_goals = _json.loads(yearly['major_goals'])

    return {
        'monthly_syntheses': monthly_syntheses,
        'experiment_verdicts': [dict(r) for r in verdict_rows],
        'project_activity': [dict(r) for r in project_rows],
        'previous_life_area_ratings': previous_ratings,
        'annual_theme': annual_theme,
        'major_goals': major_goals
    }


def get_yearly_reviews_current():
    import json as _json
    conn = get_conn()
    row = conn.execute(
        'SELECT * FROM yearly_review ORDER BY year DESC LIMIT 1'
    ).fetchone()
    conn.close()
    if not row:
        return None
    r = dict(row)
    if r.get('major_goals'):
        r['major_goals'] = _json.loads(r['major_goals'])
    return r


# --- Review Context (read-only panel) ---

def get_review_context():
    import json as _json
    conn = get_conn()

    yearly = conn.execute(
        'SELECT annual_theme, major_goals FROM yearly_review ORDER BY year DESC LIMIT 1'
    ).fetchone()

    quarterly = conn.execute(
        'SELECT focuses FROM quarterly_review ORDER BY created_at DESC LIMIT 1'
    ).fetchone()

    active_exp = conn.execute(
        "SELECT id, title, hypothesis, prediction FROM experiment WHERE status = 'active' LIMIT 1"
    ).fetchone()

    conn.close()

    annual_theme = yearly['annual_theme'] if yearly else None
    major_goals = None
    if yearly and yearly['major_goals']:
        major_goals = _json.loads(yearly['major_goals'])

    quarterly_focuses = None
    if quarterly and quarterly['focuses']:
        quarterly_focuses = _json.loads(quarterly['focuses'])

    active_experiment = None
    if active_exp:
        active_experiment = dict(active_exp)

    return {
        'annual_theme': annual_theme,
        'major_goals': major_goals,
        'quarterly_focuses': quarterly_focuses,
        'active_experiment': active_experiment
    }


# --- Observations ---

def create_observation(data):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO observation (kind, block_id, note, now_block) VALUES (?,?,?,?)',
        (data['kind'], data.get('block_id'), data.get('note', ''), data.get('now_block'))
    )
    row_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM observation WHERE id = ?', (row_id,)).fetchone()
    conn.close()
    return dict(row)


def get_observations(since=None):
    conn = get_conn()
    if since:
        rows = conn.execute(
            'SELECT * FROM observation WHERE captured_at >= ? ORDER BY captured_at DESC',
            (since,)
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM observation ORDER BY captured_at DESC LIMIT 100'
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_locations():
    conn = get_conn()
    rows = conn.execute('SELECT * FROM location ORDER BY name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def step_due_on(step, day):
    # An RRULE wins where one is set; otherwise the older digit-string
    # weekday grammar. 0=Mon..6=Sun, the app's one weekday convention (see
    # _recurring_due and nodes.days_of_week). Empty/NULL = every day: a step
    # with no opinion about the calendar runs, which is the only safe default
    # for a routine that gates a QR.
    rule = step.get('rrule')
    if rule:
        ds = step.get('dtstart')
        return recurrence.occurs_on(rule, date_cls.fromisoformat(ds) if ds else RRULE_EPOCH, day)
    dow = step.get('days_of_week')
    return not dow or str(day.weekday()) in dow


# WHICH RUN a given day belongs to. A daily routine files its run under the day;
# a weekly one files it under that week's Monday, so every day of the week ticks
# into the same run and Sunday's Done ✓ finishes what Tuesday started. This is
# the ONLY thing `period` changes, and it is computed in one place so the runner,
# the fold-out and the judge cannot disagree about it.
def flow_period_key(period, day):
    return _week_start(day) if (period or 'day') == 'week' else day.isoformat()


def flow_period_key_for(flow_id, ymd):
    conn = get_conn()
    row = conn.execute('SELECT period FROM flow WHERE id = ?', (flow_id,)).fetchone()
    conn.close()
    return flow_period_key(row['period'] if row else 'day', date_cls.fromisoformat(ymd))


# ── The weekly review IS a routine (2026-08-12) ───────────────
#
# It was a hardcoded 11-item checklist in app.js with its own run table
# (gtd_review.steps) — a second grammar for exactly what flow + flow_step +
# flow_run already say. So it becomes a flow: period 'week', one step per
# Allen step, and the ticks live in flow_run like every other routine's.
#
# The step KINDS are the step→surface binding. `review_in_zero` and
# `review_sweep` have real runner pages (clarify the inbox; the 5-minute
# sweep); the other nine are pages that only state the step and take the tick,
# deliberately, until each one earns its surface. The kind is what the GTD
# fold-out joins its live counts on, so a step keeps its badge whether you tick
# it there or run it in the runner.
#
# `content` is seeded from Allen's wording and is then the user's to rewrite —
# the kind, not the text, is the identity.
REVIEW_FLOW_NAME = 'Weekly review'
REVIEW_FLOW_STEPS = (
    ('review_collect', 'Collect loose papers and materials'),
    ('review_in_zero', 'Get "in" to empty'),
    ('review_sweep', 'Empty your head'),
    ('review_cal_back', 'Review previous calendar, 2–3 weeks back'),
    ('review_cal_fwd', 'Review upcoming calendar'),
    ('review_waiting', 'Review waiting-for and deferred'),
    ('review_projects', 'Every active project and its next actions'),
    ('review_checklists', 'Review any relevant checklists'),
    ('review_someday', 'Review someday/maybe'),
    ('review_creative', 'Be creative and courageous'),
    ('review_habits', 'Judge habits and experiments'),
)


def _review_flow_id(conn):
    # The review flow is the one that owns the in-zero step. No marker column:
    # the kinds already identify it, and a second marker could disagree.
    row = conn.execute(
        "SELECT flow_id FROM flow_step WHERE kind = 'review_in_zero' LIMIT 1").fetchone()
    return row['flow_id'] if row else None


def get_review_flow_id():
    conn = get_conn()
    id = _review_flow_id(conn)
    conn.close()
    return id


def _seed_review_flow(conn):
    if _review_flow_id(conn):
        return
    pos = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM flow').fetchone()['p']
    cur = conn.execute("INSERT INTO flow (name, position, period) VALUES (?, ?, 'week')",
                       (REVIEW_FLOW_NAME, pos))
    flow_id = cur.lastrowid
    by_kind = {}
    for i, (kind, content) in enumerate(REVIEW_FLOW_STEPS):
        c = conn.execute(
            '''INSERT INTO flow_step (flow_id, position, kind, content, requirement)
               VALUES (?, ?, ?, ?, 'hard')''', (flow_id, i + 1, kind, content))
        by_kind[kind] = c.lastrowid
    # Carry the old checklist's ticks over rather than blanking a review in
    # progress. Old keys were the step key ('in_zero') and, for the collect
    # sweep, 'collect:<inbox>' — the sub-key idiom survives as '<step_id>:<inbox>'
    # because flow_run.steps is a free blob and the runner only ever reads
    # steps[step.id].
    for row in conn.execute('SELECT * FROM gtd_review').fetchall():
        try:
            old = json.loads(row['steps'] or '{}')
        except ValueError:
            continue
        moved = {}
        for key, stamp in old.items():
            base, _, sub = key.partition(':')
            sid = by_kind.get('review_' + base)
            if sid:
                moved[f'{sid}:{sub}' if sub else str(sid)] = stamp
        if not moved:
            continue
        conn.execute('''INSERT INTO flow_run (flow_id, date, steps, completed_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(flow_id, date) DO NOTHING''',
                     (flow_id, row['week_start_date'], json.dumps(moved), row['completed_at']))
    conn.commit()


def _backfill_review_steps(conn):
    # _seed_review_flow only fires on a db with NO review flow, so a step added
    # to REVIEW_FLOW_STEPS later would never reach a review that already
    # exists. Append the missing kinds rather than reseeding: the existing
    # steps keep their ids, and flow_run.steps is keyed BY step id, so
    # renumbering would blank every tick ever recorded.
    #
    # `review_steps_offered` is what makes this safe to run at every start. A
    # review step is an ordinary editable row, so without the ledger a step the
    # user deliberately DELETED would grow back on the next launch and could
    # never be removed. Each kind is offered exactly ONCE. A db seeded before
    # this ledger existed has no setting — what it currently holds is what it
    # was offered.
    flow_id = _review_flow_id(conn)
    if not flow_id:
        return
    have = [r['kind'] for r in conn.execute(
        'SELECT kind FROM flow_step WHERE flow_id = ? ORDER BY position, id',
        (flow_id,)).fetchall()]
    row = conn.execute(
        "SELECT value FROM setting WHERE key = 'review_steps_offered'").fetchone()
    offered = set((row['value'] if row else ','.join(have)).split(','))
    pos = conn.execute(
        'SELECT COALESCE(MAX(position), 0) AS p FROM flow_step WHERE flow_id = ?',
        (flow_id,)).fetchone()['p']
    added = []
    for kind, content in REVIEW_FLOW_STEPS:
        if kind in offered or kind in have:
            continue
        pos += 1
        conn.execute(
            '''INSERT INTO flow_step (flow_id, position, kind, content, requirement)
               VALUES (?, ?, ?, ?, 'hard')''', (flow_id, pos, kind, content))
        added.append(kind)
    conn.execute(
        "INSERT OR REPLACE INTO setting (key, value) VALUES ('review_steps_offered', ?)",
        (','.join(sorted(offered | set(have) | set(added))),))
    conn.commit()
    if added:
        print('weekly review: added step(s) ' + ', '.join(added))


def _merge_review_next_actions(conn):
    # 'Review next-action lists' and 'Every active project has a next action'
    # were ONE question asked twice — per project, is there a next action? — so
    # they are one step now (2026-08-17), showing every active project with the
    # actions under it.
    #
    # Done ONCE and recorded, for the same reason _backfill_review_steps has a
    # ledger: the steps are ordinary editable rows, so re-running this would
    # delete a step the user had since re-added on purpose. Ticks left behind in
    # flow_run.steps are harmless — the runner only ever reads steps[step.id]
    # for a step that still exists, and an orphan key is never looked up.
    if conn.execute(
            "SELECT value FROM setting WHERE key = 'review_next_actions_merged'").fetchone():
        return
    flow_id = _review_flow_id(conn)
    if flow_id:
        conn.execute("DELETE FROM flow_step WHERE flow_id = ? AND kind = 'review_next_actions'",
                     (flow_id,))
        # The wording is the USER'S to rewrite, so only the untouched default is
        # renamed. A step he had already reworded keeps his words.
        conn.execute(
            """UPDATE flow_step SET content = ?
               WHERE flow_id = ? AND kind = 'review_projects'
                 AND content = 'Every active project has a next action'""",
            ('Every active project and its next actions', flow_id))
    conn.execute(
        "INSERT OR REPLACE INTO setting (key, value) VALUES ('review_next_actions_merged', ?)",
        (date_cls.today().isoformat(),))
    conn.commit()


def get_flows(date=None):
    conn = get_conn()
    apply_due_flow_pendings(conn)
    flows = [dict(r) for r in conn.execute('SELECT * FROM flow ORDER BY position, id').fetchall()]
    # Every step is returned whatever the date — the editor has to show the
    # whole routine to edit it. `due` is the annotation the RUNNER filters on,
    # so the weekday convention is decided in exactly one place.
    day = date_cls.fromisoformat(date) if date else None
    for f in flows:
        f['period'] = f.get('period') or 'day'
        f['period_key'] = flow_period_key(f['period'], day) if day else None
        f['steps'] = [dict(r) for r in conn.execute(
            'SELECT * FROM flow_step WHERE flow_id = ? ORDER BY position, id',
            (f['id'],)).fetchall()]
        # Served, not carried: pendings live in easing_pending now, and the
        # client reads the same list shape it always did (stepPendings).
        f['pending'] = _pendings_for(conn, 'flow', f['id']) or None
        for s_ in f['steps']:
            s_['pending'] = _pendings_for(conn, 'flow_step', s_['id']) or None
        for s in f['steps']:
            # A weekly routine's steps are due for the WHOLE period: asking
            # which weekday a review step falls on would be asking the wrong
            # question, so the weekday grammar is simply not consulted.
            s['due'] = True if f['period'] == 'week' else (step_due_on(s, day) if day else True)
            # Pawned today. `due` is NOT cleared: the step still belongs to this
            # routine and still runs today — it is being done somewhere else, and
            # that is a fact about the DAY, not an edit to the routine.
            if date and s.get('pawned_date') == date:
                s['pawned_out'] = True
        if date:
            # TWO SHAPES, ONE FETCH (2026-08-16). `steps` is the ROUTINE — its
            # own steps, in its own order, the thing the editor edits and the
            # thing that is true every day. `day_steps` is TODAY'S RUN, which is
            # a different question: it drops what was pawned away, adds what was
            # pawned in, and is what the runner and completion are measured
            # against.
            #
            # They used to be one list: get_flows spliced the carried steps into
            # `steps` and cleared `due` on the pawned-out ones, so the routine
            # EDITOR showed a step that belongs to another routine, numbered it,
            # and offered ↑↓ that would have reordered around it. A pawn is
            # local to one day; the routine list is global; a local act may not
            # rewrite a global surface.
            #
            # Composed HERE and nowhere else — the client reads the field rather
            # than re-deriving the rule, which is what keeps the two from
            # drifting the way they did.
            #
            # Carried steps are PREPENDED (2026-08-15): a pawned step is debt
            # carried over, so it is the first thing you do, not the last — the
            # receiving gate is already shorter for it, and leaving it at the end
            # puts the borrowed time against the deadline. Within the group they
            # keep their own order (steps_pawned_into sorts by position).
            carried = []
            for s in steps_pawned_into(f['id'], date):
                s['due'] = True
                s['pawned_in'] = True
                s['from_flow_id'] = s['flow_id']
                carried.append(s)
            # A 'header' is a LABEL, not a step. It is dropped here — the one
            # place day_steps is composed — so it can never be run, credited,
            # or measured against. That is the money rule, not a cosmetic one:
            # day_steps is what put_flow_run re-checks and what qr_judge asks
            # about, so a header that survived into it would be an uncreditable
            # hard step holding a gated routine open forever and charging for a
            # day that was never missed.
            f['day_steps'] = carried + [s for s in f['steps']
                                        if s['due'] and not s.get('pawned_out')
                                        and s['kind'] != 'header']
            run = conn.execute('SELECT * FROM flow_run WHERE flow_id = ? AND date = ?',
                               (f['id'], f['period_key'])).fetchone()
            f['run'] = dict(run) if run else None
    conn.close()
    # THE DEADLINE IS SERVED, never re-derived by the client (2026-08-17).
    # Same answer qr_judge charges against, from the same function — a local
    # import, the direction qr_gate_day_windows already uses.
    if date:
        import qr_judge
        resolve, _ = schedule_resolver()
        for f in flows:
            if f.get('source_uid') or f.get('qr_node_id') or f.get('before_node_id'):
                try:
                    f['window_open_min'], f['due_min'] = qr_judge.flow_day_window(
                        f, date, resolve)
                except Exception:
                    f['window_open_min'], f['due_min'] = None, None
            else:
                f['window_open_min'], f['due_min'] = None, None
    return flows


# ── Pawning a step onto a later routine (2026-08-11) ─────────
#
# A step marked pawnable can be pushed from the routine you are running NOW onto
# a later one, for ONE DAY. The time it takes goes with it: the receiving routine
# has more to do inside the same window, so the gate that routine gates gets
# SHORTER by those minutes — its deadline comes earlier. Shortening demands more,
# so it applies at once, unlike every easing (which waits 24h).
#
# The split matters. `pawn_to_flow_id` + `pawn_minutes` are the step's SETTING:
# where it may go and what carrying it costs. `pawned_date` is per-day state, the
# same idiom `routine_item.done_date` uses. That is what keeps a pawn a local
# change to one day rather than an edit to the routine.
#
# The gate shortening is COMPUTED, never written as a qr_override: an override row
# would collide with the day-level overrides the timeline pill writes, and taking
# the step back would then have to remember which part of the window was its own
# doing. Deriving it means un-pawning restores the gate by itself.

def pawned_minutes_for_node(node_id, ymd):
    """Minutes pawned INTO whatever routine this gate gates, on this date."""
    if not node_id:
        return 0
    conn = get_conn()
    row = conn.execute(
        'SELECT COALESCE(SUM(s.pawn_minutes), 0) AS m'
        '  FROM flow_step s JOIN flow f ON f.id = s.pawn_to_flow_id'
        ' WHERE s.pawned_date = ? AND f.qr_node_id = ?',
        (ymd, node_id)).fetchone()
    conn.close()
    return int(row['m'] or 0)


def steps_pawned_into(flow_id, ymd):
    """The steps sitting in this routine today because they were pawned here."""
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM flow_step WHERE pawn_to_flow_id = ? AND pawned_date = ?'
        ' ORDER BY position, id', (flow_id, ymd)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def pawn_flow_step(step_id, on=True, date=None):
    """Push a step onto its destination for one day, or take it back.

    Refuses unless the step HAS a destination — pawning is a per-step setting, so
    a step with nowhere to go cannot be pawned by any route, including this one.
    """
    ymd = date or date_cls.today().isoformat()
    conn = get_conn()
    row = conn.execute('SELECT * FROM flow_step WHERE id = ?', (step_id,)).fetchone()
    if row is None:
        conn.close()
        return None
    if on and not row['pawn_to_flow_id']:
        conn.close()
        raise ValueError('this step has no routine to be pawned onto')
    conn.execute('UPDATE flow_step SET pawned_date = ? WHERE id = ?',
                 (ymd if on else None, step_id))
    conn.commit()
    out = conn.execute('SELECT * FROM flow_step WHERE id = ?', (step_id,)).fetchone()
    conn.close()
    return dict(out)


def create_flow(name, period='day'):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM flow').fetchone()
    cur = conn.execute('INSERT INTO flow (name, position, period) VALUES (?, ?, ?)',
                       (name, row['p'], period or 'day'))
    out = conn.execute('SELECT * FROM flow WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    d = dict(out)
    d['steps'] = []
    return d


def update_flow(id, name=None, qr_node_id=_UNSET, offset_min=_UNSET, before_node_id=_UNSET,
                source_uid=_UNSET, as_task=_UNSET, days_of_week=_UNSET, area_id=_UNSET):
    conn = get_conn()
    # BEING A TASK is not an easing and has no money in it: it only decides
    # whether the routine also shows up in the pool. Applies at once, and
    # switching it off retires the action that is already sitting there — a
    # task whose rule you just removed is not something you still owe.
    if as_task is not _UNSET:
        conn.execute('UPDATE flow SET as_task = ? WHERE id = ?', (1 if as_task else 0, id))
        if not as_task:
            for r in conn.execute(
                    "SELECT id FROM inbox_item WHERE flow_id = ? AND status = 'active'",
                    (id,)).fetchall():
                conn.execute('DELETE FROM engage_placement WHERE item_id = ?', (r['id'],))
                conn.execute('DELETE FROM inbox_item WHERE id = ?', (r['id'],))
        # The seeding ledger goes too, either way: switching it back on is a
        # fresh intent, and it should ask again today rather than stay silent
        # because a period it no longer remembers was already served.
        conn.execute('DELETE FROM flow_task_seed WHERE flow_id = ?', (id,))
    if days_of_week is not _UNSET:
        conn.execute('UPDATE flow SET days_of_week = ? WHERE id = ?',
                     (_norm_days(days_of_week), id))
    if area_id is not _UNSET:
        conn.execute('UPDATE flow SET area_id = ? WHERE id = ?', (area_id or None, id))
    if source_uid is not _UNSET:
        # Its own window applies at once. The 24h easing gate guards the GATE's
        # hours (the money window); a routine's deadline is the reference you
        # work to, and the gate still judges on completion at scan time.
        conn.execute('UPDATE flow SET source_uid = ? WHERE id = ?', (source_uid or None, id))
    cur = conn.execute('SELECT qr_node_id, offset_min, period FROM flow WHERE id = ?',
                       (id,)).fetchone()
    apply_at = (datetime.now() + timedelta(hours=24)).isoformat()
    if name is not None:
        conn.execute('UPDATE flow SET name = ? WHERE id = ?', (name, id))
    # A GATE JUDGES A DAY, so only a daily routine can gate one. Letting a weekly
    # routine take the link would have the judge look for a run filed under the
    # day while the routine files it under the week — a permanent "not done" on a
    # path that charges real money. Refused at the storage layer, not the UI.
    if qr_node_id not in (_UNSET, None) and cur and (cur['period'] or 'day') != 'day':
        conn.close()
        raise ValueError('a weekly routine cannot gate a QR — gates judge one day')
    if qr_node_id is not _UNSET:
        # UNLINKING a gated routine is the largest easing there is — the gate
        # stops judging on it entirely — so it waits 24h. Linking (or moving
        # the link) tightens and applies now, clearing any pending easing.
        if cur and cur['qr_node_id'] and not qr_node_id:
            _pend(conn, 'flow', id, 'qr_node_id', None)
        else:
            conn.execute('UPDATE flow SET qr_node_id = ? WHERE id = ?', (qr_node_id, id))
            _unpend(conn, 'flow', id, 'qr_node_id')
    if offset_min is not _UNSET:
        # A LATER offset moves the shown deadline later: easing, 24h. Earlier
        # (or clearing) applies now.
        new_off = offset_min if offset_min is not None else 0
        old_off = (cur['offset_min'] or 0) if cur else 0
        if cur and cur['qr_node_id'] and new_off > old_off:
            _pend(conn, 'flow', id, 'offset_min', offset_min)
        else:
            conn.execute('UPDATE flow SET offset_min = ? WHERE id = ?', (offset_min, id))
            _unpend(conn, 'flow', id, 'offset_min')
    if before_node_id is not _UNSET:
        conn.execute('UPDATE flow SET before_node_id = ? WHERE id = ?', (before_node_id, id))
    conn.commit()
    row = conn.execute('SELECT * FROM flow WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def _delete_flow_rows(conn, id):
    # Everything the flow seeded goes with it. flow_task_seed is a LEDGER, not
    # a lookup — left behind, it would keep a deleted routine's action from
    # ever being re-seeded correctly; and a step pawning INTO this flow would
    # point at nothing.
    conn.execute('DELETE FROM flow_step WHERE flow_id = ?', (id,))
    conn.execute('DELETE FROM flow_run WHERE flow_id = ?', (id,))
    conn.execute('DELETE FROM flow_task_seed WHERE flow_id = ?', (id,))
    conn.execute('''UPDATE flow_step SET pawn_to_flow_id = NULL, pawned_date = NULL
                    WHERE pawn_to_flow_id = ?''', (id,))
    conn.execute('DELETE FROM flow WHERE id = ?', (id,))


# Deleting a GATED routine releases the gate entirely, which is the largest
# easing there is — larger than the unlink that update_flow already delays 24h.
# This door had no check at all: '×' at 20:55 and a 21:00 deadline is never
# judged. It now queues like every other easing. Returns the apply_at when it
# was deferred, None when it deleted.
def delete_flow(id):
    conn = get_conn()
    row = conn.execute('SELECT qr_node_id FROM flow WHERE id = ?', (id,)).fetchone()
    if row and row['qr_node_id']:
        apply_at = (datetime.now() + timedelta(hours=24)).isoformat()
        _pend(conn, 'flow', id, 'delete', None)
        conn.commit()
        conn.close()
        return apply_at
    _delete_flow_rows(conn, id)
    conn.commit()
    conn.close()
    return None


def create_flow_step(flow_id, content, kind='text', requirement='hard', days_of_week=None,
                     duration_min=None):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM flow_step WHERE flow_id = ?',
                       (flow_id,)).fetchone()
    try:
        mins = int(duration_min)
    except (TypeError, ValueError):
        mins = None
    cur = conn.execute(
        '''INSERT INTO flow_step (flow_id, content, kind, requirement, position, days_of_week,
                                  duration_min)
           VALUES (?, ?, ?, ?, ?, ?, ?)''',
        (flow_id, content, kind, requirement, row['p'], days_of_week or None,
         mins if mins and mins > 0 else None))
    out = conn.execute('SELECT * FROM flow_step WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    return dict(out)


# ── The 24h easing gate for routines (2026-08-11) ─────────────
#
# A gate-linked routine is a money-backed commitment, so EVERY easing waits
# 24h, the same rule the gates themselves follow: step hard→soft, removing a
# run-day, deleting a step, unlinking the flow from its gate, pushing the
# offset later. One pending change per row (`pending` JSON: field, value,
# apply_at), applied on read through apply_due_flow_pendings — the editor,
# the runner and the judge all read via get_flows/routine_gate_for_node, so
# on-read is the choke point and no scheduler exists to miss.
# Tightening the same field applies immediately AND cancels the pending: the
# way back is always instant.
# PENDINGS ARE PER FIELD. This column held ONE {field, value, apply_at}, so
# queueing a second easing silently deleted the first: queue an unlink, queue
# an offset 20h later, and the unlink evaporates — while the UI had already
# said when it would land. Stored as a LIST now; the old one-slot shape still
# reads, so nothing needs converting.
# MIGRATION ONLY. The one-slot/list blob that flow.pending and
# flow_step.pending used to hold; _migrate_easing_pendings reads it once and
# empties the columns. Nothing writes this shape any more.
def _pendings(raw):
    if not raw:
        return []
    try:
        p = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if isinstance(p, dict) and p.get('field'):
        return [p]
    if isinstance(p, list):
        return [x for x in p if isinstance(x, dict) and x.get('field')]
    return []


# ── The one easing store ─────────────────────────────────────
#
# Every queued easing goes through these, whatever it is easing. The PRIMARY
# KEY (kind, row_id, field) is what makes "per field" structural rather than a
# convention someone has to remember — the one-slot blob it replaced deleted
# whatever was already queued.
def _pending_value(raw):
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw            # a pre-migration raw string


def _pend_row(conn, kind, row_id, field, value, apply_at=None):
    apply_at = apply_at or (datetime.now() + timedelta(hours=24)).isoformat()
    conn.execute(
        '''INSERT INTO easing_pending (kind, row_id, field, value, apply_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(kind, row_id, field) DO UPDATE
             SET value = excluded.value, apply_at = excluded.apply_at''',
        (kind, row_id, field, json.dumps(value), apply_at))


def _unpend_row(conn, kind, row_id, field):
    # Only THIS field's easing. Tightening one field must not cancel another
    # field's countdown, which a blanket `pending = NULL` did.
    conn.execute(
        'DELETE FROM easing_pending WHERE kind = ? AND row_id = ? AND field = ?',
        (kind, row_id, field))


def _pendings_for(conn, kind, row_id):
    return [{'field': r['field'], 'value': _pending_value(r['value']),
             'apply_at': r['apply_at']}
            for r in conn.execute(
                '''SELECT * FROM easing_pending WHERE kind = ? AND row_id = ?
                   ORDER BY apply_at''', (kind, row_id)).fetchall()]


def _pend(conn, table, id, field, value):
    _pend_row(conn, table, id, field, value)


def _unpend(conn, table, id, field):
    _unpend_row(conn, table, id, field)


def _pend_step(conn, id, field, value):
    _pend(conn, 'flow_step', id, field, value)


def _clear_step_pending(conn, id, field):
    _unpend(conn, 'flow_step', id, field)


def apply_due_flow_pendings(conn):
    # Each field lands on its OWN clock: the ones that have come due are
    # applied and dropped, the rest keep counting. One store, one loop —
    # a delete short-circuits the rest of that row's queue because there is
    # no longer a row to apply them to.
    now = datetime.now().isoformat()
    rows = conn.execute(
        '''SELECT * FROM easing_pending WHERE kind IN ('flow', 'flow_step')
             AND apply_at <= ? ORDER BY kind, row_id, apply_at''', (now,)).fetchall()
    gone = set()
    for r in rows:
        kind, row_id, field = r['kind'], r['row_id'], r['field']
        if (kind, row_id) in gone:
            continue
        value = _pending_value(r['value'])
        if field == 'delete':
            if kind == 'flow':
                _delete_flow_rows(conn, row_id)
            else:
                conn.execute('DELETE FROM flow_step WHERE id = ?', (row_id,))
            conn.execute('DELETE FROM easing_pending WHERE kind = ? AND row_id = ?',
                         (kind, row_id))
            gone.add((kind, row_id))
            continue
        allowed = (('qr_node_id', 'offset_min') if kind == 'flow'
                   else ('requirement', 'days_of_week'))
        if field in allowed:
            conn.execute(f'UPDATE {kind} SET {field} = ? WHERE id = ?', (value, row_id))
        _unpend_row(conn, kind, row_id, field)
    conn.commit()


def update_flow_step(id, content=None, kind=None, requirement=None, position=None,
                     days_of_week=_UNSET, rrule=_UNSET,
                     pawn_to_flow_id=_UNSET, pawn_minutes=_UNSET,
                     soft_content=_UNSET, ref_list_id=_UNSET, duration_min=_UNSET):
    conn = get_conn()
    # How long the step takes. It DESCRIBES the step, it does not demand
    # anything of it — no easing gate, so it applies at once even on a
    # gate-linked routine, and it never touches pawn_minutes (that one moves a
    # deadline on the money path).
    if duration_min is not _UNSET:
        try:
            mins = int(duration_min)
        except (TypeError, ValueError):
            mins = None
        conn.execute('UPDATE flow_step SET duration_min = ? WHERE id = ?',
                     (mins if mins and mins > 0 else None, id))
    if soft_content is not _UNSET:
        conn.execute('UPDATE flow_step SET soft_content = ? WHERE id = ?',
                     ((soft_content or '').strip() or None, id))
    if ref_list_id is not _UNSET:
        conn.execute('UPDATE flow_step SET ref_list_id = ? WHERE id = ?',
                     (ref_list_id or None, id))
    # Where this step may be pawned, and what carrying it costs the routine that
    # receives it. Clearing the destination un-pawns it too: a step that can no
    # longer be moved must not be left sitting somewhere it can't be sent.
    if pawn_to_flow_id is not _UNSET:
        conn.execute('UPDATE flow_step SET pawn_to_flow_id = ? WHERE id = ?',
                     (pawn_to_flow_id or None, id))
        if not pawn_to_flow_id:
            conn.execute('UPDATE flow_step SET pawned_date = NULL WHERE id = ?', (id,))
    if pawn_minutes is not _UNSET:
        conn.execute('UPDATE flow_step SET pawn_minutes = ? WHERE id = ?',
                     (int(pawn_minutes) if pawn_minutes else None, id))
    if rrule is not _UNSET:
        conn.execute('UPDATE flow_step SET rrule = ? WHERE id = ?', (rrule or None, id))
        # Stamp the phase the first time a rule is set, so "every 10 days"
        # counts from when you asked for it rather than from an epoch.
        if rrule:
            conn.execute('''UPDATE flow_step SET dtstart = ?
                            WHERE id = ? AND (dtstart IS NULL OR dtstart = '')''',
                         (date_cls.today().isoformat(), id))
    # _UNSET, not None: None IS a value here — it is how "every day" is stored,
    # so clearing the day picker has to be distinguishable from not touching it.
    if days_of_week is not _UNSET:
        cur = conn.execute('''SELECT s.days_of_week, f.qr_node_id
                              FROM flow_step s JOIN flow f ON s.flow_id = f.id
                              WHERE s.id = ?''', (id,)).fetchone()
        old = set(str(cur['days_of_week'] or '0123456')) if cur else set()
        new = set(str(days_of_week or '0123456'))
        # REMOVING a day is an easing (fewer nights the gate demands this), so
        # on a gated routine it waits 24h; adding days tightens and applies now.
        if cur and cur['qr_node_id'] and (old - new):
            _pend_step(conn, id, 'days_of_week', days_of_week or None)
        else:
            conn.execute('UPDATE flow_step SET days_of_week = ? WHERE id = ?',
                         (days_of_week or None, id))
            _clear_step_pending(conn, id, 'days_of_week')
    if content is not None:
        conn.execute('UPDATE flow_step SET content = ? WHERE id = ?', (content, id))
    if kind is not None:
        conn.execute('UPDATE flow_step SET kind = ? WHERE id = ?', (kind, id))
    if requirement is not None:
        # On a GATE-LINKED routine, hard→soft is an EASING of a money-backed
        # commitment, so it waits 24h like every other easing (the gates'
        # rule). Tightening — or any change on an ungated routine — applies at
        # once, and always clears a pending easing of the same field: asking
        # for hard again IS the cancel.
        cur = conn.execute('''SELECT s.requirement, f.qr_node_id
                              FROM flow_step s JOIN flow f ON s.flow_id = f.id
                              WHERE s.id = ?''', (id,)).fetchone()
        if (cur and cur['qr_node_id'] and requirement == 'soft'
                and cur['requirement'] == 'hard'):
            _pend_step(conn, id, 'requirement', 'soft')
        else:
            conn.execute('UPDATE flow_step SET requirement = ? WHERE id = ?',
                         (requirement, id))
            _clear_step_pending(conn, id, 'requirement')
    if position is not None:
        conn.execute('UPDATE flow_step SET position = ? WHERE id = ?', (position, id))
    conn.commit()
    row = conn.execute('SELECT * FROM flow_step WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_flow_step(id):
    # Deleting a step from a GATED routine eases what the gate demands, so it
    # waits 24h like every other easing (pending 'delete'; the row stays,
    # badged, and deleting again within the window is a no-op re-stamp).
    # Ungated routines delete at once. Returns {'pending': True} when deferred
    # so the client can register the CANCEL as the undo instead of a re-create.
    conn = get_conn()
    row = conn.execute('''SELECT f.qr_node_id FROM flow_step s
                          JOIN flow f ON s.flow_id = f.id
                          WHERE s.id = ?''', (id,)).fetchone()
    if row and row['qr_node_id']:
        _pend_step(conn, id, 'delete', None)
        conn.commit()
        conn.close()
        return {'pending': True}
    conn.execute('DELETE FROM flow_step WHERE id = ?', (id,))
    conn.commit()
    conn.close()
    return {'pending': False}


def cancel_flow_step_pending(id):
    conn = get_conn()
    conn.execute("DELETE FROM easing_pending WHERE kind = 'flow_step' AND row_id = ?",
                 (id,))
    conn.commit()
    row = conn.execute('SELECT * FROM flow_step WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# Cancelling a queued easing is TIGHTENING — keeping the commitment — so it
# applies at once, exactly like /activate calling off a queued gate deletion.
def cancel_flow_pending(id, field=None):
    conn = get_conn()
    if field:
        _unpend_row(conn, 'flow', id, field)
    else:
        conn.execute("DELETE FROM easing_pending WHERE kind = 'flow' AND row_id = ?",
                     (id,))
    conn.commit()
    row = conn.execute('SELECT * FROM flow WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def gating_flow_for_node(node_id, date):
    # The routine that GATES this node, with that date's run stamped onto it
    # (`completed_at`, NULL when unfinished) — or None when nothing gates it,
    # which is the common case.
    #
    # `qr_node_id` is the GATING link; `before_node_id` is only a deadline
    # reference, so matching on it here would make a gate judge on a routine it
    # has no relationship to.
    conn = get_conn()
    # The judge reads through here, not get_flows — a due easing (an unlink,
    # a softened step) must reach judgment without waiting for a UI read.
    apply_due_flow_pendings(conn)
    # Daily routines only. A weekly one files its run under the week (see
    # flow_period_key), so joining it on the day would read as never-done and
    # charge for a routine that was in fact complete. update_flow refuses the
    # link in the first place; this is the second lock on the money path.
    row = conn.execute(
        '''SELECT f.*, r.completed_at FROM flow f
           LEFT JOIN flow_run r ON r.flow_id = f.id AND r.date = ?
           WHERE f.qr_node_id = ? AND COALESCE(f.period, 'day') = 'day'
           ORDER BY f.position, f.id LIMIT 1''',
        (date, node_id)).fetchone()
    conn.close()
    return dict(row) if row else None


def routine_gate_for_node(node_id, date):
    # Does a routine gate this node on this date, and was it done AT ALL?
    # None when nothing gates it, else True/False. The judge asks the sharper
    # question — done by WHEN — through gating_flow_for_node.
    flow = gating_flow_for_node(node_id, date)
    if flow is None:
        return None
    return bool(flow['completed_at'])


# COMPLETION IS VERIFIED SERVER-SIDE (2026-08-17). The route used to store
# whatever `completed` it was sent, and the only enforcement of a hard metrics
# step was a DISABLED BUTTON driven by a boolean the client cached when the
# runner opened. So a stale tab — one whose cache predates a metric another
# session added or un-paused, a second device, anything replaying the PUT —
# completed a gated run with metrics unanswered, and the gate judged the day
# satisfied. A gate behind a hard metrics step is supposed to ask whether you
# ANSWERED; a client-computed boolean is a hint, never the authority.
#
# Checks TODAY'S RUN (day_steps: due, minus pawned away, plus pawned in), not
# the routine — the same composition the runner runs against.
def run_completion_ok(flow_id, date, steps_map):
    f = next((x for x in get_flows(date) if x['id'] == flow_id), None)
    if not f:
        return False
    credited = set(str(k) for k in (steps_map or {}))
    for s in f.get('day_steps') or []:
        if str(s['id']) not in credited:
            return False
        if s.get('kind') == 'metrics' and s.get('requirement') != 'soft':
            if not metrics_step_complete(s['id'], date):
                return False
    return True


def upsert_flow_run(flow_id, date, steps, completed):
    conn = get_conn()
    done_at = datetime.now(timezone.utc).isoformat() if completed else None
    conn.execute('''INSERT INTO flow_run (flow_id, date, steps, completed_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(flow_id, date) DO UPDATE
                    SET steps = excluded.steps,
                        completed_at = COALESCE(flow_run.completed_at, excluded.completed_at)''',
                 (flow_id, date, steps, done_at))
    conn.commit()
    row = conn.execute('SELECT * FROM flow_run WHERE flow_id = ? AND date = ?',
                       (flow_id, date)).fetchone()
    conn.close()
    return dict(row)


def get_inbox_items_like(pattern, deadline):
    # The social-spec item's dedupe lookup: active auto-minted rows for a date.
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, content FROM inbox_item WHERE content LIKE ? AND deadline = ?"
        " AND status = 'active' ORDER BY id",
        (pattern, deadline)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# Each spec'd interaction is also a NEXT ACTION: it mints a pool item
# ("Social plan: …", tag 5m — the message is already drafted — due today), so
# the plan shows up where the day is worked and not only in the Social tab. One
# item PER SPEC; the set is reconciled against the day's specs on every spec
# write, so add and remove cannot drift from what is planned.
#
# RECONCILED, not rebuilt (2026-08-16). It used to delete every row and
# re-create it, which made this the only writer in the app that churns record
# ids — and an id is a promise here: undoableDelete replays the ORIGINAL id
# through /api/inbox/restore precisely because children and placements point at
# it. Rewording in place keeps the promise; only a genuine surplus is deleted.
# It lives here rather than in app.py for the same reason all the other SQL
# does: it is an inventory write, not a route.
SOCIAL_ITEM_PREFIX = 'Social plan: '


def sync_social_spec_items(date):
    existing = get_inbox_items_like(SOCIAL_ITEM_PREFIX + '%', date)
    # The pool JOINs area, so an area-less row would never show: default area.
    default = next((a for a in get_areas() if a.get('is_default') and a.get('active')), None)
    labels = []
    for spec in get_social_day(date)['specs']:
        who = spec.get('person') or ''
        opener = (spec.get('opener') or '').strip()
        labels.append((SOCIAL_ITEM_PREFIX
                       + (', '.join(x for x in [who, opener] if x) or 'run the spec'))[:120])
    for row, label in zip(existing, labels):
        if row['content'] != label:
            update_inbox_item(row['id'], content=label)
    for label in labels[len(existing):]:
        item = create_inbox_item(label, 'active',
                                 default['id'] if default else None, None, '5m')
        update_inbox_item(item['id'], deadline=date)
    for row in existing[len(labels):]:
        delete_inbox_item(row['id'])


def get_tag_locations():
    conn = get_conn()
    rows = conn.execute('SELECT tag, location_id FROM tag_location').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_tag_location(tag, location_id):
    conn = get_conn()
    conn.execute('INSERT OR REPLACE INTO tag_location (tag, location_id) VALUES (?, ?)',
                 (tag, location_id))
    conn.commit()
    conn.close()


def delete_tag_location(tag):
    conn = get_conn()
    conn.execute('DELETE FROM tag_location WHERE tag = ?', (tag,))
    conn.commit()
    conn.close()


def create_location(name, lat, lng, radius_m):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO location (name, lat, lng, radius_m) VALUES (?, ?, ?, ?)',
        (name, lat, lng, radius_m)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM location WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def update_location(id, name=None, active=None):
    # Name and state only. The COORDINATES stay immutable on purpose: they are
    # what gates and context tags were pinned against, and editing them in place
    # would silently redefine every geofence that quoted them.
    conn = get_conn()
    if name is not None:
        conn.execute('UPDATE location SET name = ? WHERE id = ?', (name, id))
    if active is not None:
        conn.execute('UPDATE location SET active = ? WHERE id = ?', (1 if active else 0, id))
    conn.commit()
    row = conn.execute('SELECT * FROM location WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def set_block_active(id, active):
    conn = get_conn()
    conn.execute('UPDATE recurring_block SET active = ? WHERE id = ?',
                 (1 if active else 0, id))
    conn.commit()
    row = _fetch_block(conn, id)
    conn.close()
    return row


def delete_location(id):
    conn = get_conn()
    conn.execute('DELETE FROM location WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def get_timeline_dismissals():
    conn = get_conn()
    rows = conn.execute(
        'SELECT type, key FROM timeline_dismissal ORDER BY created_at, rowid'
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_timeline_dismissal(type, key):
    conn = get_conn()
    conn.execute(
        'INSERT OR IGNORE INTO timeline_dismissal (type, key) VALUES (?, ?)', (type, key)
    )
    conn.commit()
    conn.close()


def remove_timeline_dismissal(type, key):
    conn = get_conn()
    conn.execute(
        'DELETE FROM timeline_dismissal WHERE type = ? AND key = ?', (type, key)
    )
    conn.commit()
    conn.close()


# --- People CRM ---
# last_contact/next_due are always computed (never stored). Cadence intervals
# in days below; cadence 'none' (or unknown) never produces a due date.

CADENCE_DAYS = {'weekly': 7, 'monthly': 30, 'quarterly': 91, 'biannual': 182}
PERSON_FIELDS = ('name', 'company', 'location', 'email', 'linkedin', 'birthday',
                 'how_we_met', 'next_action', 'notes', 'cadence',
                 'next_due_override', 'has_contact', 'archived')


def _compute_next_due(cadence, next_due_override, last_contact):
    days = CADENCE_DAYS.get(cadence)
    if not days:
        return None
    if next_due_override:
        return next_due_override
    if not last_contact:
        return None
    return (date_cls.fromisoformat(last_contact) + timedelta(days=days)).isoformat()


def _assemble_person(conn, row):
    p = dict(row)
    buckets = conn.execute(
        '''SELECT b.id, b.name, b.color FROM bucket b
           JOIN person_bucket pb ON pb.bucket_id = b.id
           WHERE pb.person_id = ? ORDER BY b.name''',
        (p['id'],)
    ).fetchall()
    p['buckets'] = [dict(b) for b in buckets]
    inter = conn.execute(
        'SELECT id, date, note, source FROM interaction WHERE person_id = ? ORDER BY date DESC, id DESC',
        (p['id'],)
    ).fetchall()
    p['interactions'] = [dict(i) for i in inter]
    last = conn.execute(
        'SELECT MAX(date) AS m FROM interaction WHERE person_id = ?', (p['id'],)
    ).fetchone()['m']
    p['last_contact'] = last
    p['next_due'] = _compute_next_due(p['cadence'], p['next_due_override'], last)
    return p


def get_people(include_archived=False):
    conn = get_conn()
    where = '' if include_archived else 'WHERE archived = 0'
    rows = conn.execute(f'SELECT * FROM person {where} ORDER BY name').fetchall()
    result = [_assemble_person(conn, r) for r in rows]
    conn.close()
    return result


def get_person(id):
    conn = get_conn()
    row = conn.execute('SELECT * FROM person WHERE id = ?', (id,)).fetchone()
    result = _assemble_person(conn, row) if row else None
    conn.close()
    return result


# The ONE definition of "same person by name" (2026-08-16). Every path that can
# mint a person from a typed name resolves through this: the add/log form, the
# API, the phone capture merge. Matching is trimmed + case-insensitive, and an
# ARCHIVED match still counts — otherwise archiving someone quietly turns the
# next mention of them into a second row, which is the duplicate this prevents.
# Archived rows sort last so a live person wins when both exist.
def find_person_by_name(name):
    if not (name or '').strip():
        return None
    conn = get_conn()
    row = conn.execute(
        '''SELECT * FROM person WHERE lower(trim(name)) = lower(trim(?))
           ORDER BY archived, id LIMIT 1''', (name,)).fetchone()
    result = _assemble_person(conn, row) if row else None
    conn.close()
    return result


def create_person(data):
    cols = [c for c in PERSON_FIELDS if c in data]
    conn = get_conn()
    placeholders = ', '.join('?' * len(cols))
    cur = conn.execute(
        f'INSERT INTO person ({", ".join(cols)}) VALUES ({placeholders})',
        [data[c] for c in cols]
    )
    pid = cur.lastrowid
    for bid in data.get('bucket_ids') or []:
        conn.execute('INSERT OR IGNORE INTO person_bucket (person_id, bucket_id) VALUES (?, ?)', (pid, bid))
    conn.commit()
    result = _assemble_person(conn, conn.execute('SELECT * FROM person WHERE id = ?', (pid,)).fetchone())
    conn.close()
    return result


def update_person(id, data):
    updates = {c: data[c] for c in PERSON_FIELDS if c in data}
    conn = get_conn()
    if updates:
        fields = ', '.join(f'{k} = ?' for k in updates)
        conn.execute(f'UPDATE person SET {fields} WHERE id = ?', list(updates.values()) + [id])
    # `notes_append` is deliberately a different key from `notes`. The
    # add-interaction form only ever ADDS to what's already there, so it must not
    # carry a whole copy of the notes and write them back — that would clobber
    # anything edited in the detail panel since the form opened. Concatenating in
    # SQL means the append can't lose a word it never read.
    append = (data.get('notes_append') or '').strip()
    if append:
        conn.execute(
            '''UPDATE person
               SET notes = CASE WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
                                ELSE notes || char(10) || ? END
               WHERE id = ?''',
            (append, append, id))
    if 'bucket_ids' in data:
        conn.execute('DELETE FROM person_bucket WHERE person_id = ?', (id,))
        for bid in data.get('bucket_ids') or []:
            conn.execute('INSERT OR IGNORE INTO person_bucket (person_id, bucket_id) VALUES (?, ?)', (id, bid))
    conn.commit()
    result = _assemble_person(conn, conn.execute('SELECT * FROM person WHERE id = ?', (id,)).fetchone())
    conn.close()
    return result


def delete_person(id):
    conn = get_conn()
    conn.execute('DELETE FROM interaction WHERE person_id = ?', (id,))
    conn.execute('DELETE FROM person_bucket WHERE person_id = ?', (id,))
    conn.execute('DELETE FROM person WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def add_interaction(person_id, data):
    conn = get_conn()
    cur = conn.execute(
        'INSERT INTO interaction (person_id, date, note, source) VALUES (?, ?, ?, ?)',
        (person_id, data['date'], data.get('note', ''), data.get('source', 'desktop'))
    )
    iid = cur.lastrowid
    conn.execute('UPDATE person SET next_due_override = NULL WHERE id = ?', (person_id,))
    conn.commit()
    row = conn.execute('SELECT id, date, note, source FROM interaction WHERE id = ?', (iid,)).fetchone()
    conn.close()
    return dict(row)


# --- Social gamification (points for social interactions) ---

# (label, category, value, effort, structural, initiation, once_per_day).
# points are computed. once_per_day marks a daily habit rather than a countable
# interaction: it scores at most once per date no matter how often it is tapped.
SOCIAL_ACTIONS = [
    ('Responding/processing texts/comms the moment I receive them', 'responsive', 5, 2, 0, 0, 1),
    ('Meaningful reply to a post/story', 'responsive', 2, 2, 0, 0, 0),
    ("Replying to someone's story", 'responsive', 3, 2, 0, 0, 0),
    ("Replying to someone's post", 'responsive', 3, 2, 0, 0, 0),
    ('Attend an event you were invited to', 'responsive', 4, 2, 0, 0, 0),
    ('Say yes to a spontaneous invite', 'responsive', 4, 3, 0, 0, 0),
    ('"Thought of you" meme/link', 'initiating', 2, 3, 0, 1, 0),
    ('Check-in text to a friend', 'initiating', 3, 3, 0, 1, 0),
    ('Voice memo (you start it)', 'initiating', 3, 3, 0, 1, 0),
    ('Call/video you initiate', 'initiating', 3, 3, 0, 1, 0),
    ('Follow up with someone new you met', 'initiating', 4, 4, 0, 1, 0),
    ('Suggest a specific plan', 'initiating', 4, 4, 0, 1, 0),
    ('Introduce yourself to a new person', 'initiating', 4, 4, 0, 1, 0),
    ('Reschedule instead of canceling', 'initiating', 4, 4, 0, 1, 0),
    ('Ask for help or a favor', 'initiating', 4, 4, 0, 1, 0),
    ('Ask an acquaintance to hang 1:1', 'initiating', 4, 5, 0, 1, 0),
    ('Reach out to a lapsed friend', 'initiating', 5, 5, 0, 1, 0),
    ('Tell someone they matter to you', 'depth', 4, 4, 0, 1, 0),
    ('Share something genuinely vulnerable', 'depth', 5, 4, 0, 0, 0),
    ("Have the honest conversation you've avoided", 'depth', 5, 5, 0, 1, 0),
    ('Introduce two people to each other', 'structural', 4, 3, 1, 1, 0),
    ('Return to a recurring thing', 'structural', 5, 2, 1, 0, 0),
    ('Join a recurring group/class/club', 'structural', 5, 4, 1, 1, 0),
    ('Organize a group outing (one-off)', 'structural', 5, 5, 0, 1, 0),
    ('Host a small gathering (one-off)', 'structural', 5, 5, 0, 1, 0),
    ('Start/host a standing (recurring) hangout', 'structural', 5, 5, 1, 1, 0),
    # Broadcast: one-to-many, so initiation stays 0 -- that flag means you
    # reached out to a person. Effort tracks EXPOSURE, so the order is by
    # audience size: a story reaches more people than close friends does.
    ('Repost a reel to your story', 'broadcast', 2, 2, 0, 0, 0),
    ('Post on your close friends story', 'broadcast', 3, 3, 0, 0, 0),
    ('Post on your story', 'broadcast', 3, 4, 0, 0, 0),
    ('Post a feed post', 'broadcast', 5, 5, 0, 0, 0),
]


def _social_points(value, effort, structural):
    p = max(1, value * effort)
    if structural:
        p = round(p * 1.5)
    return int(p)


def _seed_social_actions(conn):
    for i, (label, cat, val, eff, struct, init, once) in enumerate(SOCIAL_ACTIONS):
        conn.execute(
            '''INSERT OR IGNORE INTO social_action
               (label, category, value, effort, structural, initiation, once_per_day,
                points, sort_order)
               VALUES (?,?,?,?,?,?,?,?,?)''',
            (label, cat, val, eff, struct, init, once,
             _social_points(val, eff, struct), i)
        )
    # Existing rows predate once_per_day, so INSERT OR IGNORE above leaves their
    # flag at the 0 default -- set it from the catalog.
    for label, _c, _v, _e, _s, _i, once in SOCIAL_ACTIONS:
        if once:
            conn.execute('UPDATE social_action SET once_per_day = 1 WHERE label = ?', (label,))


def get_social_actions(include_inactive=False):
    conn = get_conn()
    q = 'SELECT * FROM social_action'
    if not include_inactive:
        q += ' WHERE active = 1'
    q += ' ORDER BY sort_order'
    rows = conn.execute(q).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def log_social_interaction(data):
    conn = get_conn()
    action = conn.execute(
        'SELECT points, once_per_day FROM social_action WHERE id = ?', (data['action_id'],)
    ).fetchone()
    if not action:
        conn.close()
        return None
    # A once-per-day habit is idempotent: a second tap (or a duplicate phone
    # capture op) returns the existing entry instead of scoring again.
    if action['once_per_day']:
        dupe = conn.execute(
            'SELECT * FROM social_log WHERE action_id = ? AND date = ?',
            (data['action_id'], data['date'])
        ).fetchone()
        if dupe:
            conn.close()
            return dict(dupe)
    cur = conn.execute(
        '''INSERT INTO social_log (action_id, date, points, person_id, note, source)
           VALUES (?,?,?,?,?,?)''',
        (data['action_id'], data['date'], action['points'], data.get('person_id'),
         data.get('note', ''), data.get('source', 'desktop'))
    )
    lid = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM social_log WHERE id = ?', (lid,)).fetchone()
    conn.close()
    return dict(row)


def social_points_for_date(date):
    conn = get_conn()
    row = conn.execute(
        'SELECT COALESCE(SUM(points), 0) AS total FROM social_log WHERE date = ?', (date,)
    ).fetchone()
    conn.close()
    return row['total']


def get_social_log(date):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT sl.*, sa.label, sa.category FROM social_log sl
           JOIN social_action sa ON sa.id = sl.action_id
           WHERE sl.date = ? ORDER BY sl.created_at''', (date,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_social_log(id):
    conn = get_conn()
    conn.execute('DELETE FROM social_log WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def update_social_action(id, data):
    conn = get_conn()
    row = conn.execute('SELECT * FROM social_action WHERE id = ?', (id,)).fetchone()
    if not row:
        conn.close()
        return None
    a = dict(row)
    val = data.get('value', a['value'])
    eff = data.get('effort', a['effort'])
    struct = data.get('structural', a['structural'])
    active = data.get('active', a['active'])
    conn.execute(
        'UPDATE social_action SET value=?, effort=?, structural=?, active=?, points=? WHERE id=?',
        (val, eff, struct, active, _social_points(val, eff, struct), id)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM social_action WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def social_bank(floor):
    # cumulative, monotonic: sum of each day's surplus over the floor. A day
    # under the floor contributes 0 (never drains the bank).
    conn = get_conn()
    row = conn.execute(
        '''SELECT COALESCE(SUM(surplus), 0) AS bank FROM (
               SELECT MAX(0, SUM(points) - ?) AS surplus
               FROM social_log GROUP BY date
           )''', (floor,)
    ).fetchone()
    conn.close()
    return row['bank']


def social_history(since):
    conn = get_conn()
    rows = conn.execute(
        'SELECT date, SUM(points) AS total FROM social_log WHERE date >= ? GROUP BY date',
        (since,)
    ).fetchall()
    conn.close()
    return {r['date']: r['total'] for r in rows}


def get_crm_night(date):
    conn = get_conn()
    row = conn.execute(
        'SELECT date, satisfied_at, kind FROM crm_night WHERE date = ?', (date,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def skip_cycle(id):
    conn = get_conn()
    row = conn.execute('SELECT * FROM person WHERE id = ?', (id,)).fetchone()
    if not row:
        conn.close()
        return None
    p = dict(row)
    days = CADENCE_DAYS.get(p['cadence'])
    if days:
        last = conn.execute(
            'SELECT MAX(date) AS m FROM interaction WHERE person_id = ?', (id,)
        ).fetchone()['m']
        computed = _compute_next_due(p['cadence'], p['next_due_override'], last)
        today = date_cls.today().isoformat()
        base = max(computed, today) if computed else today
        new_override = (date_cls.fromisoformat(base) + timedelta(days=days)).isoformat()
        conn.execute('UPDATE person SET next_due_override = ? WHERE id = ?', (new_override, id))
        conn.commit()
    result = _assemble_person(conn, conn.execute('SELECT * FROM person WHERE id = ?', (id,)).fetchone())
    conn.close()
    return result


def get_buckets():
    conn = get_conn()
    rows = conn.execute('SELECT id, name, active, color FROM bucket ORDER BY name').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _next_bucket_color(conn):
    used = {r['color'] for r in conn.execute('SELECT color FROM bucket').fetchall() if r['color']}
    for c in BUCKET_PALETTE:
        if c not in used:
            return c
    n = conn.execute('SELECT COUNT(*) AS n FROM bucket').fetchone()['n']
    return BUCKET_PALETTE[n % len(BUCKET_PALETTE)]


def create_bucket(name):
    conn = get_conn()
    color = _next_bucket_color(conn)
    cur = conn.execute('INSERT INTO bucket (name, color) VALUES (?, ?)', (name, color))
    conn.commit()
    row = conn.execute('SELECT id, name, active, color FROM bucket WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def update_bucket(id, data):
    updates = {}
    if 'name' in data:
        updates['name'] = data['name']
    if 'active' in data:
        updates['active'] = 1 if data['active'] else 0
    if 'color' in data:
        updates['color'] = data['color']
    conn = get_conn()
    if updates:
        fields = ', '.join(f'{k} = ?' for k in updates)
        conn.execute(f'UPDATE bucket SET {fields} WHERE id = ?', list(updates.values()) + [id])
        conn.commit()
    row = conn.execute('SELECT id, name, active, color FROM bucket WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row)


def record_crm_night(date, kind):
    conn = get_conn()
    satisfied_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        '''INSERT INTO crm_night (date, satisfied_at, kind) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET satisfied_at = excluded.satisfied_at, kind = excluded.kind''',
        (date, satisfied_at, kind)
    )
    conn.commit()
    row = conn.execute('SELECT date, satisfied_at, kind FROM crm_night WHERE date = ?', (date,)).fetchone()
    conn.close()
    return dict(row)


# Merge phone-captured ops (from the Worker capture blob) into the local db.
# Phone is append-only: entry -> new interaction, new_person -> new row,
# nothing -> a satisfied crm_night. Structural edits never come from the phone.
def apply_people_capture(ops):
    for op in ops:
        kind = op.get('op')
        if kind == 'entry' and op.get('person_id') is not None:
            add_interaction(op['person_id'], {
                'date': op.get('date'), 'note': op.get('note', ''), 'source': 'phone'})
        elif kind == 'new_person' and op.get('name'):
            # The phone types a name with no id to pick from, so it cannot know
            # the person already exists — and a capture blob can be merged more
            # than once. Resolving by name makes this idempotent either way.
            if not find_person_by_name(op['name']):
                create_person(op)
        if op.get('date'):
            record_crm_night(op['date'], 'nothing' if kind == 'nothing' else 'entries')


# --- Self-monitoring: metrics asked on a routine step (2026-08-16) ---

METRIC_KINDS = ('scale', 'count', 'yesno', 'text')


def _metric_row(r):
    m = dict(r)
    m['active'] = bool(m.get('active', 1))
    return m


# A metric's days in the app's one weekday grammar. Accepts the list the picker
# sends or the string the column holds; '' and a full week both become NULL,
# which is what "no opinion about the calendar" is stored as everywhere else
# (step_due_on reads NULL as every day).
def _norm_days(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple, set)):
        v = ''.join(sorted(str(int(d)) for d in v))
    v = ''.join(sorted(set(ch for ch in str(v) if ch in '0123456')))
    # Every day and no opinion are the same statement, so they get the same
    # storage. Two spellings of one meaning is how a predicate starts
    # disagreeing with the row that renders it.
    return None if v in ('', '0123456') else v


def get_metrics(include_paused=True):
    conn = get_conn()
    where = '' if include_paused else 'WHERE active = 1'
    rows = conn.execute(f'SELECT * FROM metric {where} ORDER BY position, id').fetchall()
    out = [_metric_row(r) for r in rows]
    # Which steps ask it, so the settings row can say where it is asked without
    # a second request. NAMED, not just counted: "asked on 2 steps" tells you
    # nothing you can act on, and the whole point of the join is that the
    # morning step and the night step are different questions about one day.
    for m in out:
        rows2 = conn.execute(
            '''SELECT ms.step_id, s.content, f.name AS flow_name
               FROM metric_step ms
               JOIN flow_step s ON s.id = ms.step_id
               JOIN flow f ON f.id = s.flow_id
               WHERE ms.metric_id = ? ORDER BY f.position, f.id, s.position, s.id''',
            (m['id'],)).fetchall()
        m['steps'] = [dict(r) for r in rows2]
        m['step_ids'] = [r['step_id'] for r in rows2]
    conn.close()
    return out


def create_metric(data):
    kind = data.get('kind') if data.get('kind') in METRIC_KINDS else 'scale'
    conn = get_conn()
    pos = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM metric').fetchone()['p']
    cur = conn.execute(
        '''INSERT INTO metric (name, kind, prompt, scale_min, scale_max, unit, position,
                               days_of_week)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        ((data.get('name') or '').strip(), kind, (data.get('prompt') or '').strip(),
         int(data.get('scale_min') or 1), int(data.get('scale_max') or 7),
         (data.get('unit') or '').strip(), pos, _norm_days(data.get('days_of_week'))))
    mid = cur.lastrowid
    conn.commit()
    conn.close()
    if 'step_ids' in data:
        set_metric_steps(mid, data.get('step_ids') or [])
    return get_metric(mid)


def get_metric(id):
    conn = get_conn()
    row = conn.execute('SELECT * FROM metric WHERE id = ?', (id,)).fetchone()
    out = _metric_row(row) if row else None
    if out:
        out['step_ids'] = [x['step_id'] for x in conn.execute(
            'SELECT step_id FROM metric_step WHERE metric_id = ? ORDER BY step_id',
            (id,)).fetchall()]
    conn.close()
    return out


def update_metric(id, data):
    fields = {}
    for c in ('name', 'prompt', 'unit'):
        if c in data:
            fields[c] = (data[c] or '').strip()
    if data.get('kind') in METRIC_KINDS:
        fields['kind'] = data['kind']
    for c in ('scale_min', 'scale_max', 'position'):
        if c in data and data[c] is not None:
            fields[c] = int(data[c])
    if 'days_of_week' in data:
        fields['days_of_week'] = _norm_days(data['days_of_week'])
    # PAUSING never deletes and never touches entries already recorded: a paused
    # metric stops being ASKED and stops being offered, and its history stands.
    if 'active' in data:
        fields['active'] = 1 if data['active'] else 0
    conn = get_conn()
    if fields:
        sets = ', '.join(f'{k} = ?' for k in fields)
        conn.execute(f'UPDATE metric SET {sets} WHERE id = ?', list(fields.values()) + [id])
        conn.commit()
    conn.close()
    if 'step_ids' in data:
        set_metric_steps(id, data.get('step_ids') or [])
    return get_metric(id)


def set_metric_steps(metric_id, step_ids):
    conn = get_conn()
    conn.execute('DELETE FROM metric_step WHERE metric_id = ?', (metric_id,))
    for sid in step_ids or []:
        conn.execute('INSERT OR IGNORE INTO metric_step (metric_id, step_id) VALUES (?, ?)',
                     (metric_id, int(sid)))
    conn.commit()
    conn.close()


# Deleting the QUESTION deletes its answers with it: a metric_entry whose metric
# is gone is an unreadable number, not history — nothing can say what it meant.
# Pausing is the verb that keeps the history.
def delete_metric(id):
    conn = get_conn()
    conn.execute('DELETE FROM metric_entry WHERE metric_id = ?', (id,))
    conn.execute('DELETE FROM metric_step WHERE metric_id = ?', (id,))
    conn.execute('DELETE FROM metric WHERE id = ?', (id,))
    conn.commit()
    conn.close()


# What a step asks, with the answers it already has for that date. PAUSED
# metrics are not asked — but an answer already recorded for the day still
# comes back, so pausing mid-day never blanks something you already said.
def metrics_for_step(step_id, ymd):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT m.* FROM metric m
           JOIN metric_step ms ON ms.metric_id = m.id
           WHERE ms.step_id = ? AND m.active = 1
           ORDER BY m.position, m.id''', (step_id,)).fetchall()
    day = date_cls.fromisoformat(ymd)
    out = []
    for r in rows:
        m = _metric_row(r)
        e = conn.execute(
            'SELECT * FROM metric_entry WHERE date = ? AND metric_id = ? AND step_id = ?',
            (ymd, m['id'], step_id)).fetchone()
        m['entry'] = dict(e) if e else None
        # NOT DUE TODAY drops out — but an answer already recorded still comes
        # back, exactly as it does for a paused metric: narrowing the days
        # mid-day must never blank something you already said.
        if not step_due_on(m, day) and not m['entry']:
            continue
        out.append(m)
    conn.close()
    return out


# The active metrics BOUND to a step, whatever day it is. Only the completeness
# rule needs this — see the note there.
# Counts BINDINGS, not active metrics — deliberately unfiltered. Its one job is
# to tell "nothing was ever bound here" (a mistake) from "bound, but nothing to
# ask today" (fine). Pausing is the second: the Settings hint promises pause
# keeps the history and stops the asking, so pausing the last active metric on
# a hard step must degrade to nothing-due, not to unsatisfiable-forever. With
# the active filter here it read as never-bound, the step could never be
# credited, and a gate behind it charged every night.
def metrics_linked_to_step(step_id):
    conn = get_conn()
    n = conn.execute(
        'SELECT COUNT(*) n FROM metric_step WHERE step_id = ?',
        (step_id,)).fetchone()['n']
    conn.close()
    return n


# One answer. Upsert on (date, metric, step) — the step is in the key because a
# metric may be asked morning AND night, and those are two different answers
# about the same day. Passing None CLEARS it: no row means no data, which is
# not the same as a zero.
def set_metric_entry(ymd, metric_id, step_id, value):
    conn = get_conn()
    row = conn.execute('SELECT kind FROM metric WHERE id = ?', (metric_id,)).fetchone()
    kind = row['kind'] if row else 'scale'
    if value is None or (isinstance(value, str) and not value.strip()):
        conn.execute('DELETE FROM metric_entry WHERE date = ? AND metric_id = ? AND step_id = ?',
                     (ymd, metric_id, step_id))
        conn.commit()
        conn.close()
        return None
    num, text = None, None
    if kind == 'text':
        text = str(value)
    elif kind == 'yesno':
        num = 1 if value in (True, 1, '1', 'yes', 'true') else 0
    else:
        try:
            num = float(value)
        except (TypeError, ValueError):
            conn.close()
            return None
    conn.execute(
        '''INSERT INTO metric_entry (date, metric_id, step_id, value_num, value_text)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(date, metric_id, step_id)
           DO UPDATE SET value_num = excluded.value_num, value_text = excluded.value_text,
                         created_at = datetime('now','localtime')''',
        (ymd, metric_id, step_id, num, text))
    conn.commit()
    out = conn.execute(
        'SELECT * FROM metric_entry WHERE date = ? AND metric_id = ? AND step_id = ?',
        (ymd, metric_id, step_id)).fetchone()
    conn.close()
    return dict(out) if out else None


# Is every metric this step asks answered for the date? A HARD metrics step is
# credited on this, exactly as a hard checklist demands every item and refuses
# to credit an empty or unlinked one. A step that asks NOTHING cannot be
# satisfied by asking nothing — same refusal.
def metrics_step_complete(step_id, ymd):
    # A step that asks NOTHING is not satisfied — that guards a hard step whose
    # metrics were never bound, which would otherwise credit itself for free.
    #
    # But "asks nothing" has two causes now, and only one of them is a mistake.
    # A step with metrics bound, none of which fall on today, has genuinely
    # nothing to ask and IS complete. Reading the empty list as unsatisfiable
    # would make a Mon-only metric on a hard daily step impossible to clear for
    # six days a week — and a hard step can gate a QR, so that is real money.
    if not metrics_linked_to_step(step_id):
        return False
    return all(m['entry'] for m in metrics_for_step(step_id, ymd))


def metric_history(metric_id, start, end):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT date, step_id, value_num, value_text FROM metric_entry
           WHERE metric_id = ? AND date >= ? AND date <= ?
           ORDER BY date, step_id''', (metric_id, start, end)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# --- Social exposure v1 (the grid, prices, spec + dose lines) ---

# The axes. A directed rep is warmth+medium+ask; a broadcast rep is
# audience+disclosure; a micro rep is one level whose rating IS its price.
# Ratings are NULL until the calibration sitting fills them (0-10 anticipatory
# pressure) — nothing prices until then.
SOCIAL_AXES = {
    'warmth': ['warm — spoke <14d ago', 'cool — 14–90d', 'cold — 90d+ / never'],
    'medium': ['text / DM', 'voice memo', 'call', 'in person'],
    'ask': ['no ask — share / thought-of-you', 'check-in / question',
            'favor / help ask', 'concrete plan proposal', '1:1 hang ask'],
    'audience': ['close friends', 'story', 'feed post', 'public / unfamiliar'],
    'disclosure': ['repost / meme', 'original opinion', 'personal / vulnerable'],
    'micro': ['say hi (acquaintance)', 'start a conversation', 'stay past role end'],
}

SOCIAL_FAMILY_AXES = {
    'directed': ['warmth', 'medium', 'ask'],
    'broadcast': ['audience', 'disclosure'],
    'micro': ['micro'],
}


def _seed_social_axes(conn):
    for axis, labels in SOCIAL_AXES.items():
        for i, label in enumerate(labels):
            conn.execute(
                'INSERT OR IGNORE INTO social_axis_level (axis, label, position) VALUES (?, ?, ?)',
                (axis, label, i))


def get_social_levels():
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM social_axis_level ORDER BY axis, position').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_social_level_rating(id, rating):
    conn = get_conn()
    conn.execute('UPDATE social_axis_level SET rating = ? WHERE id = ?', (rating, id))
    conn.commit()
    row = conn.execute('SELECT * FROM social_axis_level WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def social_price(family, levels):
    # MIRRORED client-side by socialFormPrice (app.js) for the form's live
    # preview. This is the authority: every stored price comes from here.
    # levels: {axis: level_id}. None (unpriceable) when a required axis is
    # missing or any chosen level is uncalibrated — the caller refuses the rep.
    axes = SOCIAL_FAMILY_AXES.get(family)
    if not axes:
        return None
    conn = get_conn()
    total = 0
    for axis in axes:
        lid = (levels or {}).get(axis)
        if not lid:
            conn.close()
            return None
        row = conn.execute(
            'SELECT rating FROM social_axis_level WHERE id = ? AND axis = ?',
            (lid, axis)).fetchone()
        if not row or row['rating'] is None:
            conn.close()
            return None
        total += row['rating']
    conn.close()
    return total


def get_social_anchor():
    raw = get_settings().get('social_anchor')
    try:
        anchor = json.loads(raw) if raw else None
    except ValueError:
        anchor = None
    return anchor if isinstance(anchor, dict) else None


def get_social_d():
    # D IS the anchor cell's price — never a free number (one-action-deep by
    # construction). Anchor is a directed cell.
    anchor = get_social_anchor()
    if not anchor:
        return None
    return social_price('directed', anchor)


def get_social_day(date):
    conn = get_conn()
    specs = [dict(r) for r in conn.execute(
        'SELECT * FROM social_spec WHERE date = ? ORDER BY id', (date,)).fetchall()]
    reps = [dict(r) for r in conn.execute(
        'SELECT * FROM social_rep WHERE date = ? ORDER BY id', (date,)).fetchall()]
    conn.close()
    for s in specs:
        s['levels'] = json.loads(s['levels'] or '{}')
    for r in reps:
        r['levels'] = json.loads(r['levels'] or '{}')
    d = get_social_d()
    total = sum(r['price'] for r in reps)
    spec_total = sum(s['price'] for s in specs)
    return {
        'date': date, 'd': d, 'specs': specs, 'reps': reps, 'total': total,
        'specTotal': spec_total,
        # The two lines, and they are now the SAME arithmetic (2026-08-15,
        # reversing the 2026-08-11 rule that the morning line had to be carried
        # by one rep hard enough on its own). specOk = the day's PLAN sums to D;
        # doseCleared = the day's stamped prices sum to D. A plan of three
        # medium interactions is a real plan, and refusing it pushed the day
        # into one big rep or nothing. Dryrun ✓/✗ only — no charge.
        'specOk': d is not None and spec_total >= d,
        'doseCleared': d is not None and total >= d,
    }


def add_social_spec(date, family, levels, person, opener, id=None, price=None):
    # An explicit id+price replays an undo verbatim, same pattern as
    # add_social_rep — a recalibration between delete and undo must not
    # reprice the plan.
    if price is None:
        price = social_price(family, levels)
    if price is None:
        return None
    conn = get_conn()
    cur = conn.execute('''INSERT INTO social_spec
                          (id, date, family, levels, person, opener, price)
                          VALUES (?, ?, ?, ?, ?, ?, ?)''',
                       (id, date, family, json.dumps(levels), person or '',
                        opener or '', price))
    conn.commit()
    row = conn.execute('SELECT * FROM social_spec WHERE id = ?',
                       (cur.lastrowid,)).fetchone()
    conn.close()
    out = dict(row)
    out['levels'] = json.loads(out['levels'] or '{}')
    return out


def delete_social_spec(id):
    # Returns the deleted row's date so the caller can rebuild that day's
    # pool items without a second query.
    conn = get_conn()
    row = conn.execute('SELECT date FROM social_spec WHERE id = ?', (id,)).fetchone()
    conn.execute('DELETE FROM social_spec WHERE id = ?', (id,))
    conn.commit()
    conn.close()
    return row['date'] if row else None


def add_social_rep(data):
    # Price is STAMPED at log time (you earn the cell's current price), so a
    # later recalibration never rewrites history. An explicit id+price replays
    # an undo verbatim, same pattern as restore_routine_item.
    price = data.get('price')
    if price is None:
        price = social_price(data['family'], data.get('levels'))
    if price is None:
        return None
    conn = get_conn()
    if data.get('id'):
        conn.execute('''INSERT OR REPLACE INTO social_rep
                        (id, date, family, levels, price, planned, person, pre_rating)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                     (data['id'], data['date'], data['family'],
                      json.dumps(data.get('levels') or {}), price,
                      1 if data.get('planned') else 0, data.get('person') or '',
                      data.get('pre_rating')))
        rep_id = data['id']
    else:
        cur = conn.execute('''INSERT INTO social_rep
                              (date, family, levels, price, planned, person, pre_rating)
                              VALUES (?, ?, ?, ?, ?, ?, ?)''',
                           (data['date'], data['family'],
                            json.dumps(data.get('levels') or {}), price,
                            1 if data.get('planned') else 0, data.get('person') or '',
                            data.get('pre_rating')))
        rep_id = cur.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM social_rep WHERE id = ?', (rep_id,)).fetchone()
    conn.close()
    out = dict(row)
    out['levels'] = json.loads(out['levels'] or '{}')
    return out


def delete_social_rep(id):
    conn = get_conn()
    conn.execute('DELETE FROM social_rep WHERE id = ?', (id,))
    conn.commit()
    conn.close()


# ── QR accountability ─────────────────────────────────────────────────────
#
# Was a Cloudflare Worker + D1 (2026-08-08). Moving it here collapsed ~20
# authenticated HTTP round trips into function calls: the app and the judge
# now share this database, so only the SCAN itself still needs to be a route
# (the phone hits it from anywhere, so it is the one public surface).
#
# Windows resolve the same way everywhere, and this is the ONLY place that
# rule lives now: date override > weekly window > node defaults.

def qr_get_nodes(active_only=False):
    conn = get_conn()
    q = 'SELECT * FROM qr_node'
    if active_only:
        q += ' WHERE active = 1'
    rows = conn.execute(q + ' ORDER BY id').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_get_node_by_token(token):
    conn = get_conn()
    row = conn.execute(
        'SELECT * FROM qr_node WHERE token = ? AND active = 1', (token,)).fetchone()
    conn.close()
    return dict(row) if row else None


def qr_create_node(label, token, window_start, window_end, offset_days=0,
                   lat=None, lng=None, radius=None, days='0123456', weekly=None):
    conn = get_conn()
    cur = conn.execute(
        '''INSERT INTO qr_node (label, token, window_start, window_end,
                                window_end_offset_days, geofence_lat, geofence_lng,
                                geofence_radius_m, days_of_week, weekly_windows)
           VALUES (?,?,?,?,?,?,?,?,?,?)''',
        (label, token, window_start, window_end, offset_days, lat, lng, radius,
         days, weekly))
    conn.commit()
    node_id = cur.lastrowid
    conn.close()
    return node_id


QR_NODE_FIELDS = ('label', 'window_start', 'window_end', 'window_end_offset_days',
                  'geofence_lat', 'geofence_lng', 'geofence_radius_m', 'active',
                  'days_of_week', 'weekly_windows', 'charge_cents', 'source_uid')

# The pseudo-field a queued DELETION is filed under: deliberately not a column,
# so nothing can ever UPDATE a node with it (qr_apply_due_pending_changes reads
# it before the column branch, and qr_update_node's whitelist rejects it).
QR_DELETE_FIELD = '__delete__'


def qr_update_node(node_id, fields):
    sets = [(k, v) for k, v in fields.items() if k in QR_NODE_FIELDS]
    if not sets:
        return
    conn = get_conn()
    conn.execute('UPDATE qr_node SET ' + ', '.join(k + ' = ?' for k, _ in sets) +
                 ' WHERE id = ?', [v for _, v in sets] + [node_id])
    conn.commit()
    conn.close()


def qr_delete_node(node_id):
    conn = get_conn()
    for t in ('qr_scan', 'qr_override', 'qr_charge_log'):
        conn.execute('DELETE FROM ' + t + ' WHERE node_id = ?', (node_id,))
    conn.execute("DELETE FROM easing_pending WHERE kind = 'gate' AND row_id = ?",
                 (node_id,))
    conn.execute('DELETE FROM qr_node WHERE id = ?', (node_id,))
    conn.commit()
    conn.close()


def qr_log_scan(node_id, scanned_at, lat, lng, geofence_pass, accuracy=None):
    conn = get_conn()
    conn.execute(
        '''INSERT INTO qr_scan (node_id, scanned_at, lat, lng, geofence_pass, accuracy_m)
           VALUES (?,?,?,?,?,?)''',
        (node_id, scanned_at, lat, lng, geofence_pass, accuracy))
    conn.commit()
    conn.close()


def qr_scans_in_window(node_id, open_iso, close_iso):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT * FROM qr_scan
           WHERE node_id = ? AND scanned_at >= ? AND scanned_at <= ?
           ORDER BY scanned_at DESC''', (node_id, open_iso, close_iso)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_recent_scans(limit=100):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT s.*, n.label, n.geofence_lat, n.geofence_lng, n.geofence_radius_m
           FROM qr_scan s JOIN qr_node n ON n.id = s.node_id
           ORDER BY s.scanned_at DESC LIMIT ?''', (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_node_day_state(node_id, date):
    # What actually HAPPENED at this gate on a date: the last scan, and the
    # judgment if the window has closed. The list showed configuration only,
    # which is the one thing you don't need to check — a gate you can't see
    # working is a gate you don't trust.
    conn = get_conn()
    scan = conn.execute(
        '''SELECT scanned_at, geofence_pass FROM qr_scan
           WHERE node_id = ? AND substr(scanned_at, 1, 10) = ?
           ORDER BY scanned_at DESC LIMIT 1''', (node_id, date)).fetchone()
    judged = None
    try:
        judged = conn.execute(
            '''SELECT failure_reason, charge_status, amount_cents FROM qr_charge_log
               WHERE node_id = ? AND date = ?''', (node_id, date)).fetchone()
    except sqlite3.OperationalError:
        pass                              # pre-charge-columns db
    conn.close()
    return {'scan': dict(scan) if scan else None,
            'judged': dict(judged) if judged else None}


def qr_get_override(node_id, date):
    conn = get_conn()
    row = conn.execute('SELECT * FROM qr_override WHERE node_id = ? AND date = ?',
                       (node_id, date)).fetchone()
    conn.close()
    return dict(row) if row else None


def qr_set_override(node_id, date, window_start, window_end, offset_days=0):
    conn = get_conn()
    conn.execute(
        '''INSERT INTO qr_override (node_id, date, window_start, window_end,
                                    window_end_offset_days)
           VALUES (?,?,?,?,?)
           ON CONFLICT(node_id, date) DO UPDATE SET
             window_start = excluded.window_start,
             window_end = excluded.window_end,
             window_end_offset_days = excluded.window_end_offset_days''',
        (node_id, date, window_start, window_end, offset_days))
    conn.commit()
    conn.close()


def qr_delete_override(node_id, date):
    conn = get_conn()
    conn.execute('DELETE FROM qr_override WHERE node_id = ? AND date = ?',
                 (node_id, date))
    conn.commit()
    conn.close()


# The gate half of easing_pending. The response shape is unchanged
# (node_id / field / new_value / apply_at) because the Gates panel and the
# timeline pill are built around it.
def qr_add_pending_change(node_id, field, new_value, apply_at):
    conn = get_conn()
    _pend_row(conn, 'gate', node_id, field, new_value, apply_at)
    conn.commit()
    conn.close()


def _gate_pending_shape(r):
    return {'node_id': r['row_id'], 'field': r['field'],
            'new_value': _pending_value(r['value']), 'apply_at': r['apply_at']}


def qr_get_pending_changes(node_id=None):
    conn = get_conn()
    if node_id is None:
        rows = conn.execute(
            "SELECT * FROM easing_pending WHERE kind = 'gate' ORDER BY apply_at").fetchall()
    else:
        rows = conn.execute(
            """SELECT * FROM easing_pending WHERE kind = 'gate' AND row_id = ?
               ORDER BY apply_at""", (node_id,)).fetchall()
    conn.close()
    return [_gate_pending_shape(r) for r in rows]


def qr_cancel_pending_change(node_id, field):
    conn = get_conn()
    _unpend_row(conn, 'gate', node_id, field)
    conn.commit()
    conn.close()


def qr_apply_due_pending_changes(now_iso):
    # Loosening a constraint is 24h-gated; this is where the delay elapses.
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM easing_pending WHERE kind = 'gate' AND apply_at <= ?",
        (now_iso,)).fetchall()
    applied = []
    for r in rows:
        value = _pending_value(r['value'])
        # QR_DELETE_FIELD is not a column — it is the whole gate going away, the
        # loosest change there is, so it takes the same 24h road as every other
        # easing rather than a separate one. Rows for the node are cleared here
        # rather than through qr_delete_node because that opens its own
        # connection and this one is mid-transaction.
        if r['field'] == QR_DELETE_FIELD:
            for t in ('qr_scan', 'qr_override', 'qr_charge_log'):
                conn.execute('DELETE FROM ' + t + ' WHERE node_id = ?', (r['row_id'],))
            conn.execute("DELETE FROM easing_pending WHERE kind = 'gate' AND row_id = ?",
                         (r['row_id'],))
            conn.execute('DELETE FROM qr_node WHERE id = ?', (r['row_id'],))
            applied.append(_gate_pending_shape(r))
            continue
        if r['field'] in QR_NODE_FIELDS:
            conn.execute('UPDATE qr_node SET ' + r['field'] + ' = ? WHERE id = ?',
                         (value, r['row_id']))
            applied.append(_gate_pending_shape(r))
        conn.execute(
            "DELETE FROM easing_pending WHERE kind = 'gate' AND row_id = ? AND field = ?",
            (r['row_id'], r['field']))
    conn.commit()
    conn.close()
    return applied


def qr_judgment_exists(node_id, date):
    conn = get_conn()
    row = conn.execute('SELECT 1 FROM qr_charge_log WHERE node_id = ? AND date = ?',
                       (node_id, date)).fetchone()
    conn.close()
    return row is not None


def qr_ensure_charge_columns():
    # Lazy ALTERs, same pattern as everywhere else. charge_id holds Beeminder's
    # id; charge_cents on the NODE is the per-gate stake, NULL meaning "use the
    # global default" so an unset value can never mean "free".
    conn = get_conn()
    # window_start/end/offset_days are the FREEZE (2026-08-17): the judgment
    # stamps the window it was made against, so a closed day can be read back
    # instead of re-resolved under whatever the config says later.
    for table, col, decl in (('qr_charge_log', 'charge_id', 'TEXT'),
                             ('qr_charge_log', 'window_start', 'TEXT'),
                             ('qr_charge_log', 'window_end', 'TEXT'),
                             ('qr_charge_log', 'offset_days', 'INTEGER'),
                             ('qr_node', 'charge_cents', 'INTEGER')):
        try:
            conn.execute(f'SELECT {col} FROM {table} LIMIT 1')
        except Exception:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {col} {decl}')
            conn.commit()
    conn.close()


def qr_reserve_judgment(node_id, date, failure_reason, charge_status, amount_cents=None,
                        window=None):
    # Returns True only if THIS call created the row. The insert is the
    # reservation: it happens before anything acts on the judgment, so a
    # concurrent or repeated tick backs off here instead of duplicating.
    #
    # A row NO LONGER MEANS FAILED (2026-08-17). failure_reason NULL with
    # charge_status 'ok' is a judged SUCCESS — the freeze. Everything that used
    # to read mere presence as a failure now asks for failure_reason: this
    # function's callers, qr_charges_between, qr_charge_rows_between and the
    # charge-log surface. `window` is (start, end, offset) as resolved at
    # judgment time, so the day can be read back rather than re-resolved.
    qr_ensure_charge_columns()
    ws, we, off = window or (None, None, None)
    conn = get_conn()
    cur = conn.execute(
        '''INSERT OR IGNORE INTO qr_charge_log
             (node_id, date, failure_reason, charge_status, amount_cents,
              window_start, window_end, offset_days)
           VALUES (?,?,?,?,?,?,?,?)''',
        (node_id, date, failure_reason, charge_status, amount_cents, ws, we, off))
    conn.commit()
    won = cur.rowcount > 0
    conn.close()
    return won


# The last day this gate was judged at all — success or failure. The judge
# walks back from here so a tick missed for three days still judges those days
# (bounded, and beyond the normal reach it judges without money; see judge()).
def qr_last_judged_date(node_id):
    conn = get_conn()
    row = conn.execute(
        'SELECT MAX(date) d FROM qr_charge_log WHERE node_id = ?',
        (node_id,)).fetchone()
    conn.close()
    return row['d'] if row and row['d'] else None


# ── Gate charging: the money half, ported from the Worker 2026-08-11 ─────
#
# Transcribed rather than rewritten. The Worker's rails were audited and are
# reproduced exactly; each one exists because of a specific way money left
# unexpectedly in 2026-08:
#
#   · qr_reserve_judgment is the LOCK (INSERT OR IGNORE + rowcount), so only
#     the tick that created the row may charge. It already existed.
#   · the row is written BEFORE the API call, as 'charging'.
#   · a lost response is 'unknown': terminal, never retried, and COUNTED
#     against the cap. Retrying a charge that actually went through is how you
#     get billed repeatedly.
#   · the cap counts succeeded + charging + unknown — every state where money
#     might have left, not just confirmed ones.
#   · a charge that would breach the cap is skipped WHOLE, never partially.

def qr_settle_charge(node_id, date, charge_status, charge_id, amount_cents):
    conn = get_conn()
    conn.execute(
        '''UPDATE qr_charge_log
           SET charge_status = ?, charge_id = ?, amount_cents = ?
           WHERE node_id = ? AND date = ?''',
        (charge_status, charge_id, amount_cents, node_id, date))
    conn.commit()
    conn.close()


def qr_weekly_spent_cents(through_date):
    # A rolling 7 local days ending on through_date.
    since = (date_cls.fromisoformat(through_date) - timedelta(days=6)).isoformat()
    conn = get_conn()
    rows = conn.execute(
        '''SELECT amount_cents FROM qr_charge_log
           WHERE date >= ? AND date <= ?
             AND charge_status IN ('succeeded', 'charging', 'unknown')''',
        (since, through_date)).fetchall()
    conn.close()
    return sum(int(r['amount_cents'] or 0) for r in rows)


def qr_charge_rows_between(from_date, to_date):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT node_id, date, failure_reason, charge_status, amount_cents, charge_id
           FROM qr_charge_log WHERE date >= ? AND date <= ?
             AND failure_reason IS NOT NULL
           ORDER BY date DESC, node_id''',
        (from_date, to_date)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_get_charge_log(limit=200):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT c.*, n.label FROM qr_charge_log c
           JOIN qr_node n ON n.id = c.node_id
           WHERE c.failure_reason IS NOT NULL
           ORDER BY c.date DESC, c.id DESC LIMIT ?''', (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_charges_between(from_date, to_date):
    # FAILURES only — success rows live in the same table now.
    conn = get_conn()
    rows = conn.execute(
        '''SELECT node_id, date FROM qr_charge_log
           WHERE date >= ? AND date <= ? AND failure_reason IS NOT NULL''',
        (from_date, to_date)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# Every judgment in the range, success included — what outcomes() reads a
# CLOSED day back from instead of re-deriving it under today's configuration.
def qr_judgments_between(from_date, to_date):
    qr_ensure_charge_columns()
    conn = get_conn()
    rows = conn.execute(
        '''SELECT node_id, date, failure_reason, charge_status
           FROM qr_charge_log WHERE date >= ? AND date <= ?''',
        (from_date, to_date)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_overrides_between(from_date, to_date):
    conn = get_conn()
    rows = conn.execute(
        'SELECT * FROM qr_override WHERE date >= ? AND date <= ?',
        (from_date, to_date)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_scans_between(from_iso, to_iso):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT node_id, scanned_at, geofence_pass FROM qr_scan
           WHERE scanned_at >= ? AND scanned_at <= ?''', (from_iso, to_iso)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Context bindings: what a tag is gated by ─────────────────
#
# Three axes, one shape each: tag → location (geofence), tag → device
# (hardware), tag → schedule source (a named period). All three GATE THE POOL
# only, and all three are evaluated CLIENT-SIDE — the server just stores the
# binding, because "am I there / on that / in that window right now" is a
# question only the device can answer.

# ── The schedule store ───────────────────────────────────────
#
# One table, three constructors, and the reach every row states in Settings →
# Times. All SQL for schedules lives here; the semantics (what a source yields)
# live in schedule.py, which is pure and takes `resolve` as an argument — that
# split is what keeps a recursive model out of the database layer.

_SOURCE_COLS = ('uid', 'kind', 'title', 'start', 'duration', 'recurrence_rules',
                'overrides', 'entries', 'follows', 'ends', 'used_at', 'created_at')


def _row_to_source(row):
    """DB row → the JSCalendar-shaped dict schedule.py reads."""
    if row is None:
        return None
    r = dict(row)
    src = {
        '@type': 'Group' if r['kind'] == 'schedule' else 'Event',
        'uid': r['uid'],
        'sf:kind': r['kind'],
        'title': r['title'],
        'start': r['start'],
        'timeZone': None,               # floating, always — see schedule.py
        'duration': r['duration'],
        'recurrenceRules': json.loads(r['recurrence_rules'] or 'null') or [],
        'recurrenceOverrides': json.loads(r['overrides'] or 'null') or {},
        'entries': json.loads(r['entries'] or 'null') or [],
        'sf:follows': json.loads(r['follows'] or 'null'),
        'sf:ends': json.loads(r['ends'] or 'null'),
        'used_at': r['used_at'],
    }
    return src


def _all_sources(conn):
    rows = conn.execute('SELECT * FROM schedule_source').fetchall()
    return {r['uid']: _row_to_source(r) for r in rows}


def get_schedule_source(uid):
    conn = get_conn()
    row = conn.execute('SELECT * FROM schedule_source WHERE uid = ?', (uid,)).fetchone()
    conn.close()
    return _row_to_source(row)


def schedule_resolver():
    """A `resolve` for schedule.py backed by one read of the table. Callers
    that expand more than one source should reuse it rather than paying a query
    per member."""
    conn = get_conn()
    store = _all_sources(conn)
    conn.close()
    return store.get, store


# What HOLDS a source. Each entry is (label, table, column) and is counted for
# the reach line in Settings → Times. Consumers gain their column as they are
# converted (blocks, gates and recurring tasks still carry their own fields
# today) — adding one here is what makes it counted, so this list is the whole
# migration checklist.
_SOURCE_HOLDERS = (
    ('tag', 'tag_time', 'source_uid'),
    ('gate', 'qr_node', 'source_uid'),
)


def _reach(store, holders_by_uid, uid):
    """Who would be affected by editing this source: the schedules it is a
    member of, the derived sources following it, and every consumer holding it.
    Unused says so plainly rather than hiding, which is how the list stays
    cleanable."""
    in_schedules = [s for s in store.values()
                    if s['sf:kind'] == 'schedule' and uid in (s['entries'] or [])]
    followed_by = [s for s in store.values()
                   if (s.get('sf:follows') or {}).get('source') == uid]
    holders = holders_by_uid.get(uid, [])
    return {
        'in_schedules': [{'uid': s['uid'], 'title': s['title']} for s in in_schedules],
        'followed_by': [{'uid': s['uid'], 'title': s['title']} for s in followed_by],
        'holders': holders,
        'total': len(in_schedules) + len(followed_by) + len(holders),
    }


def _holders_by_uid(conn):
    out = {}
    for label, table, column in _SOURCE_HOLDERS:
        try:
            rows = conn.execute(f'SELECT * FROM {table}').fetchall()
        except sqlite3.OperationalError:
            continue
        for r in rows:
            uid = r[column]
            if not uid:
                continue
            name = r['tag'] if 'tag' in r.keys() else (
                r['label'] if 'label' in r.keys() else r['name'] if 'name' in r.keys() else '')
            out.setdefault(uid, []).append({'kind': label, 'name': name})
    return out


def get_schedule_sources(date=None, include_unnamed=False):
    """Every named source, newest-used first within its kind, each with the
    sentence that describes it, its reach, and — when a date is given — the
    wall-clock intervals it covers that day. The intervals are the half a phone
    can answer for itself, which is why the client is never handed a rule."""
    conn = get_conn()
    store = _all_sources(conn)
    holders = _holders_by_uid(conn)
    conn.close()
    resolve = store.get
    day = date_cls.fromisoformat(date) if date else None

    out = []
    for src in store.values():
        if not include_unnamed and not src['title']:
            continue
        row = {
            'uid': src['uid'],
            'kind': src['sf:kind'],
            'title': src['title'],
            'start': src['start'],
            'duration': src['duration'],
            'recurrenceRules': src['recurrenceRules'],
            'entries': src['entries'],
            'follows': src['sf:follows'],
            'ends': src['sf:ends'],
            'overrides': src['recurrenceOverrides'],
            'used_at': src['used_at'],
            'reach': _reach(store, holders, src['uid']),
        }
        try:
            row['label'] = schedule.describe(src, resolve)
            row['intervals'] = schedule.day_intervals(src, resolve, day) if day else []
        except schedule.Cycle:
            # A cycle can only arrive from hand-edited data — save refuses it —
            # but a list that dies is worse than a row that admits it.
            row['label'] = 'broken: this schedule refers to itself'
            row['intervals'] = []
        row['due'] = bool(row['intervals']) if day else None
        out.append(row)
    out.sort(key=lambda r: (r['kind'] != 'schedule', r['used_at'] or ''), reverse=False)
    out.sort(key=lambda r: r['used_at'] or '', reverse=True)
    out.sort(key=lambda r: r['kind'] != 'schedule')
    return out


def create_schedule_source(kind, **fields):
    if kind not in schedule.KINDS:
        raise ValueError('kind must be rule, schedule or derived')
    uid = _new_uid(kind)
    conn = get_conn()
    conn.execute(
        'INSERT INTO schedule_source (uid, kind, title, start, duration,'
        ' recurrence_rules, overrides, entries, follows, ends) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (uid, kind, fields.get('title') or None, fields.get('start') or None,
         fields.get('duration') or None,
         _dump(fields.get('recurrenceRules')), _dump(fields.get('overrides')),
         _dump(fields.get('entries')), _dump(fields.get('follows')),
         _dump(fields.get('ends'))))
    conn.commit()
    conn.close()
    _check_acyclic_or_raise(uid)
    return get_schedule_source(uid)


_SOURCE_WRITABLE = {
    'title': 'title', 'start': 'start', 'duration': 'duration',
    'recurrenceRules': 'recurrence_rules', 'overrides': 'overrides',
    'entries': 'entries', 'follows': 'follows', 'ends': 'ends',
}
_SOURCE_JSON = {'recurrenceRules', 'overrides', 'entries', 'follows', 'ends'}


def update_schedule_source(uid, **fields):
    conn = get_conn()
    for key, column in _SOURCE_WRITABLE.items():
        if key not in fields:
            continue
        value = _dump(fields[key]) if key in _SOURCE_JSON else (fields[key] or None)
        conn.execute(f'UPDATE schedule_source SET {column} = ? WHERE uid = ?', (value, uid))
    if 'kind' in fields and fields['kind'] in schedule.KINDS:
        # The picker's two branches change what a source IS — adding a
        # variation makes a rule into a schedule, choosing a target makes it
        # derived — so kind is writable, and both directions are reversible.
        conn.execute('UPDATE schedule_source SET kind = ? WHERE uid = ?',
                     (fields['kind'], uid))
    conn.execute("UPDATE schedule_source SET used_at = datetime('now','localtime') WHERE uid = ?", (uid,))
    conn.commit()
    conn.close()
    _check_acyclic_or_raise(uid)
    return get_schedule_source(uid)


def touch_schedule_source(uid):
    """Most-recently-used ordering in Times, which is the only ordering five to
    fifteen entries need."""
    conn = get_conn()
    conn.execute("UPDATE schedule_source SET used_at = datetime('now','localtime') WHERE uid = ?", (uid,))
    conn.commit()
    conn.close()


def _check_acyclic_or_raise(uid):
    resolve, store = schedule_resolver()
    src = store.get(uid)
    if src:
        schedule.check_acyclic(uid, src, resolve)


def _dump(value):
    if value is None:
        return None
    return json.dumps(value)


def delete_schedule_source(uid):
    """Deleting a NAME never takes anyone's hours away: every holder keeps an
    unnamed copy of what it had, so deletion is only ever un-sharing. That is
    what makes deleting always allowed — the panel never has to refuse.

    A schedule's members are left in Times; they are sources in their own right
    and deleting them is a separate decision.
    """
    conn = get_conn()
    row = conn.execute('SELECT * FROM schedule_source WHERE uid = ?', (uid,)).fetchone()
    if row is None:
        conn.close()
        return
    store = _all_sources(conn)
    holders = _holders_by_uid(conn)
    reach = _reach(store, holders, uid)

    # One unnamed copy per holder, so they stop changing together rather than
    # stop happening. Members of a copied schedule are shared by the copies —
    # only the NAME was private to this row.
    copies = {}

    def private_copy():
        new_uid = _new_uid(row['kind'])
        conn.execute(
            'INSERT INTO schedule_source (uid, kind, title, start, duration,'
            ' recurrence_rules, overrides, entries, follows, ends)'
            ' SELECT ?, kind, NULL, start, duration, recurrence_rules, overrides,'
            ' entries, follows, ends FROM schedule_source WHERE uid = ?',
            (new_uid, uid))
        return new_uid

    for label, table, column in _SOURCE_HOLDERS:
        try:
            rows = conn.execute(
                f'SELECT rowid FROM {table} WHERE {column} = ?', (uid,)).fetchall()
        except sqlite3.OperationalError:
            continue
        for r in rows:
            copies[(table, r['rowid'])] = private_copy()
            conn.execute(f'UPDATE {table} SET {column} = ? WHERE rowid = ?',
                         (copies[(table, r['rowid'])], r['rowid']))

    # A schedule that held this source keeps the hours too: its entry is
    # swapped for that schedule's own copy.
    for s in reach['in_schedules']:
        entries = [private_copy() if e == uid else e
                   for e in (store[s['uid']]['entries'] or [])]
        conn.execute('UPDATE schedule_source SET entries = ? WHERE uid = ?',
                     (json.dumps(entries), s['uid']))
    # A derived source that followed it keeps following the same hours.
    for s in reach['followed_by']:
        follows = dict(store[s['uid']]['sf:follows'] or {})
        follows['source'] = private_copy()
        conn.execute('UPDATE schedule_source SET follows = ? WHERE uid = ?',
                     (json.dumps(follows), s['uid']))

    conn.execute('DELETE FROM schedule_source WHERE uid = ?', (uid,))
    conn.commit()
    conn.close()


def get_tag_times():
    conn = get_conn()
    rows = conn.execute('SELECT tag, source_uid FROM tag_time').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_tag_time(tag, source_uid):
    conn = get_conn()
    conn.execute('INSERT OR REPLACE INTO tag_time (tag, source_uid) VALUES (?, ?)',
                 (tag, source_uid))
    conn.commit()
    conn.close()
    touch_schedule_source(source_uid)


def delete_tag_time(tag):
    conn = get_conn()
    conn.execute('DELETE FROM tag_time WHERE tag = ?', (tag,))
    conn.commit()
    conn.close()


def get_tag_daily():
    conn = get_conn()
    rows = [r['tag'] for r in conn.execute('SELECT tag FROM tag_daily ORDER BY tag').fetchall()]
    conn.close()
    return rows


def set_tag_daily(tag, on):
    conn = get_conn()
    if on:
        conn.execute('INSERT OR IGNORE INTO tag_daily (tag) VALUES (?)', (tag,))
    else:
        # Unbinding drops the answers too: a tag nobody asks about must not keep
        # hiding work from rows written when it was still asked.
        conn.execute('DELETE FROM tag_daily WHERE tag = ?', (tag,))
        conn.execute('DELETE FROM tag_day WHERE tag = ?', (tag,))
    conn.commit()
    conn.close()


def get_tag_day(date):
    # {tag: True/False} for the tags answered on this date. Absent = unanswered.
    conn = get_conn()
    rows = conn.execute('SELECT tag, applies FROM tag_day WHERE date = ?', (date,)).fetchall()
    conn.close()
    return {r['tag']: bool(r['applies']) for r in rows}


def set_tag_day(tag, date, applies):
    conn = get_conn()
    if applies is None:
        conn.execute('DELETE FROM tag_day WHERE tag = ? AND date = ?', (tag, date))
    else:
        conn.execute('''INSERT INTO tag_day (tag, date, applies) VALUES (?,?,?)
                        ON CONFLICT(tag, date) DO UPDATE SET applies = excluded.applies''',
                     (tag, date, 1 if applies else 0))
    conn.commit()
    conn.close()
    return get_tag_day(date)


def get_tag_devices():
    conn = get_conn()
    rows = conn.execute('SELECT tag, device FROM tag_device').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_tag_device(tag, device):
    conn = get_conn()
    conn.execute('INSERT OR REPLACE INTO tag_device (tag, device) VALUES (?, ?)',
                 (tag, device))
    conn.commit()
    conn.close()


def delete_tag_device(tag):
    conn = get_conn()
    conn.execute('DELETE FROM tag_device WHERE tag = ?', (tag,))
    conn.commit()
    conn.close()
