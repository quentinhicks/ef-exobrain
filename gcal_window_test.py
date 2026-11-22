import os
import sys
import tempfile
import datetime

# A fresh database every run, like the other suites.
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import storage          # noqa: E402
import app as A         # noqa: E402

# The Google Calendar window (app.py): which pages it may load itself, what
# Ctrl+Alt+G does to it, and that closing it only puts it away. A recording
# stub stands in for the window; the real one is a WebView2 form.

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


class FakeWindow:
    def __init__(self):
        self.log = []

    def show(self):
        self.log.append('show')

    def hide(self):
        self.log.append('hide')

    def restore(self):
        self.log.append('restore')

    def load_url(self, url):
        self.log.append('load:' + url)


class FakeNav:
    def __init__(self, uri):
        self.Uri = uri
        self.Cancel = False


storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())

# ── Which pages it loads itself ───────────────────────────
keeps = [
    'https://calendar.google.com/calendar/r',
    'https://calendar.google.com/calendar/u/0/r/week/2026/11/17',
    'https://accounts.google.com/ServiceLogin?service=cl',
    'https://accounts.youtube.com/accounts/SetSID',
    'https://www.google.com/a/princeton.edu/acs',
    'https://www.google.com/accounts/CheckCookie',
    'https://login.microsoftonline.com/common/saml2',
    'https://api-1234abcd.duosecurity.com/frame/frameless/v4/auth',
    'https://fed.princeton.edu/cas/login',
    'about:blank',
]
sends = [
    'https://www.google.com/search?q=anything',
    'https://www.google.com/url?q=https://example.com',
    'https://mail.google.com/mail/u/0/',
    'https://meet.google.com/abc-defg-hij',
    'https://docs.google.com/document/d/x',
    'https://www.youtube.com/watch?v=x',
    'https://example.com/',
    'http://calendar.google.com/calendar/r',          # not https
    'https://calendar.google.com.evil.example/',      # a lookalike host
    'https://notprinceton.edu/',
    'mailto:someone@example.com',
]
check('keeps Calendar and the sign-in pages',
      all(A._gcal_keeps(u) for u in keeps), [u for u in keeps if not A._gcal_keeps(u)])
check('sends everything else out',
      not any(A._gcal_keeps(u) for u in sends), [u for u in sends if A._gcal_keeps(u)])

opened = []
A.webbrowser.open = opened.append
nav = FakeNav('https://example.com/page')
A._gcal_navigating(None, nav)
check('a link elsewhere is cancelled and opened in the browser',
      nav.Cancel and opened == ['https://example.com/page'], (nav.Cancel, opened))
nav = FakeNav('https://calendar.google.com/calendar/r/day')
opened.clear()
A._gcal_navigating(None, nav)
check('a Calendar page loads in the window', not nav.Cancel and not opened, (nav.Cancel, opened))

# Signed out, Calendar sends the window to its product page: it goes to sign
# in instead, and nothing opens in the browser.
landing = FakeWindow()
A._gcal_window = landing
nav = FakeNav('https://workspace.google.com/intl/en-US/products/calendar/')
A._gcal_navigating(None, nav)
for _ in range(50):
    if landing.log:
        break
    A.time.sleep(0.02)
check('signed out: the product page becomes the sign-in page, in the window',
      nav.Cancel and not opened and landing.log == ['load:' + A.GCAL_SIGNIN], (landing.log, opened))
check('the sign-in page is one the window keeps', A._gcal_keeps(A.GCAL_SIGNIN))
nav = FakeNav('https://workspace.google.com/pricing')
A._gcal_navigating(None, nav)
check('the rest of workspace.google.com goes to the browser',
      nav.Cancel and opened == ['https://workspace.google.com/pricing'], opened)
opened.clear()

# ── Ctrl+Alt+G ────────────────────────────────────────────
c = A.app.test_client()
A._gcal_window = None
r = c.post('/api/panel/gcal')
check('no window (the server, or the app before launch): nothing, and says so',
      r.status_code == 200 and r.get_json() == {'shown': False}, r.get_json())
check('the button with no window says so', A.WindowApi().gcal_show() is False)

