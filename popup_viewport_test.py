"""Every popup is presented inside the viewport. Run: python popup_viewport_test.py

2026-10-12, Quentin's instruction: "popups should always be presented in the
viewport". A menu, card, read-out or tip that opens past an edge cannot be
read, and on a phone cannot be scrolled to. `fitInViewport` (common.js) is the
one placer; client_rules_test holds that nothing places a popup beside it.
This is the MEASURED half, because a rule about where a box ends up is only
true in a browser:

  the object menu and a row's menu, the calendar's block card, its hours
  panel and legend, the strip's menus, the block hover, the drag tip, the gate
  read-out at its tallest, the toast and the clarify sheet — each opened at
  the four corners and the middle of a phone, a laptop and a short window,
  and each measured against the window.

A popup that did not open FAILS: measuring nothing proves nothing.

It drives the real app (a scratch db, a real threaded server) with Playwright
from Node, the same way a UI change is verified by hand. Playwright is a tool
of the person running the suite, not a dependency of the app:

  npm i playwright            anywhere outside the repo
  set QPA_PLAYWRIGHT_DIR=<that directory>

Without Node or Playwright this suite says NOT RUN and exits 0 — the VM has
neither. NOT RUN is not a pass: nothing was measured.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import date as date_cls

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp(prefix='qpa-popups-'))
sys.path.insert(0, HERE)


def not_run(why):
    print('NOT RUN  popup_viewport_test - ' + why)
    print('         nothing was measured; see the top of this file to set it up')
    sys.exit(0)


node = shutil.which('node')
if not node:
    not_run('node is not installed')
env = dict(os.environ)
tool_dir = env.get('QPA_PLAYWRIGHT_DIR')
if tool_dir:
    env['NODE_PATH'] = os.path.join(tool_dir, 'node_modules')
if subprocess.run([node, '-e', "require('playwright')"], env=env, cwd=HERE,
                  capture_output=True).returncode:
    not_run('playwright is not installed where node can find it')

import storage          # noqa: E402

storage.init_db()
storage.set_setting('last_backup_date', date_cls.today().isoformat())

import app as app_mod    # noqa: E402
from werkzeug.serving import WSGIRequestHandler, make_server   # noqa: E402


class Quiet(WSGIRequestHandler):
    # Several thousand request lines would bury the one line that matters.
    def log(self, *args, **kwargs):
        pass


server = make_server('127.0.0.1', 0, app_mod.app, threaded=True, request_handler=Quiet)
threading.Thread(target=server.serve_forever, daemon=True).start()

run = subprocess.run([node, os.path.join(HERE, 'popup_viewport_test.js'),
                      f'http://127.0.0.1:{server.server_port}'],
                     env=env, cwd=HERE, capture_output=True, text=True, timeout=900)
server.shutdown()
out = (run.stdout or '').strip()
if run.returncode == 3:
    not_run('no Chrome or Edge for Playwright to drive')
print(out or (run.stderr or '').strip())
if run.returncode:
    print('\nA popup opened outside the window, or did not open. Place it with '
          'fitInViewport (common.js).')
sys.exit(1 if run.returncode else 0)
