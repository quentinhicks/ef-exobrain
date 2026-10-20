"""The Horizons' Areas and Goals are markdown. Run: python horizon_docs_test.py

They were contenteditable HTML until 2026-10-19 and are markdown documents
now (the Lists document's component). What is under test:

  * the one-time migration turns what that editor made — <h3>, <ul><li>,
    <p> / <div>, <br>, <b> / <i>, entities — into the markdown that renders
    the same, and leaves Purpose (plain text) alone;
  * it runs ONCE: a markdown document written since that holds a `<` is
    never read as HTML again.
"""
import os
import tempfile

os.chdir(tempfile.mkdtemp(prefix='qpa-horizons-'))

import storage

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(
        ('PASS' if cond else 'FAIL') + '  ' + label + (' - ' + str(extra) if extra else ''))


def setting(conn, key):
    row = conn.execute('SELECT value FROM setting WHERE key = ?', (key,)).fetchone()
    return row and row['value']


storage.init_db()
conn = storage.get_conn()
html = ('<h3>Health</h3><p>Sleep &amp; <b>run</b>, <i>daily</i></p><ul><li>8h</li><li>3x<br></li></ul>'
        '<h3>Work</h3><div>ship&nbsp;it</div><p><br></p>')
for key, value in (('horizon_areas', html), ('horizon_goals', '<p>One goal</p>'),
                   ('horizon_purpose', 'To <be> useful')):
    conn.execute('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)', (key, value))
conn.execute("DELETE FROM setting WHERE key = 'horizon_docs_markdown'")
conn.commit()
storage._horizon_docs_to_markdown(conn)

want = '### Health\nSleep & **run**, *daily*\n- 8h\n- 3x\n\n### Work\nship it'
check('areas: headings, paragraphs, bullets, bold and italic become markdown',
      setting(conn, 'horizon_areas') == want, repr(setting(conn, 'horizon_areas')))
check('goals: a paragraph is its line', setting(conn, 'horizon_goals') == 'One goal')
check('purpose is plain text and is not touched', setting(conn, 'horizon_purpose') == 'To <be> useful')
check('the run is recorded', bool(setting(conn, 'horizon_docs_markdown')))

conn.execute("UPDATE setting SET value = 'a <b> in markdown' WHERE key = 'horizon_goals'")
conn.commit()
storage._horizon_docs_to_markdown(conn)
check('never twice: markdown written since keeps its <', setting(conn, 'horizon_goals') == 'a <b> in markdown')
conn.close()

for line in ok + bad:
    print(line)
print('%d passed, %d failed' % (len(ok), len(bad)))
raise SystemExit(1 if bad else 0)
