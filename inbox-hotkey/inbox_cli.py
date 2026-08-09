import sys
import os
import json
import datetime
import urllib.request
import urllib.error

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _config_path():
    # config.json lives in the DATA dir, which since 2026-08-08 sits BESIDE
    # the repo rather than inside it. Hammerspoon and AHK launch this script
    # directly, so they inherit no PT_DATA_DIR — the parent-of-repo probe is
    # what actually resolves it in the split layout, and the repo itself still
    # resolves the all-in-one one.
    for base in (os.environ.get('PT_DATA_DIR'), os.path.dirname(REPO), REPO):
        if base:
            candidate = os.path.join(base, 'config.json')
            if os.path.exists(candidate):
                return candidate
    return os.path.join(REPO, 'config.json')


BASE = REPO
CONFIG = _config_path()
TMP = (os.environ.get('TEMP') or os.environ.get('TMPDIR')
       or os.path.dirname(os.path.abspath(__file__)))
ADD_FILE = os.path.join(TMP, 'inbox_add.txt')
RESULT_FILE = os.path.join(TMP, 'inbox_result.txt')
LOCAL = 'http://localhost:5000'


def cfg():
    try:
        with open(CONFIG, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def worker():
    c = cfg()
    return c.get('qr_worker_url', ''), c.get('qr_internal_secret', '')


def _req(url, data=None, method='GET', headers=None, timeout=10):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('User-Agent', 'productivity-tracker/1.0')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def local_add(text):
    body = json.dumps({'content': text}).encode()
    _req(LOCAL + '/api/inbox', body, 'POST',
         {'Content-Type': 'application/json'}, timeout=2)


def cloud_get():
    url, secret = worker()
    if not url or not secret:
        raise RuntimeError('no worker/secret in config.json')
    b = _req(url + '/internal/inbox-content', None, 'GET',
             {'Authorization': 'Bearer ' + secret}, timeout=10)
    row = json.loads(b or b'{}')
    return row.get('content') or ''


def cloud_post(content):
    url, secret = worker()
    payload = json.dumps({
        'content': content,
        'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }).encode()
    _req(url + '/internal/inbox-content', payload, 'POST',
         {'Authorization': 'Bearer ' + secret,
          'Content-Type': 'application/json'}, timeout=10)


def cloud_add(text):
    for _ in range(2):
        cur = cloud_get()
        newc = (cur + '\n' + text) if cur else text
        try:
            cloud_post(newc)
            return
        except urllib.error.HTTPError as e:
            if e.code == 409:
                continue
            raise
    raise RuntimeError('cloud conflict, try again')


def write_result(msg):
    try:
        with open(RESULT_FILE, 'w', encoding='utf-8') as f:
            f.write(msg)
    except Exception:
        pass


def do_add():
    try:
        with open(ADD_FILE, encoding='utf-8-sig') as f:
            text = f.read().strip()
    except Exception:
        text = ''
    if not text:
        write_result('Empty - nothing added')
        return 1
    try:
        local_add(text)
        write_result('Added to inbox (app)')
        return 0
    except Exception:
        pass
    try:
        cloud_add(text)
        write_result('Added to inbox (cloud)')
        return 0
    except Exception as e:
        write_result('FAILED: ' + str(e))
        return 2


def get_items():
    try:
        b = _req(LOCAL + '/api/inbox', None, 'GET', timeout=2)
        items = json.loads(b)
        return [i.get('content', '') for i in items], 'app'
    except Exception:
        pass
    try:
        lines = [l for l in cloud_get().split('\n') if l.strip()]
        return lines, 'cloud'
    except Exception as e:
        return None, str(e)


def _cursor_xy(w, h):
    try:
        import ctypes

        class P(ctypes.Structure):
            _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
        u = ctypes.windll.user32
        pt = P()
        u.GetCursorPos(ctypes.byref(pt))
        vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)
        vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
        x = min(max(pt.x - w // 2, vx), vx + vw - w)
        y = min(max(pt.y - h // 2, vy), vy + vh - h)
        return x, y
    except Exception:
        return None


def _mtime(p):
    try:
        return os.path.getmtime(p)
    except OSError:
        return None


def do_view():
    import tkinter as tk
    import threading

    W, H = 420, 460
    root = tk.Tk()
    root.title('Inbox')
    root.configure(bg='#1a1a1a')
    root.attributes('-topmost', True)
    xy = _cursor_xy(W, H)
    root.geometry('%dx%d%s' % (
        W, H, ('+%d+%d' % xy) if xy else ''))

    hdr = tk.Label(root, text='Loading…', bg='#1a1a1a', fg='#8a8a8a',
                   font=('Segoe UI', 9), anchor='w')
    hdr.pack(fill='x', padx=14, pady=(12, 6))
    txt = tk.Text(root, bg='#141414', fg='#e6e6e6', bd=0,
                  font=('Segoe UI', 11), wrap='word',
                  padx=12, pady=10, spacing1=2, spacing3=4)
    txt.pack(fill='both', expand=True, padx=10, pady=(0, 12))
    root.after(30, lambda: root.focus_force())

    stop = {'v': False}
    view = {'sig': None, 'mtime': _mtime(RESULT_FILE),
            'fetching': False, 'result': None}

    def close(*_):
        stop['v'] = True
        root.destroy()

    def fetch():
        view['result'] = get_items()
        view['fetching'] = False

    def kick():
        if not view['fetching']:
            view['fetching'] = True
            threading.Thread(target=fetch, daemon=True).start()

    def apply(items, src):
        sig = (src, tuple(items) if items is not None else None)
        if sig == view['sig']:
            return
        view['sig'] = sig
        if items is None:
            hdr.config(text='Could not reach app or cloud')
            body = src
        else:
            hdr.config(text='%d item%s  ·  %s' % (
                len(items), '' if len(items) == 1 else 's', src))
            body = '\n'.join('•  ' + i for i in items) if items \
                else '(inbox empty)'
        txt.config(state='normal')
        txt.delete('1.0', 'end')
        txt.insert('1.0', body)
        txt.config(state='disabled')

    # Refresh only when an add actually happened: the add command rewrites
    # RESULT_FILE, so we watch its mtime (a cheap local stat) rather than
    # polling the network on a timer. No idle network traffic.
    def tick():
        if stop['v']:
            return
        if view['result'] is not None:
            data, view['result'] = view['result'], None
            apply(*data)
        m = _mtime(RESULT_FILE)
        if m != view['mtime']:
            view['mtime'] = m
            kick()
        root.after(400, tick)

    root.bind('<Escape>', close)
    root.protocol('WM_DELETE_WINDOW', close)
    kick()
    root.after(400, tick)
    root.mainloop()


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'add':
        sys.exit(do_add())
    elif cmd == 'view':
        do_view()
    else:
        print('usage: inbox_cli.py [add|view]')
        sys.exit(1)
