CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  window_start TEXT NOT NULL,           -- 'HH:MM' local
  window_end TEXT NOT NULL,
  window_end_offset_days INTEGER DEFAULT 0,  -- 1 = window closes next calendar day
  geofence_lat REAL,                    -- null = no geofence check
  geofence_lng REAL,
  geofence_radius_m INTEGER,
  requires_todo INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  days_of_week TEXT NOT NULL DEFAULT '0123456',  -- digits present = applied days, 0=Mon..6=Sun
  weekly_windows TEXT,                  -- JSON {dow: {window_start, window_end, window_end_offset_days}}, dow '0'=Mon..'6'=Sun; missing day = node defaults
  todo_grace_minutes INTEGER NOT NULL DEFAULT 0  -- requires_todo nodes: minutes after window close to still submit the to-do before judging
);

CREATE TABLE scan_events (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  scanned_at TEXT NOT NULL,
  lat REAL,
  lng REAL,
  geofence_pass INTEGER
);

CREATE TABLE todo_events (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  date TEXT NOT NULL,                   -- 'YYYY-MM-DD' local, the window's date
  submitted_at TEXT NOT NULL,
  UNIQUE(node_id, date)
);

CREATE TABLE node_overrides (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  date TEXT NOT NULL,                   -- 'YYYY-MM-DD' local
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  window_end_offset_days INTEGER DEFAULT 0,
  UNIQUE(node_id, date)
);

CREATE TABLE pending_changes (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  field TEXT NOT NULL,
  new_value TEXT NOT NULL,
  apply_at TEXT NOT NULL               -- ISO timestamp; applied by scheduled handler
);

CREATE TABLE charge_log (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  date TEXT NOT NULL,
  failure_reason TEXT,                  -- 'absent' | 'present_no_task'
  charge_status TEXT,                   -- 'would_fire' | 'succeeded' | 'declined' | 'failed'
  stripe_payment_intent_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(node_id, date)
);

CREATE TABLE billing_config (
  customer_id TEXT NOT NULL,
  payment_method_id TEXT NOT NULL
);

CREATE TABLE todo_page (
  date TEXT PRIMARY KEY,                -- 'YYYY-MM-DD'
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);