import sys
import datetime
import storage
import app as A

# The NOW panel's on/off switch, and the one thing that used to defeat it.
#
# pywebview's WinForms resize() calls SetWindowPos with 0x0040 = SWP_SHOWWINDOW,
# so ANY resize is also a show. The panel deliberately keeps polling while it is
# switched off (that is what makes it current the moment it returns), and every
# content change alters its measured height — so `set_height` resurrected a
# panel that the setting, the UI and the user all agreed was off.
#
# There is no window here: a recording stub stands in for the real one, because
# what matters is exactly which calls reach it. `resize` sets visible on purpose
# — that IS the platform behaviour being guarded against.

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


class FakeWindow:
    def __init__(self):
        self.log = []
        self.visible = True

    def hide(self):
        self.visible = False
        self.log.append('hide')

    def show(self):
        self.visible = True
        self.log.append('show')

    def resize(self, w, h, *a):
        self.visible = True          # SWP_SHOWWINDOW
        self.log.append('resize(%d)' % h)


storage.init_db()
storage.set_setting('last_backup_date', datetime.date.today().isoformat())

win = FakeWindow()
A._panel_window = win
A._CLIENT_SERVER = ''
A._panel_pending_height = None
api = A.PanelApi()
api._window = win
c = A.app.test_client()

storage.set_setting('panel_hidden', '0')
win.log.clear()
api.set_height(120)
check('on: a height change resizes', win.log == ['resize(120)'], win.log)

r = c.post('/api/panel/toggle').get_json()
check('toggle reports hidden', r['hidden'] is True, r)
check('the setting persists it', storage.get_settings().get('panel_hidden') == '1')
check('the window was hidden', not win.visible)

# The panel goes on polling while it is off; its content keeps changing.
win.log.clear()
api.set_height(96)
api.set_height(150)
api.set_height(84)
check('OFF: no resize reaches the window', win.log == [], win.log)
check('OFF: the panel stays hidden', not win.visible, win.log)

c.post('/api/panel/hide')
check('OFF: the 10s hide path is a no-op', not win.visible, win.log)

win.log.clear()
r = c.post('/api/panel/toggle').get_json()
check('toggle reports shown', r['hidden'] is False, r)
check('ON: it comes back', win.visible)
check('ON: at the height measured while off', win.log == ['show', 'resize(84)'], win.log)

win.log.clear()
api.set_height(200)
check('ON: normal resizing resumes', win.log == ['resize(200)'], win.log)

# Client mode owns no db, so the in-memory mirror is the truth there.
A._CLIENT_SERVER = 'http://qpa-server:5000'
A._client_panel_hidden = True
A._panel_pending_height = None
win.log.clear()
win.visible = False
api.set_height(130)
check('client OFF: no resize', win.log == [], win.log)
check('client OFF: stays hidden', not win.visible)

A._client_panel_hidden = False
win.log.clear()
api.set_height(140)
check('client ON: resizes', win.log == ['resize(140)'], win.log)

print('\n'.join(ok + bad))
print('\n%d passed, %d failed' % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
