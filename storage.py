import os
import re
import json
import sqlite3
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
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
            captured_at TEXT NOT NULL DEFAULT (datetime('now')),
            status TEXT,
            area_id INTEGER REFERENCES area(id),
            defer_until TEXT
        );

        CREATE TABLE IF NOT EXISTS review (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            date TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sheets_inbox_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sheets_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            course TEXT NOT NULL,
            due_date TEXT NOT NULL,
            due_time TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS yearly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            year             INTEGER NOT NULL UNIQUE,
            annual_theme     TEXT,
            major_goals      TEXT,
            paper_notes_path TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS quarterly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            quarter          TEXT NOT NULL UNIQUE,
            theme            TEXT,
            focuses          TEXT,
            hamming_insight  TEXT NOT NULL,
            paper_notes_path TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS weekly_review (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start_date  TEXT NOT NULL UNIQUE,
            learning_capture TEXT NOT NULL,
            next_focuses     TEXT,
            inbox_cleared_at TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS monthly_review (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            month        TEXT NOT NULL UNIQUE,
            synthesis    TEXT NOT NULL,
            next_focuses TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS monthly_experiment_verdict (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            monthly_review_id INTEGER NOT NULL REFERENCES monthly_review(id),
            experiment_id     INTEGER NOT NULL REFERENCES experiment(id),
            verdict           TEXT NOT NULL CHECK(verdict IN ('graduate','redesign','drop')),
            notes             TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS monthly_project_status (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            monthly_review_id INTEGER NOT NULL REFERENCES monthly_review(id),
            area_id        INTEGER NOT NULL REFERENCES area(id),
            status            TEXT NOT NULL CHECK(status IN ('on_track','stalled','completed')),
            notes             TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS daily_review (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            date           TEXT NOT NULL UNIQUE,
            pdsa_study     TEXT NOT NULL DEFAULT '',
            synthesis      TEXT NOT NULL DEFAULT '',
            tomorrow_focus TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS observation (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL CHECK(kind IN ('interruption','switch','note')),
            block_id    INTEGER REFERENCES recurring_block(id),
            note        TEXT NOT NULL DEFAULT '',
            captured_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS interaction (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id  INTEGER NOT NULL REFERENCES person(id),
            date       TEXT NOT NULL,
            note       TEXT NOT NULL DEFAULT '',
            source     TEXT NOT NULL DEFAULT 'desktop',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- One habit per week, set when the weekly review is filed; runs from
        -- week_start_date until the next weekly review. Rated daily via
        -- journal_day.habit_mark.
        CREATE TABLE IF NOT EXISTS habit_week (
            week_start_date TEXT PRIMARY KEY,
            habit           TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    conn.execute('''
        CREATE TABLE IF NOT EXISTS gtd_review (
            week_start_date TEXT PRIMARY KEY,
            steps           TEXT NOT NULL DEFAULT '{}',
            note            TEXT NOT NULL DEFAULT '',
            started_at      TEXT NOT NULL DEFAULT (datetime('now')),
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    # Which days a routine step runs. Same grammar the rest of the app already
    # speaks — a digit string, '0'=Mon..'6'=Sun, NULL = every day (exactly how
    # recurring_task.days_of_week and nodes.days_of_week read). NULL meaning
    # every day is what keeps every step written before this column running.
    try:
        conn.execute('SELECT days_of_week FROM flow_step LIMIT 1')
    except Exception:
        conn.execute('ALTER TABLE flow_step ADD COLUMN days_of_week TEXT')
        conn.commit()
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS social_spec (
            date       TEXT PRIMARY KEY,
            family     TEXT NOT NULL,
            levels     TEXT NOT NULL DEFAULT '{}',
            person     TEXT NOT NULL DEFAULT '',
            opener     TEXT NOT NULL DEFAULT '',
            price      INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )''')
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
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(node_id, date)
        )''')
    _seed_social_axes(conn)
    conn.commit()
    conn.close()


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


def update_domain(id, name):
    conn = get_conn()
    conn.execute('UPDATE domain SET name = ? WHERE id = ?', (name, id))
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


def get_active_items_for_area(area_id):
    # Projects are ordinary items that acquired children, so they appear in
    # this list too. Rows go out flat; the client assembles the tree from
    # project_id, since nesting can't be expressed by a flat ORDER BY.
    today = date_cls.today().isoformat()
    conn = get_conn()
    rows = conn.execute(
        '''SELECT * FROM inbox_item i
           WHERE area_id = ? AND status = 'active'
             AND (defer_until IS NULL OR defer_until <= ?)
             AND (after_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM inbox_item p WHERE p.id = i.after_id))
           ORDER BY captured_at DESC''',
        (area_id, today)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


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
        '''SELECT i.*, a.domain_id AS domain_id, a.name AS area_name
           FROM inbox_item i JOIN area a ON a.id = i.area_id
           WHERE i.status = 'active'
             AND (i.defer_until IS NULL OR i.defer_until <= ?)
             AND (i.after_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM inbox_item p WHERE p.id = i.after_id))
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
        '''SELECT i.* FROM inbox_item i JOIN area a ON a.id = i.area_id
           WHERE a.domain_id = ? AND i.status = 'active'
             AND (i.defer_until IS NULL OR i.defer_until <= ?)
             AND (i.after_id IS NULL
                  OR NOT EXISTS (SELECT 1 FROM inbox_item p WHERE p.id = i.after_id))
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


def get_gtd_lists():
    # The four GTD lists the tab renders in one payload. Predicates mirror
    # get_gtd_review_counts exactly, so the tab and the review badges can
    # never disagree about a count.
    today = date_cls.today().isoformat()
    conn = get_conn()
    waiting = [dict(r) for r in conn.execute(
        '''SELECT i.*, a.name AS area_name, p.content AS project_name
           FROM inbox_item i LEFT JOIN area a ON a.id = i.area_id
           LEFT JOIN inbox_item p ON p.id = i.project_id
           WHERE i.status = 'waiting'
           ORDER BY i.captured_at''').fetchall()]
    someday = [dict(r) for r in conn.execute(
        '''SELECT i.*, a.name AS area_name, p.content AS project_name
           FROM inbox_item i LEFT JOIN area a ON a.id = i.area_id
           LEFT JOIN inbox_item p ON p.id = i.project_id
           WHERE i.kind = 'item' AND i.status = 'on_hold'
           ORDER BY i.captured_at''').fetchall()]
    deferred = [dict(r) for r in conn.execute(
        '''SELECT i.*, a.name AS area_name, p.content AS project_name
           FROM inbox_item i LEFT JOIN area a ON a.id = i.area_id
           LEFT JOIN inbox_item p ON p.id = i.project_id
           WHERE i.kind = 'item' AND i.defer_until IS NOT NULL AND i.defer_until > ?
           ORDER BY i.defer_until, i.captured_at''', (today,)).fetchall()]
    for rows in (waiting, someday, deferred):
        _apply_inherited_deadlines(conn, rows)
    conn.close()
    return {'projects': get_all_projects(), 'waiting': waiting,
            'someday': someday, 'deferred': deferred}


# --- GTD weekly review -------------------------------------------------
# Step progress is a {stepKey: iso-timestamp} blob so steps can be added or
# reordered later without a migration. Weeks start Monday.

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


def set_gtd_review_step(week_start_date, step, done):
    conn = get_conn()
    row = conn.execute('SELECT steps FROM gtd_review WHERE week_start_date = ?',
                       (week_start_date,)).fetchone()
    steps = json.loads(row['steps'] or '{}') if row else {}
    if done:
        steps[step] = datetime.now().isoformat(timespec='seconds')
    else:
        steps.pop(step, None)
    conn.execute('UPDATE gtd_review SET steps = ? WHERE week_start_date = ?',
                 (json.dumps(steps), week_start_date))
    conn.commit()
    conn.close()
    return get_gtd_review(week_start_date)


def finish_gtd_review(week_start_date, note=''):
    conn = get_conn()
    conn.execute('''UPDATE gtd_review SET completed_at = datetime('now'), note = ?
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
        '''SELECT COUNT(*) n FROM inbox_item
           WHERE kind = 'item' AND defer_until IS NOT NULL AND defer_until > ?''',
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
    # Predicate in lockstep with get_all_projects' action_count: waiting AND
    # future-deferred children both count as live — parked-on-a-date is not
    # stalled, it just isn't startable today.
    stalled = [dict(r) for r in conn.execute(
        '''WITH RECURSIVE tree(root, id) AS (
               SELECT id, id FROM inbox_item WHERE kind = 'project'
               UNION
               SELECT t.root, i.id FROM inbox_item i JOIN tree t ON i.project_id = t.id
           )
           SELECT pr.id, pr.content, a.name AS area_name FROM inbox_item pr
           LEFT JOIN area a ON a.id = pr.area_id
           WHERE pr.kind = 'project'
             AND NOT EXISTS (SELECT 1 FROM tree t JOIN inbox_item c ON c.id = t.id
                             WHERE t.root = pr.id AND c.kind = 'item'
                               AND c.status IN ('active', 'waiting'))
           ORDER BY a.name, pr.content''').fetchall()]
    projects = conn.execute(
        "SELECT COUNT(*) n FROM inbox_item WHERE kind = 'project'").fetchone()['n']
    conn.close()
    return {'inbox': inbox, 'someday': someday, 'deferred': deferred,
            'projects': projects, 'stalled': stalled,
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


def _hhmm_to_min(t):
    h, m = t.split(':')
    return int(h) * 60 + int(m)


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

    def add_blocks(day_dow, date_str, offset):
        for b in conn.execute('SELECT * FROM recurring_block WHERE active = 1 AND day_of_week = ?',
                              (day_dow,)).fetchall():
            ov = conn.execute('SELECT * FROM block_override WHERE block_id = ? AND date = ?',
                              (b['id'], date_str)).fetchone()
            if ov and ov['cancelled'] == 1:
                continue
            start_t = ov['start_time'] if ov and ov['start_time'] else b['start_time']
            end_t = ov['end_time'] if ov and ov['end_time'] else b['end_time']
            start = _hhmm_to_min(start_t) + offset
            end = _hhmm_to_min(end_t) + (1440 if end_t < start_t else 0) + offset
            if end <= 0:
                continue
            if b['area_id'] in routine_areas:
                g = groups.get(b['area_id'])
                if g:
                    g['start'] = min(g['start'], start)
                    g['end'] = max(g['end'], end)
                else:
                    groups[b['area_id']] = {'kind': 'routine', 'area_id': b['area_id'],
                                            'label': routine_areas[b['area_id']],
                                            'start': start, 'end': end}
            else:
                rows.append({'kind': 'block', 'label': b['label'], 'start': start, 'end': end})

    add_blocks(today.weekday(), today_str, 0)
    add_blocks((today.weekday() - 1) % 7, (today - timedelta(days=1)).isoformat(), -1440)
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


def create_ref_list(name):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ref_list').fetchone()
    cur = conn.execute('INSERT INTO ref_list (name, position) VALUES (?, ?)', (name, row['p']))
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


_UNSET = object()


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
        # Filing under a project adopts that project's area, so the two can
        # never disagree. Explicit area_id in the same call still wins.
        if project_id is not None and area_id is _UNSET:
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

def _recurring_due(task, today):
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


def get_gcal_events():
    today = date_cls.today()
    window_start = (today - timedelta(days=1)).isoformat()
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
    conn = get_conn()
    try:
        conn.execute('BEGIN')
        conn.execute('DELETE FROM gcal_event WHERE source_id = ?', (source_id,))
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


# Log docs: long-term markdown files in logs/, git-tracked, edited from the
# Logs view. Names are sanitized to a safe charset; content is the raw file.

LOGS_DIR = 'logs'


def _log_name(name):
    return re.sub(r'[^A-Za-z0-9 _\-]', '', name).strip()


def list_logs():
    os.makedirs(LOGS_DIR, exist_ok=True)
    logs = []
    for f in sorted(os.listdir(LOGS_DIR)):
        if f.endswith('.md'):
            mtime = os.path.getmtime(os.path.join(LOGS_DIR, f))
            logs.append({'name': f[:-3], 'updated_at': datetime.fromtimestamp(mtime).isoformat()})
    return logs


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


def create_log(name):
    name = _log_name(name)
    path = os.path.join(LOGS_DIR, name + '.md')
    if not os.path.exists(path):
        write_log(name, '')
    return read_log(name)


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
             created_at = datetime('now')''',
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
    # 0=Mon..6=Sun, the app's one weekday convention (see _recurring_due and
    # nodes.days_of_week). Empty/NULL = every day: a step with no opinion about
    # the calendar runs, which is the only safe default for a routine that
    # gates a QR.
    dow = step.get('days_of_week')
    return not dow or str(day.weekday()) in dow


def get_flows(date=None):
    conn = get_conn()
    flows = [dict(r) for r in conn.execute('SELECT * FROM flow ORDER BY position, id').fetchall()]
    # Every step is returned whatever the date — the editor has to show the
    # whole routine to edit it. `due` is the annotation the RUNNER filters on,
    # so the weekday convention is decided in exactly one place.
    day = date_cls.fromisoformat(date) if date else None
    for f in flows:
        f['steps'] = [dict(r) for r in conn.execute(
            'SELECT * FROM flow_step WHERE flow_id = ? ORDER BY position, id',
            (f['id'],)).fetchall()]
        for s in f['steps']:
            s['due'] = step_due_on(s, day) if day else True
        if date:
            run = conn.execute('SELECT * FROM flow_run WHERE flow_id = ? AND date = ?',
                               (f['id'], date)).fetchone()
            f['run'] = dict(run) if run else None
    conn.close()
    return flows


def create_flow(name):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM flow').fetchone()
    cur = conn.execute('INSERT INTO flow (name, position) VALUES (?, ?)', (name, row['p']))
    out = conn.execute('SELECT * FROM flow WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    d = dict(out)
    d['steps'] = []
    return d


def update_flow(id, name=None, qr_node_id=_UNSET, offset_min=_UNSET, before_node_id=_UNSET):
    conn = get_conn()
    if name is not None:
        conn.execute('UPDATE flow SET name = ? WHERE id = ?', (name, id))
    if qr_node_id is not _UNSET:
        conn.execute('UPDATE flow SET qr_node_id = ? WHERE id = ?', (qr_node_id, id))
    if offset_min is not _UNSET:
        conn.execute('UPDATE flow SET offset_min = ? WHERE id = ?', (offset_min, id))
    if before_node_id is not _UNSET:
        conn.execute('UPDATE flow SET before_node_id = ? WHERE id = ?', (before_node_id, id))
    conn.commit()
    row = conn.execute('SELECT * FROM flow WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_flow(id):
    conn = get_conn()
    conn.execute('DELETE FROM flow_step WHERE flow_id = ?', (id,))
    conn.execute('DELETE FROM flow_run WHERE flow_id = ?', (id,))
    conn.execute('DELETE FROM flow WHERE id = ?', (id,))
    conn.commit()
    conn.close()


def create_flow_step(flow_id, content, kind='text', requirement='hard', days_of_week=None):
    conn = get_conn()
    row = conn.execute('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM flow_step WHERE flow_id = ?',
                       (flow_id,)).fetchone()
    cur = conn.execute(
        '''INSERT INTO flow_step (flow_id, content, kind, requirement, position, days_of_week)
           VALUES (?, ?, ?, ?, ?, ?)''',
        (flow_id, content, kind, requirement, row['p'], days_of_week or None))
    out = conn.execute('SELECT * FROM flow_step WHERE id = ?', (cur.lastrowid,)).fetchone()
    conn.commit()
    conn.close()
    return dict(out)


def update_flow_step(id, content=None, kind=None, requirement=None, position=None,
                     days_of_week=_UNSET):
    conn = get_conn()
    # _UNSET, not None: None IS a value here — it is how "every day" is stored,
    # so clearing the day picker has to be distinguishable from not touching it.
    if days_of_week is not _UNSET:
        conn.execute('UPDATE flow_step SET days_of_week = ? WHERE id = ?',
                     (days_of_week or None, id))
    if content is not None:
        conn.execute('UPDATE flow_step SET content = ? WHERE id = ?', (content, id))
    if kind is not None:
        conn.execute('UPDATE flow_step SET kind = ? WHERE id = ?', (kind, id))
    if requirement is not None:
        conn.execute('UPDATE flow_step SET requirement = ? WHERE id = ?', (requirement, id))
    if position is not None:
        conn.execute('UPDATE flow_step SET position = ? WHERE id = ?', (position, id))
    conn.commit()
    row = conn.execute('SELECT * FROM flow_step WHERE id = ?', (id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_flow_step(id):
    conn = get_conn()
    conn.execute('DELETE FROM flow_step WHERE id = ?', (id,))
    conn.commit()
    conn.close()


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
        "SELECT id FROM inbox_item WHERE content LIKE ? AND deadline = ? AND status = 'active'",
        (pattern, deadline)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


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
            create_person(op)
        if op.get('date'):
            record_crm_night(op['date'], 'nothing' if kind == 'nothing' else 'entries')


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
    spec = conn.execute('SELECT * FROM social_spec WHERE date = ?', (date,)).fetchone()
    reps = [dict(r) for r in conn.execute(
        'SELECT * FROM social_rep WHERE date = ? ORDER BY id', (date,)).fetchall()]
    conn.close()
    spec = dict(spec) if spec else None
    if spec:
        spec['levels'] = json.loads(spec['levels'] or '{}')
    for r in reps:
        r['levels'] = json.loads(r['levels'] or '{}')
    d = get_social_d()
    total = sum(r['price'] for r in reps)
    return {
        'date': date, 'd': d, 'spec': spec, 'reps': reps, 'total': total,
        # The two lines. specOk = a spec exists that arithmetically clears D;
        # doseCleared = today's prices sum to D. Dryrun ✓/✗ only — no charge.
        'specOk': bool(spec and d is not None and spec['price'] >= d),
        'doseCleared': d is not None and total >= d,
    }


def upsert_social_spec(date, family, levels, person, opener):
    price = social_price(family, levels)
    if price is None:
        return None
    conn = get_conn()
    conn.execute('''INSERT OR REPLACE INTO social_spec
                    (date, family, levels, person, opener, price)
                    VALUES (?, ?, ?, ?, ?, ?)''',
                 (date, family, json.dumps(levels), person or '', opener or '', price))
    conn.commit()
    row = conn.execute('SELECT * FROM social_spec WHERE date = ?', (date,)).fetchone()
    conn.close()
    out = dict(row)
    out['levels'] = json.loads(out['levels'] or '{}')
    return out


def delete_social_spec(date):
    conn = get_conn()
    conn.execute('DELETE FROM social_spec WHERE date = ?', (date,))
    conn.commit()
    conn.close()


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
                  'days_of_week', 'weekly_windows')


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
    for t in ('qr_scan', 'qr_override', 'qr_pending_change', 'qr_charge_log'):
        conn.execute('DELETE FROM ' + t + ' WHERE node_id = ?', (node_id,))
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


def qr_add_pending_change(node_id, field, new_value, apply_at):
    conn = get_conn()
    conn.execute(
        '''INSERT INTO qr_pending_change (node_id, field, new_value, apply_at)
           VALUES (?,?,?,?)''', (node_id, field, new_value, apply_at))
    conn.commit()
    conn.close()


def qr_get_pending_changes(node_id=None):
    conn = get_conn()
    if node_id is None:
        rows = conn.execute('SELECT * FROM qr_pending_change ORDER BY apply_at').fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM qr_pending_change WHERE node_id = ? ORDER BY apply_at',
            (node_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_cancel_pending_change(node_id, field):
    conn = get_conn()
    conn.execute('DELETE FROM qr_pending_change WHERE node_id = ? AND field = ?',
                 (node_id, field))
    conn.commit()
    conn.close()


def qr_apply_due_pending_changes(now_iso):
    # Loosening a constraint is 24h-gated; this is where the delay elapses.
    conn = get_conn()
    rows = conn.execute('SELECT * FROM qr_pending_change WHERE apply_at <= ?',
                        (now_iso,)).fetchall()
    applied = []
    for r in rows:
        if r['field'] in QR_NODE_FIELDS:
            conn.execute('UPDATE qr_node SET ' + r['field'] + ' = ? WHERE id = ?',
                         (r['new_value'], r['node_id']))
            applied.append(dict(r))
        conn.execute('DELETE FROM qr_pending_change WHERE id = ?', (r['id'],))
    conn.commit()
    conn.close()
    return applied


def qr_judgment_exists(node_id, date):
    conn = get_conn()
    row = conn.execute('SELECT 1 FROM qr_charge_log WHERE node_id = ? AND date = ?',
                       (node_id, date)).fetchone()
    conn.close()
    return row is not None


def qr_reserve_judgment(node_id, date, failure_reason, charge_status, amount_cents=None):
    # Returns True only if THIS call created the row. The insert is the
    # reservation: it happens before anything acts on the judgment, so a
    # concurrent or repeated tick backs off here instead of duplicating.
    conn = get_conn()
    cur = conn.execute(
        '''INSERT OR IGNORE INTO qr_charge_log
             (node_id, date, failure_reason, charge_status, amount_cents)
           VALUES (?,?,?,?,?)''',
        (node_id, date, failure_reason, charge_status, amount_cents))
    conn.commit()
    won = cur.rowcount > 0
    conn.close()
    return won


def qr_get_charge_log(limit=200):
    conn = get_conn()
    rows = conn.execute(
        '''SELECT c.*, n.label FROM qr_charge_log c
           JOIN qr_node n ON n.id = c.node_id
           ORDER BY c.date DESC, c.id DESC LIMIT ?''', (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def qr_charges_between(from_date, to_date):
    conn = get_conn()
    rows = conn.execute(
        'SELECT node_id, date FROM qr_charge_log WHERE date >= ? AND date <= ?',
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
