import sqlite3

conn = sqlite3.connect('tracker.db')

# Remove duplicate gcal_event rows, keeping the lowest id for each (uid, start)
conn.execute('''
    DELETE FROM gcal_event
    WHERE id NOT IN (
        SELECT MIN(id) FROM gcal_event GROUP BY uid, start
    )
''')

# Add unique index to prevent future duplicates
conn.execute('''
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_event_uid_start
    ON gcal_event (uid, start)
''')

try:
    conn.execute('ALTER TABLE gcal_event ADD COLUMN allday INTEGER NOT NULL DEFAULT 0')
except Exception:
    pass  # column already exists

conn.commit()
conn.close()
print('Migration complete.')