win = FakeWindow()
A._gcal_window = win
A._gcal_shown = False
front = [False]
A._gcal_in_front = lambda: front[0]
# Launch draws the day first: the window exists, blank, until its page loads
# (`_load_hidden_windows`), and until then the key and the button do nothing.
A._hidden_loaded = False
r = c.post('/api/panel/gcal')
check('before its page loads: the key does nothing',
      r.get_json() == {'shown': False} and win.log == [] and not A._gcal_shown, (r.get_json(), win.log))
check('before its page loads: the button does nothing',
      A.WindowApi().gcal_show() is False and win.log == [], win.log)
A._hidden_loaded = True

r = c.post('/api/panel/gcal')
check('hidden: the key shows it', r.get_json() == {'shown': True} and win.log == ['show'], win.log)

win.log.clear()
front[0] = False
r = c.post('/api/panel/gcal')
check('up but behind another window: the key brings it up, never hides it',
      r.get_json() == {'shown': True} and win.log == ['show'], win.log)

win.log.clear()
front[0] = True
r = c.post('/api/panel/gcal')
check('in front: the key puts it away', r.get_json() == {'shown': False} and win.log == ['hide'], win.log)

win.log.clear()
check('the Calendar page button shows it', A.WindowApi().gcal_show() is True
      and win.log == ['show'] and A._gcal_shown, win.log)

# ── Closing ───────────────────────────────────────────────
win.log.clear()
A._quitting = False
check('the close box cancels the close and hides it',
      A._gcal_closing() is False and win.log == ['hide'] and not A._gcal_shown, win.log)
win.log.clear()
A._quitting = True
check('the app quitting lets it close', A._gcal_closing() is True and win.log == [], win.log)
A._quitting = False
A._gcal_window = None

# ── It never interrupts ───────────────────────────────────
# The rest is the real WebView2's (alert pinned before pywebview rewrites it
# into a message box, the permission refused): driven in a hidden window.
class FakeNote:
    Handled = False


note = FakeNote()
A._gcal_notification(None, note)
check('a notification it sends shows nothing', note.Handled is True)
check('alert is pinned to nothing, against a later rewrite',
      "'alert'" in A.GCAL_QUIET_JS and 'set: () => {}' in A.GCAL_QUIET_JS and 'configurable: false' in A.GCAL_QUIET_JS)


# Chromium's own dialogs (2026-11-21): with the default ones off, each is
# answered here, unseen — only "leave this page?" is let go, so a reload is
# never held by a question in a hidden window. Kinds as WebView2 names them.
class FakeDialog:
    def __init__(self, kind):
        self.Kind, self.accepted = kind, False

    def Accept(self):
        self.accepted = True


try:
    import clr  # noqa: E402  (pythonnet, which pywebview brings on Windows)
    clr.AddReference(os.path.join(os.path.dirname(A.webview.__file__), 'lib', 'Microsoft.Web.WebView2.Core.dll'))
    from Microsoft.Web.WebView2.Core import CoreWebView2ScriptDialogKind as K  # noqa: E402
    kinds = {'alert': K.Alert, 'confirm': K.Confirm, 'prompt': K.Prompt, 'beforeunload': K.Beforeunload}
except Exception:
    kinds = None
if kinds:
    answered = {}
    for name, kind in kinds.items():
        d = FakeDialog(kind)
        A._gcal_dialog(None, d)
        answered[name] = d.accepted
    check('a dialog is dismissed unseen; only leaving the page is let go',
          answered == {'alert': False, 'confirm': False, 'prompt': False, 'beforeunload': True}, answered)
else:
    print('NOT RUN  dialog answers (no WebView2 assembly on this machine)')

# Calendar loads only once the window is quiet, so no page of it runs
# without the script; the window itself opens blank.
loads = []
A._gcal_window = type('W', (), {'load_url': lambda self, u: loads.append(u)})()
A._gcal_quiet.set()
A._gcal_load()
check('Calendar is loaded once the window is quiet', loads == [A.GCAL_URL], loads)
A._gcal_window = None

# ── Where the sign-in lives ───────────────────────────────
where = os.path.abspath(A._webview_storage())
repo = os.path.dirname(os.path.abspath(A.__file__))
check('the webview profile is outside the repo and the data dir',
      not where.startswith(repo) and not where.startswith(os.path.abspath(os.getcwd())), where)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
