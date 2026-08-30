import ctypes
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import base64
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import date as date_cls, datetime, timedelta, timezone

try:
    import webview
except ImportError:
    webview = None  # headless server (PT_HEADLESS): Flask only, no windows
from flask import Flask, jsonify, redirect, render_template, request, send_from_directory

import storage
import schedule
import aggregator
import ntag
import qr_judge
import daybook
from aggregator import fetch_gcal, fetch_sheets

# THE DATA DIR. Everything the user owns — config.json, tracker.db, backups/,
# logs/ — is cwd-relative (storage.py's DB_PATH / LOGS_DIR / BACKUPS_DIR), so
# the data dir IS the working directory and PT_DATA_DIR is how you move it.
#
# It applies in every mode, not just frozen, and that is what lets the code
# live in its own repo with the data OUTSIDE it:
#
#     workspace/            <- PT_DATA_DIR: tracker.db, logs/, config.json
#     └── ef-exobrain/      <- the repo. Holds no data, so none can be committed.
#
# Unset = cwd, which is the old behaviour (run from the repo, data lands
# beside it). The frozen exe additionally needs a FALLBACK, because cwd is
# unreliable there: double-clicking, a pinned exe or a Start-menu launch all
# set cwd to the install folder, which silently forks an empty second database.
_DEFAULT_DATA_DIR = os.path.join(os.path.expanduser('~'), 'Documents', 'ef-exobrain')
# Where the CODE is, fixed before any chdir. Anything shipped with the repo
# (inbox-hotkey/) must be addressed from here; anything the user owns is
# cwd-relative and follows PT_DATA_DIR.
_REPO_DIR = os.path.dirname(os.path.abspath(__file__))
_data_dir = os.environ.get('PT_DATA_DIR')
if getattr(sys, 'frozen', False) and not (_data_dir and os.path.isdir(_data_dir)):
    _data_dir = _DEFAULT_DATA_DIR
if _data_dir:
    if not os.path.isdir(_data_dir):
        os.makedirs(_data_dir, exist_ok=True)
    os.chdir(_data_dir)
if getattr(sys, 'frozen', False):
    app = Flask(__name__,
                template_folder=os.path.join(sys._MEIPASS, 'templates'),
                static_folder=os.path.join(sys._MEIPASS, 'static'))
else:
    app = Flask(__name__)
# A PT_SERVER client owns no database — everything lives on the server.
# The timezone lever goes on HERE, immediately after the db exists and long
# before anything dates anything: the daybook/backup thread starts further
# down this file and used to run 58 lines ahead of the lever, filing today
# under the OS zone at every startup.
if not os.environ.get('PT_SERVER'):
    storage.init_db()
    storage.apply_timezone()
try:
    with open('config.json') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}


# Server-side config is WRITABLE from the app, one key at a time. It used to be
# editable only over ssh, which meant a value the settings panel is responsible
# for could only be set from a terminal — so it never got set. Written 0600 via
# a temp file + replace, so a crash mid-write can't leave a truncated config
# that takes the whole app down on the next start. Values are never read BACK
# out to a client: write-only is the property that matters for a secret, and it
# is the reading that had to stay impossible, not the writing.
def _config_file():
    # The file as it is NOW, not the module's copy: another process (or another
    # session) may have written a key since this one started, and merging into
    # a stale dict would drop it.
    try:
        with open('config.json') as f:
            return json.load(f) or {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _update_config(values):
    global config
    try:
        with open('config.json') as f:
            current = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        current = {}
    current.update(values)
    tmp = 'config.json.tmp'
    with open(tmp, 'w') as f:
        json.dump(current, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, 'config.json')
    config = current
    return current


# Where a gate's SCAN URL points. The judge and the scan server both live on
# this box now, and qr_scan_server writes the qr_scan rows qr_judge reads — so a
# link built from the old Worker host would log a scan into a database nothing
# judges. `qr_worker_url` stays as the fallback so an unmigrated config.json
# keeps rendering a link at all.
# A FUNCTION, not a constant (2026-08-16): config.json is editable from the
# app now, and a value frozen at import would mean "saved" but not "in force"
# until the next restart — the exact confusion the panel is meant to remove.
def _gate_scan_url():
    return config.get('gate_scan_url') or config.get('qr_worker_url', '')


# THE STABLE LINK, and nobody should have to type it.
#
# The address the app is REACHED at is not the one this request arrived on:
# the desktop window is 127.0.0.1 and cannot know the tailnet name, which is
# exactly the moment you want to send the link to a phone or an iPad. Three
# sources, most-authoritative first:
#
#   1. config app_url  — an explicit override, for when the other two are
#                        wrong (a custom domain, a reverse proxy).
#   2. LEARNED         — any request that actually arrived on a *.ts.net host
#                        proves that host reaches this app. Free, and correct
#                        by construction. Recorded the first time it differs.
#   3. DETECTED        — `tailscale status --json` on the box. Cached in the
#                        settings table once it answers, so the subprocess
#                        runs at most once per install rather than per read.
_TAILNET_HOST = re.compile(r'^[A-Za-z0-9._-]+\.ts\.net$')


def _app_url_ranked():
    """(url, source), best first. HTTPS beats detection beats plain http.

    A learned https URL is the `tailscale serve` address — the good one, and a
    SECURE CONTEXT, which the service worker needs. A learned http one is
    real too (the app also answers on :5000 over the tailnet) but it is the
    lesser link, so detection outranks it.
    """
    explicit = (config.get('app_url') or '').strip().rstrip('/')
    if explicit:
        return explicit, 'set in Connections'
    known = storage.get_settings()
    seen = (known.get('app_url_seen') or '').rstrip('/')
    found = (known.get('app_url_detected') or '').rstrip('/')
    if seen.startswith('https://'):
        return seen, 'seen in use'
    if found:
        return found, 'from tailscale'
    if seen:
        return seen, 'seen in use'
    return '', ''


def _app_url():
    return _app_url_ranked()[0]


def _app_url_source():
    return _app_url_ranked()[1]


@app.before_request
def _learn_app_url():
    # A request that ARRIVED here proves its host reaches this app. Only a
    # tailnet name is worth keeping — 127.0.0.1 and a bare LAN IP are not
    # links another device can use — and only when it changes, so this is a
    # read of already-cached settings on the hot path and nothing more.
    host = (request.host or '').split(':')[0]
    if not _TAILNET_HOST.match(host):
        return
    url = f'{request.scheme}://{request.host}'.rstrip('/')
    if storage.get_settings().get('app_url_seen') != url:
        storage.set_setting('app_url_seen', url)


def _detect_app_url():
    """Ask tailscale for this machine's name. Cached once it answers."""
    if storage.get_settings().get('app_url_detected'):
        return
    exe = shutil.which('tailscale')
    if not exe:
        return
    try:
        out = subprocess.run([exe, 'status', '--json'], capture_output=True,
                             text=True, timeout=5)
        name = (json.loads(out.stdout).get('Self') or {}).get('DNSName') or ''
    except Exception:
        return                      # not installed, not up, not our problem
    name = name.strip().rstrip('.')
    if _TAILNET_HOST.match(name):
        # https, because that is what `tailscale serve` publishes and what the
        # service worker needs — a secure context.
        storage.set_setting('app_url_detected', f'https://{name}')
# qr_todo_node_ids is retired: QR judgment is presence-only since the daily
# to-do list was removed (2026-08). Left unread so old config.json files with
# the key still load.

_SEED_PALETTE = [
    '#d9a3a8', '#d9b48f', '#d8cb96', '#adc9a0', '#93cbb4',
    '#8fc6cf', '#98b9dd', '#a9a9dd', '#c3a6d8', '#d5a3c8',
]


def _seed_calendars():
    if storage.get_calendar_sources():
        return
    i = 0
    for k, v in config.items():
        if k.endswith('_ical_url') and v:
            name = k[:-len('_ical_url')].replace('_', ' ').strip().title() or 'Calendar'
            storage.create_calendar_source(name, v, _SEED_PALETTE[i % len(_SEED_PALETTE)])
            i += 1


if not os.environ.get('PT_SERVER'):
    _seed_calendars()


def _parse_ts(ts):
    dt = datetime.fromisoformat(ts.replace('Z', '+00:00').replace(' ', 'T'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _touch_and_sync_inbox():
    storage.touch_inbox()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/panel')
def panel():
    return render_template('panel.html')


# Both files live in static/ but are served from the ROOT, and both have to be.
# A service worker's scope is its own path, so one served from /static/ could
# only ever control /static/* — never the app. A manifest's scope defaults to
# its directory, and start_url '/' must sit inside it.
@app.route('/sw.js')
def service_worker():
    return send_from_directory(app.static_folder, 'sw.js')


@app.route('/manifest.webmanifest')
def manifest():
    return send_from_directory(app.static_folder, 'manifest.webmanifest')


# pywebview's WebKit cache can serve stale app.js/style.css across app
# restarts, which makes fresh code invisible. no-cache forces revalidation
# (304s keep it fast locally) on the two shells and everything static.
@app.after_request
def _no_stale_static(resp):
    if (request.path in ('/', '/panel', '/sw.js', '/manifest.webmanifest')
            or request.path.startswith('/static/')):
        resp.headers['Cache-Control'] = 'no-cache'
    return resp


# Set in __main__ once the windows exist. The global hotkeys drive the panel
# through _panel_window (no focus steal), and a panel edit refreshes the main
# window through _main_window so its to-do view updates immediately.
_panel_window = None
_main_window = None


@app.route('/api/panel/switch', methods=['POST'])
def panel_switch():
    if _panel_window and not _panel_toggled_off():
        _panel_window.evaluate_js('npOpenSwitch()')
    return '', 204


@app.route('/api/panel/interrupted', methods=['POST'])
def panel_interrupted():
    if _panel_window and not _panel_toggled_off():
        _panel_window.evaluate_js('npMarkInterrupted()')
    return '', 204


# On Windows the Ctrl+Alt+M hide is a pure AHK WinHide/WinShow; on Mac there is
# no per-window hide from outside the process, so Hammerspoon posts here and
# the panel hides itself for 10 seconds instead. A toggled-off panel stays off:
# the 10s re-show must not resurrect it.
@app.route('/api/panel/hide', methods=['POST'])
def panel_hide():
    if _panel_window and not _panel_toggled_off():
        _panel_window.hide()
        threading.Timer(10, lambda: None if _panel_off() else _panel_show()).start()
    return '', 204


def _panel_toggled_off():
    return storage.get_settings().get('panel_hidden') == '1'


# Off is off, in BOTH modes: local reads the setting, client mode owns no db and
# tracks it in memory (mirrored from the server at launch and on every toggle).
def _panel_off():
    return _client_panel_hidden if _CLIENT_SERVER else _panel_toggled_off()


# A RESIZE UNHIDES THE WINDOW (2026-08-16). pywebview's WinForms resize() calls
# SetWindowPos with 0x0040 = SWP_SHOWWINDOW, so every set_height was also a
# show. The panel keeps polling while it is switched off — that is deliberate,
# it is what makes it current the moment it comes back — and any content change
# alters its measured height, so an off panel resurrected itself minutes later
# while the setting still said off and the UI still said "panel off". The
# height is remembered instead and applied when it is genuinely shown.
_panel_pending_height = None


def _panel_show():
    global _panel_pending_height
    _panel_window.show()
    if _panel_pending_height is not None:
        _panel_window.resize(320, _panel_pending_height)
        _panel_pending_height = None


# The persistent on/off switch, unlike Ctrl+Alt+M's 10-second hide. The setting
# survives restarts: __main__ creates the panel window hidden when it is set.
@app.route('/api/panel/toggle', methods=['POST'])
def panel_toggle():
    hidden = not _panel_toggled_off()
    storage.set_setting('panel_hidden', '1' if hidden else '0')
    if _panel_window:
        if hidden:
            _panel_window.hide()
        else:
            _panel_show()
    return jsonify({'hidden': hidden})


@app.route('/api/panel/saved', methods=['POST'])
def panel_saved():
    if _main_window:
        _main_window.evaluate_js('refreshTodoNow()')
    return '', 204


@app.route('/api/areas')
def get_areas():
    return jsonify(storage.get_areas())


VALID_PROJECT_TYPES = {'standard', 'review', 'sleep', 'routine'}


@app.route('/api/areas', methods=['POST'])
def post_area():
    data = request.get_json()
    type_ = data.get('type', 'standard')
    if type_ not in VALID_PROJECT_TYPES:
        return jsonify({'error': 'type must be standard, review, sleep, or routine'}), 400
    project = storage.create_area(data['name'], type_, data.get('domain_id'))
    return jsonify(project), 201


@app.route('/api/areas/<int:id>', methods=['PATCH'])
def patch_area(id):
    data = request.get_json()
    if 'type' in data:
        if data['type'] not in VALID_PROJECT_TYPES:
            return jsonify({'error': 'type must be standard, review, sleep, or routine'}), 400
        project = storage.set_project_type(id, data['type'])
    elif 'domain_id' in data:
        project = storage.set_area_domain(id, data['domain_id'])
    elif 'qr_node_id' in data:
        project = storage.set_area_qr_node(id, data['qr_node_id'])
    else:
        project = storage.set_project_active(id, data['active'])
    return jsonify(project)


@app.route('/api/domains')
def get_domains():
    return jsonify(storage.get_domains())


@app.route('/api/domains', methods=['POST'])
def post_domain():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.create_domain(name)), 201


@app.route('/api/domains/<int:id>', methods=['PATCH'])
def patch_domain(id):
    data = request.get_json() or {}
    name = None
    if 'name' in data:
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name is required'}), 400
    active = data.get('active') if 'active' in data else None
    if name is None and active is None:
        return jsonify({'error': 'name or active is required'}), 400
    return jsonify(storage.update_domain(id, name, active))


@app.route('/api/domains/<int:id>', methods=['DELETE'])
def delete_domain_route(id):
    storage.delete_domain(id)
    return '', 204


# 'waiting' is GTD's Waiting For: handed off, so not startable by you. It drops
# out of the NOW list the same way a future defer date does.
VALID_INBOX_STATUSES = {None, 'active', 'waiting', 'on_hold'}


@app.route('/api/inbox')
def get_inbox():
    return jsonify(storage.get_inbox_items())


@app.route('/api/inbox/active')
def get_inbox_active():
    domain_id = request.args.get('domain_id', type=int)
    storage.seed_recurring_tasks()
    # A routine marked "also a task" seeds its action from the same read, for
    # the same reason: the pool is what asks the question, so the pool is where
    # the answer gets made.
    storage.seed_flow_tasks()
    # No filter = every available item across domains: the Engage context
    # picker narrows client-side so switching contexts costs no round trip.
    # (?area_id was a third branch nothing has called since the pool became
    # domain-scoped, and it had quietly drifted out of lockstep — no inherited
    # deadlines. Removed 2026-08-16: a predicate nobody exercises is a predicate
    # nobody notices going wrong.)
    if domain_id:
        return jsonify(storage.get_active_items_for_domain(domain_id))
    return jsonify(storage.get_active_items_all())


@app.route('/api/recurring')
def get_recurring():
    return jsonify(storage.get_recurring_tasks())


RECURRING_KINDS = ('weekly', 'monthly_nth', 'monthly_date', 'every_n_days')

# 'MM-DD', and nothing else — the deadline rule of a recurring occurrence.
# Checked here rather than trusted, because a malformed one would resolve to no
# deadline at all and look like a feature that quietly does not work.
def _deadline_md(value):
    if value in (None, ''):
        return None, None
    m = re.fullmatch(r'(\d{1,2})-(\d{1,2})', str(value).strip())
    if not m:
        return None, 'deadline_md must be MM-DD'
    month, dom = int(m.group(1)), int(m.group(2))
    if not (1 <= month <= 12 and 1 <= dom <= 31):
        return None, 'deadline_md must be a real month and day'
    return '%02d-%02d' % (month, dom), None


@app.route('/api/recurring', methods=['POST'])
def post_recurring():
    data = request.get_json()
    if data.get('kind') not in RECURRING_KINDS:
        return jsonify({'error': 'invalid kind'}), 400
    if data.get('spawn') not in (None, 'item', 'project'):
        return jsonify({'error': 'spawn must be item or project'}), 400
    md, err = _deadline_md(data.get('deadline_md'))
    if err:
        return jsonify({'error': err}), 400
    task = storage.create_recurring_task(
        data['name'], data['area_id'], data['kind'],
        data.get('days_of_week'), data.get('nth'), data.get('weekday'),
        data.get('interval') or 1, data['anchor_date'], data.get('project_id'),
        spawn=data.get('spawn') or 'item', deadline_md=md, notes=data.get('notes')
    )
    return jsonify(task), 201


@app.route('/api/recurring/<int:id>', methods=['PATCH'])
def patch_recurring(id):
    data = request.get_json()
    kwargs = {}
    # The whole editable set, because the clarify sheet a recurring PROJECT is
    # edited in saves its wording, area, notes, deadline rule and schedule at
    # once. storage.RECURRING_FIELDS is the list; this is the validation.
    for key in ('active', 'project_id', 'name', 'area_id', 'days_of_week', 'nth',
                'weekday', 'interval', 'anchor_date', 'notes'):
        if key in data:
            kwargs[key] = data[key]
    if 'kind' in data:
        if data['kind'] not in RECURRING_KINDS:
            return jsonify({'error': 'invalid kind'}), 400
        kwargs['kind'] = data['kind']
    if 'spawn' in data:
        if data['spawn'] not in ('item', 'project'):
            return jsonify({'error': 'spawn must be item or project'}), 400
        kwargs['spawn'] = data['spawn']
    if 'deadline_md' in data:
        md, err = _deadline_md(data['deadline_md'])
        if err:
            return jsonify({'error': err}), 400
        kwargs['deadline_md'] = md
    if not kwargs:
        return jsonify({'error': 'nothing to update'}), 400
    task = storage.update_recurring_task(id, **kwargs)
    return jsonify(task)


@app.route('/api/recurring/<int:id>', methods=['DELETE'])
def delete_recurring(id):
    storage.delete_recurring_task(id)
    return '', 204


@app.route('/api/inbox', methods=['POST'])
def post_inbox():
    data = request.get_json()
    status = data.get('status')
    if status not in VALID_INBOX_STATUSES:
        return jsonify({'error': 'status must be null, active, waiting, or on_hold'}), 400
    item = storage.create_inbox_item(data['content'], status,
                                     data.get('area_id'), data.get('project_id'),
                                     data.get('tags'))
    _touch_and_sync_inbox()
    # A hotkey capture lands while the main window is open — show it (same
    # pattern as /api/panel/saved). The window's own captures re-render
    # themselves anyway; a second refresh is harmless.
    if _main_window:
        try:
            _main_window.evaluate_js('refreshTodoNow()')
        except Exception:
            pass
    return jsonify(item), 201


@app.route('/api/inbox/<int:id>', methods=['DELETE'])
def delete_inbox(id):
    storage.delete_inbox_item(id)
    _touch_and_sync_inbox()
    return '', 204


@app.route('/api/inbox/<int:id>', methods=['PATCH'])
def patch_inbox(id):
    data = request.get_json()
    _s = object()
    content = data.get('content', _s)
    status = data.get('status', _s)
    area_id = data.get('area_id', _s)
    defer_until = data.get('defer_until', _s)
    project_id = data.get('project_id', _s)
    tags = data.get('tags', _s)
    waiting_on = data.get('waiting_on', _s)
    chase_on = data.get('chase_on', _s)
    notes = data.get('notes', _s)
    pushed = data.get('pushed', _s)
    started_at = data.get('started_at', _s)
    deadline = data.get('deadline', _s)
    after_id = data.get('after_id', _s)
    if status is not _s and status not in VALID_INBOX_STATUSES:
        return jsonify({'error': 'status must be null, active, waiting, or on_hold'}), 400
    kwargs = {}
    if content is not _s:
        kwargs['content'] = content
    if status is not _s:
        kwargs['status'] = status
    if area_id is not _s:
        kwargs['area_id'] = area_id
    if defer_until is not _s:
        kwargs['defer_until'] = defer_until
    if project_id is not _s:
        kwargs['project_id'] = project_id
    if tags is not _s:
        kwargs['tags'] = tags
    if waiting_on is not _s:
        kwargs['waiting_on'] = waiting_on
    if chase_on is not _s:
        kwargs['chase_on'] = chase_on
    if notes is not _s:
        kwargs['notes'] = notes
    if pushed is not _s:
        kwargs['pushed'] = pushed
    if started_at is not _s:
        kwargs['started_at'] = started_at
    if deadline is not _s:
        kwargs['deadline'] = deadline
    if after_id is not _s:
        kwargs['after_id'] = after_id
    item = storage.update_inbox_item(id, **kwargs)
    _touch_and_sync_inbox()
    return jsonify(item)


# --- Undo support: capture what a delete would destroy, and replay it ---

@app.route('/api/inbox/<int:id>/snapshot')
def get_inbox_snapshot_route(id):
    snap = storage.get_inbox_snapshot(id)
    if not snap:
        return jsonify({'error': 'not found'}), 404
    return jsonify(snap)


@app.route('/api/inbox/restore', methods=['POST'])
def post_inbox_restore():
    item = storage.restore_inbox_item(request.get_json())
    if not item:
        return jsonify({'error': 'bad snapshot'}), 400
    _touch_and_sync_inbox()
    return jsonify(item), 201


@app.route('/api/routine-items/restore', methods=['POST'])
def post_routine_item_restore():
    item = storage.restore_routine_item(request.get_json())
    if not item:
        return jsonify({'error': 'bad snapshot'}), 400
    return jsonify(item), 201


@app.route('/api/inbox/<int:id>/push', methods=['POST'])
def push_inbox(id):
    # "not today" — one gesture, no date to choose. Separate from PATCH because
    # it also counts the push for the weekly review.
    item = storage.push_item_to_tomorrow(id)
    _touch_and_sync_inbox()
    return jsonify(item)


@app.route('/api/map')
def get_map():
    return jsonify(storage.get_map_items())


@app.route('/api/inbox/deferred')
def get_deferred_route():
    return jsonify(storage.get_deferred_items())


# --- Engage panel day placements ---

@app.route('/api/engage/placements')
def get_engage_placements_route():
    frm = request.args.get('from')
    if frm:
        return jsonify(storage.get_engage_placements_from(frm))
    date = request.args.get('date') or date_cls.today().isoformat()
    # The day's occasions mint here, on the read that builds the day — the same
    # place seed_recurring_tasks runs from. No scheduler, and walking to a future
    # day mints that day rather than only today.
    storage.mint_occasions(date)
    return jsonify(storage.get_engage_placements(date))


@app.route('/api/engage/placements', methods=['POST'])
def post_engage_placement():
    data = request.get_json()
    date = data.get('date') or date_cls.today().isoformat()
    storage.set_engage_placement(date, data['item_id'], data['minute'])
    return jsonify(storage.get_engage_placements(date)), 201


@app.route('/api/engage/placements/<int:item_id>', methods=['DELETE'])
def delete_engage_placement_route(item_id):
    date = request.args.get('date') or date_cls.today().isoformat()
    storage.delete_engage_placement(date, item_id)
    return '', 204


@app.route('/api/about')
def get_about():
    # Detection lives HERE and not on /api/settings: this is opened by hand,
    # once in a while, and /api/settings is read on every load. A subprocess
    # on the hot path to answer a question nobody asked is how a settings
    # page ends up owning the startup time.
    _detect_app_url()
    return jsonify({'url': _app_url(), 'source': _app_url_source()})


@app.route('/api/blocks/day')
def get_blocks_day_route():
    # The blocks in force on a date, already resolved: overrides applied,
    # cancellations dropped, past-midnight wrapped, yesterday's continuation
    # carried in at a negative start. The client asks rather than re-deciding.
    # ?all=1 keeps the ones you cancelled, which the TIMELINE needs to strike
    # through. Everything else wants the day as it will actually run.
    date = request.args.get('date') or date_cls.today().isoformat()
    return jsonify(storage.block_segments_for(date, with_cancelled=bool(request.args.get('all'))))


@app.route('/api/engage/day')
def get_engage_day_route():
    # The NOW panel polls this and may well be the first reader of the day.
    storage.mint_occasions(date_cls.today().isoformat())
    return jsonify(storage.get_engage_day())


# --- Occasions: the actions a KIND of event always brings with it ---

@app.route('/api/occasions')
def get_occasions_route():
    return jsonify(storage.get_occasions())


@app.route('/api/occasions', methods=['POST'])
def post_occasion_route():
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    match_text = (data.get('match_text') or '').strip()
    if not name or not match_text:
        return jsonify({'error': 'an occasion needs a name and a word to match'}), 400
    return jsonify(storage.create_occasion(name, match_text)), 201


@app.route('/api/occasions/<int:id>', methods=['PATCH'])
def patch_occasion_route(id):
    data = request.get_json() or {}
    kwargs = {}
    for f in ('name', 'match_text'):
        if f in data:
            v = (data[f] or '').strip()
            if not v:
                return jsonify({'error': f'{f} cannot be empty'}), 400
            kwargs[f] = v
    if 'active' in data:
        kwargs['active'] = data['active']
    occ = storage.update_occasion(id, **kwargs)
    if occ is None:
        return jsonify({'error': 'no such occasion'}), 404
    return jsonify(occ)


@app.route('/api/occasions/<int:id>', methods=['DELETE'])
def delete_occasion_route(id):
    storage.delete_occasion(id)
    return '', 204


@app.route('/api/occasions/<int:id>/items', methods=['POST'])
def post_occasion_item_route(id):
    data = request.get_json() or {}
    content = (data.get('content') or '').strip()
    if not content:
        return jsonify({'error': 'the action needs text'}), 400
    return jsonify(storage.add_occasion_item(
        id, content,
        area_id=data.get('area_id'), project_id=data.get('project_id'),
        tags=data.get('tags') or '', notes=data.get('notes') or '')), 201


@app.route('/api/occasions/items/<int:item_id>', methods=['DELETE'])
def delete_occasion_item_route(item_id):
    storage.delete_occasion_item(item_id)
    return '', 204


# --- Routine checklists (their own datatype, attached to routine areas) ---

@app.route('/api/routine-items')
def get_routine_items_route():
    return jsonify(storage.get_routine_items())


@app.route('/api/routine-items', methods=['POST'])
def post_routine_item():
    data = request.get_json()
    content = (data.get('content') or '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400
    return jsonify(storage.create_routine_item(data['area_id'], content)), 201


@app.route('/api/routine-items/<int:id>', methods=['PATCH'])
def patch_routine_item(id):
    data = request.get_json()
    item = storage.update_routine_item(id, content=data.get('content'), done=data.get('done'))
    return jsonify(item)


@app.route('/api/routine-items/<int:id>', methods=['DELETE'])
def delete_routine_item_route(id):
    storage.delete_routine_item(id)
    return '', 204


# --- Reference lists (GTD's non-actionable keeps) ---

@app.route('/api/ref')
def get_ref_route():
    return jsonify(storage.get_ref_lists())


@app.route('/api/ref/lists', methods=['POST'])
def post_ref_list():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.create_ref_list(name, data.get('parent_id'))), 201


@app.route('/api/ref/lists/<int:id>', methods=['PATCH'])
def patch_ref_list(id):
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.update_ref_list(id, name))


@app.route('/api/ref/lists/<int:id>', methods=['DELETE'])
def delete_ref_list_route(id):
    storage.delete_ref_list(id)
    return '', 204


@app.route('/api/ref/items', methods=['POST'])
def post_ref_item():
    data = request.get_json()
    content = (data.get('content') or '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400
    return jsonify(storage.create_ref_item(data['list_id'], content, data.get('done', 0))), 201


@app.route('/api/ref/items/<int:id>', methods=['PATCH'])
def patch_ref_item(id):
    data = request.get_json()
    return jsonify(storage.update_ref_item(id, content=data.get('content'), done=data.get('done')))


@app.route('/api/ref/items/<int:id>', methods=['DELETE'])
def delete_ref_item_route(id):
    storage.delete_ref_item(id)
    return '', 204


# --- Social exposure v1 (grid, calibration, spec + dose lines; dryrun) ---

# ── Self-monitoring: metrics (2026-08-16) ────────────────────
#
# Definitions are config; entries are the day's answers. Nothing here judges
# anything: a metric is DISPLAY ONLY (Quentin) — no value drives money. What
# CAN gate is the routine step that asks them, through the ordinary hard/soft
# rule, so a gate demands that you ANSWERED, never a particular answer.

@app.route('/api/metrics')
def get_metrics_route():
    return jsonify(storage.get_metrics())


@app.route('/api/metrics', methods=['POST'])
def post_metric():
    data = request.get_json() or {}
    if not (data.get('name') or '').strip():
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.create_metric(data)), 201


@app.route('/api/metrics/<int:id>', methods=['PATCH'])
def patch_metric(id):
    data = request.get_json() or {}
    if 'name' in data and not (data.get('name') or '').strip():
        return jsonify({'error': 'name cannot be blank'}), 400
    return jsonify(storage.update_metric(id, data))


@app.route('/api/metrics/<int:id>', methods=['DELETE'])
def delete_metric_route(id):
    storage.delete_metric(id)
    return '', 204


# What one step asks on one date, with whatever has been answered already.
@app.route('/api/metrics/step/<int:step_id>')
def get_metrics_for_step(step_id):
    ymd = request.args.get('date') or date_cls.today().isoformat()
    return jsonify({
        'date': ymd,
        'metrics': storage.metrics_for_step(step_id, ymd),
        'complete': storage.metrics_step_complete(step_id, ymd),
    })


@app.route('/api/metrics/entry', methods=['PUT'])
def put_metric_entry():
    data = request.get_json() or {}
    if data.get('metric_id') is None or data.get('step_id') is None:
        return jsonify({'error': 'metric_id and step_id are required'}), 400
    ymd = data.get('date') or date_cls.today().isoformat()
    entry = storage.set_metric_entry(ymd, int(data['metric_id']), int(data['step_id']),
                                     data.get('value'))
    return jsonify({'entry': entry,
                    'complete': storage.metrics_step_complete(int(data['step_id']), ymd)})


# What the Metrics page reads: every metric with its recent answers. The window
# is a READ, so defaulting it to "the last 60 days ending today" is the honest
# answer to a question that named no dates.
@app.route('/api/metrics/overview')
def get_metrics_overview():
    end = request.args.get('end') or date_cls.today().isoformat()
    days = max(1, min(int(request.args.get('days') or 60), 400))
    start = (date_cls.fromisoformat(end) - timedelta(days=days - 1)).isoformat()
    return jsonify({'start': start, 'end': end,
                    'metrics': storage.metrics_overview(start, end)})


@app.route('/api/metrics/<int:id>/history')
def get_metric_history(id):
    end = request.args.get('end') or date_cls.today().isoformat()
    start = request.args.get('start') or (
        date_cls.fromisoformat(end) - timedelta(days=59)).isoformat()
    return jsonify(storage.metric_history(id, start, end))


@app.route('/api/social')
def get_social_route():
    levels = storage.get_social_levels()
    anchor = storage.get_social_anchor()
    return jsonify({'levels': levels, 'anchor': anchor, 'd': storage.get_social_d(),
                    'axes': storage.SOCIAL_FAMILY_AXES})


@app.route('/api/social/levels/<int:id>', methods=['PATCH'])
def patch_social_level(id):
    data = request.get_json()
    rating = data.get('rating')
    if rating is not None:
        rating = max(0, min(10, int(rating)))
    return jsonify(storage.set_social_level_rating(id, rating))


@app.route('/api/social/anchor', methods=['PUT'])
def put_social_anchor():
    data = request.get_json()
    anchor = {k: data.get(k) for k in ('warmth', 'medium', 'ask')}
    if not all(anchor.values()):
        return jsonify({'error': 'anchor needs warmth, medium and ask level ids'}), 400
    storage.set_setting('social_anchor', json.dumps(anchor))
    return jsonify({'anchor': anchor, 'd': storage.get_social_d()})


@app.route('/api/social/day')
def get_social_day_route():
    date = request.args.get('date') or date_cls.today().isoformat()
    return jsonify(storage.get_social_day(date))


@app.route('/api/social/specs', methods=['POST'])
def post_social_spec():
    data = request.get_json()
    date = data.get('date') or date_cls.today().isoformat()
    # id+price present only when an undo replays a removed spec verbatim.
    spec = storage.add_social_spec(date, data.get('family', 'directed'),
                                   data.get('levels') or {},
                                   data.get('person'), data.get('opener'),
                                   id=data.get('id'), price=data.get('price'))
    if spec is None:
        return jsonify({'error': 'unpriceable — calibrate the chosen levels first'}), 400
    storage.sync_social_spec_items(date)
    return jsonify(spec), 201


@app.route('/api/social/specs/<int:id>', methods=['DELETE'])
def delete_social_spec_route(id):
    date = storage.delete_social_spec(id)
    if date:
        storage.sync_social_spec_items(date)
    return '', 204


@app.route('/api/social/reps', methods=['POST'])
def post_social_rep():
    data = request.get_json()
    data['date'] = data.get('date') or date_cls.today().isoformat()
    rep = storage.add_social_rep(data)
    if rep is None:
        return jsonify({'error': 'unpriceable — calibrate the chosen levels first'}), 400
    return jsonify(rep), 201


@app.route('/api/social/reps/<int:id>', methods=['DELETE'])
def delete_social_rep_route(id):
    storage.delete_social_rep(id)
    return '', 204


# --- GTD projects (Horizon 1), stored as inbox_item rows with kind='project' ---

@app.route('/api/projects')
def list_projects():
    area_id = request.args.get('area_id', type=int)
    if area_id:
        return jsonify(storage.get_area_projects(area_id))
    return jsonify(storage.get_all_projects())


@app.route('/api/projects', methods=['POST'])
def post_project():
    data = request.get_json()
    content = (data.get('content') or '').strip()
    area_id = data.get('area_id')
    if not content:
        return jsonify({'error': 'content is required'}), 400
    if not area_id:
        return jsonify({'error': 'area_id is required'}), 400
    return jsonify(storage.create_project(content, area_id)), 201


@app.route('/api/projects/<int:id>', methods=['PATCH'])
def patch_project(id):
    data = request.get_json()
    content = (data.get('content') or '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400
    return jsonify(storage.update_inbox_item(id, content=content))


@app.route('/api/projects/<int:id>', methods=['DELETE'])
def delete_project_route(id):
    storage.delete_project(id)
    return '', 204


@app.route('/api/areas/<int:id>', methods=['DELETE'])
def delete_area(id):
    storage.delete_area(id)
    return '', 204


@app.route('/api/blocks')
def get_blocks():
    return jsonify(storage.get_blocks())


@app.route('/api/blocks', methods=['POST'])
def post_block():
    data = request.get_json()
    days = data['days']
    for day in days:
        overlap = storage.validate_no_overlap(day, data['start_time'], data['end_time'])
        if overlap:
            return jsonify({'error': f'Overlaps with {overlap}'}), 409
    blocks = []
    for day in days:
        block = storage.create_block(
            data['label'], data['color'], day,
            data['start_time'], data['end_time'], data.get('area_id'),
            data.get('location_id')
        )
        blocks.append(block)
    return jsonify(blocks), 201


@app.route('/api/blocks/<int:id>', methods=['DELETE'])
def delete_block(id):
    # ?effective_from= dates the removal instead of doing it: the block keeps
    # running, and leaves the timeline on that day.
    effective_from = request.args.get('effective_from') or None
    if effective_from:
        if not _YMD_RE.match(effective_from):
            return jsonify({'error': 'effective_from must be YYYY-MM-DD'}), 400
        return jsonify(storage.schedule_block_change(
            id, {storage.BLOCK_DELETE_FIELD: 1}, effective_from))
    storage.delete_block(id)
    return '', 204


# Calling one off. The forward change was never applied, so there is nothing to
# undo — the row is simply as it always was.
@app.route('/api/blocks/<int:id>/scheduled/<field>', methods=['DELETE'])
def cancel_block_scheduled(id, field):
    storage.cancel_block_change(id, field)
    return jsonify(storage.block_scheduled_changes(id))


@app.route('/api/blocks/<int:id>', methods=['PATCH'])
def patch_block(id):
    data = request.get_json()
    # A DATE turns the same patch into a scheduled one: nothing about the block
    # changes today, and every surface that draws a day resolves it through
    # storage.row_as_of from that date on. No 24h rule here — a block is not on
    # the money path, so the only floor is the date itself.
    effective_from = data.pop('effective_from', None) or None
    if effective_from:
        if not _YMD_RE.match(effective_from):
            return jsonify({'error': 'effective_from must be YYYY-MM-DD'}), 400
        # The overlap check is deliberately NOT run: it asks about the week as
        # it is now, and a block moving on Wednesday may legitimately overlap a
        # block that is itself moving that day. The clash, if there is one,
        # shows on the day it happens.
        return jsonify(storage.schedule_block_change(id, data, effective_from))
    # Pausing is the one patch that does not move the block, so it does not go
    # through the overlap check — a paused block occupies no time at all.
    if set(data) == {'active'}:
        return jsonify(storage.set_block_active(id, data['active']))
    overlap = storage.validate_no_overlap(
        data['day_of_week'], data['start_time'], data['end_time'], exclude_id=id
    )
    if overlap:
        return jsonify({'error': f'Overlaps with {overlap}'}), 409
    block = storage.update_block(
        id, data['label'], data['color'], data['day_of_week'],
        data['start_time'], data['end_time'], data.get('area_id'),
        data.get('location_id')
    )
    return jsonify(block)


@app.route('/api/overrides')
def get_overrides():
    date = request.args.get('date', '')
    return jsonify(storage.get_overrides_for_date(date))


@app.route('/api/overrides', methods=['POST'])
def post_override():
    data = request.get_json()
    fields = {}
    if 'cancelled' in data:
        fields['cancelled'] = 1 if data['cancelled'] else 0
    if 'start_time' in data:
        fields['start_time'] = data['start_time']
    if 'end_time' in data:
        fields['end_time'] = data['end_time']
    override = storage.upsert_override(data['block_id'], data['date'], **fields)
    return jsonify(override), 201


@app.route('/api/overrides/<int:id>', methods=['DELETE'])
def delete_override(id):
    storage.delete_override(id)
    return '', 204


# Local snapshot only. Git is no longer a sync or backup layer for data: the
# repo carries code, the data dir carries data, and durability is the restic
# timer's job (encrypted client-side, offsite, versioned — deploy/BACKUPS.md).
# Nothing here commits or pushes, which is also what lets the server run from
# a read-only public clone with no deploy key.
def _daily_backup():
    # The daybook runs FIRST and on every start, not once a day: it is cheap
    # (it rewrites only what changed) and today's file should be current even
    # when the snapshot has already been taken. A failure here must not cost
    # the snapshot — the database backup is the one that has to happen.
    try:
        written = daybook.catch_up()
        if written:
            print(f'daybook: {len(written)} day file(s) written '
                  f'({written[0]} … {written[-1]})')
    except Exception as e:
        print(f'daybook: failed, snapshot continues — {e}')
    if storage.get_settings().get('last_backup_date') == date_cls.today().isoformat():
        return
    storage.backup_db()


if not os.environ.get('PT_SERVER'):
    threading.Thread(target=_daily_backup, daemon=True).start()


@app.route('/api/logs')
def get_logs():
    # ?q= adds the matching lines per log. A query PARAMETER rather than a
    # /api/logs/search route, which would be shadowed by a log actually named
    # "search" — /api/logs/<name> is already that shape.
    q = request.args.get('q')
    if not q:
        return jsonify(storage.list_logs())
    hits = storage.search_logs(q)
    return jsonify([dict(l, hits=hits[l['name']])
                    for l in storage.list_logs() if l['name'] in hits])


@app.route('/api/logs', methods=['POST'])
def post_log():
    data = request.get_json()
    return jsonify(storage.create_log(data['name'], data.get('tags'))), 201


@app.route('/api/logs/<name>')
def get_log(name):
    return jsonify(storage.read_log(name))


@app.route('/api/logs/<name>', methods=['PUT'])
def put_log(name):
    storage.write_log(name, request.get_json()['content'])
    return '', 204


# Multipart, not JSON: base64 in a JSON body would be a third of the phone's
# photo again, held whole in memory on both ends, for nothing. The cap is here
# rather than app.MAX_CONTENT_LENGTH so it applies to THIS route only — every
# other write is small and a global cap would silently police them too.
LOG_PHOTO_MAX = 25 * 1024 * 1024


@app.route('/api/logs/<name>/photo', methods=['POST'])
def post_log_photo(name):
    f = request.files.get('photo')
    if not f:
        return jsonify({'error': 'no file'}), 400
    data = f.read(LOG_PHOTO_MAX + 1)
    if len(data) > LOG_PHOTO_MAX:
        return jsonify({'error': 'too big'}), 413
    rel = storage.save_log_photo(name, f.filename, data)
    if not rel:
        return jsonify({'error': 'not an image'}), 415
    return jsonify({'path': rel}), 201


# Serves what the link points at. The markdown link is RELATIVE, so any viewer
# reading logs/ off disk resolves it without this; the route exists so the same
# photo is reachable over HTTP from the phone that took it.
@app.route('/api/logs/media/<path:fname>')
def get_log_media(fname):
    return send_from_directory(os.path.abspath(storage.LOGS_MEDIA_DIR), fname)


@app.route('/api/settings', methods=['GET'])
def get_settings():
    # qr_worker_url lives in config.json, not the setting table, but the client
    # needs it to build scan URLs. Serving it here keeps ONE source of truth —
    # it used to be hardcoded separately in app.js, so changing the Worker
    # meant changing two files and finding out later if you missed one.
    return jsonify(dict(storage.get_settings(), gate_scan_url=_gate_scan_url(),
                        app_url=_app_url()))


VALID_TIMEZONES = [
    'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
    'America/Sao_Paulo', 'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Athens', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
]


@app.route('/api/settings', methods=['PATCH'])
def patch_settings():
    data = request.get_json()
    if 'timezone' in data and data['timezone'] not in VALID_TIMEZONES:
        return jsonify({'error': 'unknown timezone'}), 400
    for key, value in data.items():
        storage.set_setting(key, value)
    if 'timezone' in data:
        # Shift the whole server, then re-expand the calendar: stored gcal
        # times are naive local, so they must be re-parsed in the new zone.
        # The judge and the scan server pick the new zone up on their next
        # run — each applies the lever itself at startup.
        storage.apply_timezone()
        threading.Thread(target=_refresh_all_calendars, daemon=True).start()
    # Same shape as GET — a client that assigns this response over its settings
    # state would otherwise lose qr_worker_url until the next full load.
    return jsonify(dict(storage.get_settings(), gate_scan_url=_gate_scan_url(),
                        app_url=_app_url()))


@app.route('/api/timezones')
def get_timezones():
    return jsonify(VALID_TIMEZONES)


def _build_occurrences(events):
    # Modified instances of recurring events (RECURRENCE-ID) share the master's
    # uid; they replace the expanded occurrence at their original start time
    superseded = {(ev['uid'], aggregator._fmt(ev['recurrence_id']))
                  for ev in events if ev.get('recurrence_id')}
    by_key = {}
    for ev in events:
        uid = ev['uid']
        summary = ev['summary']
        dtstart = ev['dtstart']
        dtend = ev['dtend']
        rrule = ev['rrule']
        allday = 1 if ev.get('allday') else 0
        if rrule:
            duration = dtend - dtstart
            for s, e in aggregator.expand_rrule(rrule, dtstart, duration):
                if (uid, s) in superseded:
                    continue
                by_key.setdefault((uid, s), {'uid': uid, 'summary': summary, 'start': s, 'end': e, 'allday': allday})
        else:
            start = aggregator._fmt(dtstart)
            by_key[(uid, start)] = {'uid': uid, 'summary': summary,
                                    'start': start, 'end': aggregator._fmt(dtend),
                                    'allday': allday}
    return list(by_key.values())


def _rebuild_source(source):
    events = fetch_gcal(source['url'])
    occurrences = _build_occurrences(events)
    storage.replace_source_events(source['id'], occurrences, datetime.now().isoformat())


def _rebuild_source_safe(source):
    try:
        _rebuild_source(source)
    except Exception:
        pass


@app.route('/api/gcal')
def get_gcal():
    return jsonify(storage.get_gcal_events())


# MOVING A FETCHED EVENT is a local nudge, never a write to Google (2026-08-24,
# Quentin's instruction). Google stays the source of truth — the app may only
# create and, as the undo, delete what it created — so the moved time lives
# beside the mirror and the event draws with a darker outline to say the two
# now disagree. No date default: the client sends the occurrence's own ISO
# times, so there is no day for this route to guess.
@app.route('/api/gcal/moves', methods=['POST', 'DELETE'])
def gcal_move():
    d = request.get_json(force=True) or {}
    uid, start = d.get('uid'), d.get('start')
    if not uid or not start:
        return jsonify({'error': 'uid and start are required'}), 400
    if request.method == 'DELETE':
        storage.clear_gcal_move(uid, start)
        return jsonify({'ok': True})
    new_start, new_end = d.get('new_start'), d.get('new_end')
    # Full ISO datetimes sort chronologically as strings — this is not the
    # banned HH:MM comparison, which is only right inside one day.
    if not new_start or not new_end or new_end <= new_start:
        return jsonify({'error': 'new_start and new_end must be a real span'}), 400
    storage.set_gcal_move(uid, start, new_start, new_end)
    return jsonify({'ok': True})


def _refresh_all_calendars():
    sources = storage.get_calendar_sources()
    if sources:
        with ThreadPoolExecutor(max_workers=len(sources)) as ex:
            list(ex.map(_rebuild_source_safe, sources))


@app.route('/api/gcal/refresh', methods=['POST'])
def refresh_gcal():
    _refresh_all_calendars()
    return jsonify(storage.get_gcal_events())


# Calendar WRITES (2026-08-11). Config-gated: gcal_write_calendar_id names the
# Google calendar (shared with the service account), gcal_write_source_id the
# local calendar_source whose feed mirrors it (where the optimistic insert
# lands), gcal_credentials_path the service-account JSON. Creates only —
# gcal stays a read-only mirror for everything fetched; the one thing the app
# may delete on Google is an event it created itself, and only as the undo.
def _gcal_write_conf():
    return (config.get('gcal_write_calendar_id'),
            config.get('gcal_credentials_path', 'credentials.json'),
            config.get('gcal_write_source_id'))


@app.route('/api/gcal/events', methods=['POST'])
def post_gcal_event():
    cal_id, creds, src = _gcal_write_conf()
    if not cal_id or not os.path.exists(creds):
        return jsonify({'error': 'Calendar writes not configured: set '
                        'gcal_write_calendar_id in config.json and put the '
                        f'service-account JSON at {creds}'}), 400
    data = request.get_json()
    summary = (data.get('summary') or '').strip()
    day, start, end = data.get('date'), data.get('start'), data.get('end')
    if not summary or not day or not start:
        return jsonify({'error': 'summary, date and start are required'}), 400
    start_dt = datetime.strptime(f'{day}T{start}', '%Y-%m-%dT%H:%M')
    end_dt = (datetime.strptime(f'{day}T{end}', '%Y-%m-%dT%H:%M')
              if end else start_dt + timedelta(minutes=60))
    # An end at/before the start reads as past midnight, same rule as sleep
    # deadlines.
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    try:
        created = aggregator.create_gcal_event(creds, cal_id, summary,
                                               start_dt, end_dt)
    except Exception as e:
        return jsonify({'error': f'Google refused the write: {e}'}), 502
    if src:
        storage.insert_gcal_event(src, created['uid'], summary,
                                  start_dt.strftime('%Y-%m-%dT%H:%M:%S'),
                                  end_dt.strftime('%Y-%m-%dT%H:%M:%S'))
    return jsonify(created)


@app.route('/api/gcal/events/<event_id>', methods=['DELETE'])
def delete_gcal_event_route(event_id):
    cal_id, creds, src = _gcal_write_conf()
    if not cal_id or not os.path.exists(creds):
        return jsonify({'error': 'Calendar writes not configured'}), 400
    try:
        aggregator.delete_gcal_event(creds, cal_id, event_id)
    except Exception as e:
        return jsonify({'error': f'Google refused the delete: {e}'}), 502
    uid = request.args.get('uid', '')
    if src and uid:
        storage.delete_gcal_event_by_uid(src, uid)
    return jsonify({'ok': True})


@app.route('/api/dismissals')
def get_dismissals():
    return jsonify(storage.get_timeline_dismissals())


@app.route('/api/dismissals', methods=['POST'])
def add_dismissal():
    data = request.get_json()
    storage.add_timeline_dismissal(data['type'], data['key'])
    return '', 204


@app.route('/api/dismissals', methods=['DELETE'])
def remove_dismissal():
    data = request.get_json()
    storage.remove_timeline_dismissal(data['type'], data['key'])
    return '', 204


@app.route('/api/calendars')
def get_calendars():
    return jsonify(storage.get_calendar_sources())


@app.route('/api/calendars', methods=['POST'])
def post_calendar():
    data = request.get_json()
    url = (data.get('url') or '').strip()
    color = data.get('color') or _SEED_PALETTE[0]
    if not url:
        return jsonify({'error': 'url is required'}), 400
    try:
        name, events = aggregator.fetch_gcal_named(url)
    except Exception:
        return jsonify({'error': 'Could not fetch a valid iCal feed from that URL'}), 400
    if not name:
        name = 'Untitled calendar'
    source = storage.create_calendar_source(name, url, color)
    occurrences = _build_occurrences(events)
    storage.replace_source_events(source['id'], occurrences, datetime.now().isoformat())
    return jsonify({'source': source, 'count': len(occurrences)}), 201


@app.route('/api/calendars/<int:id>', methods=['PATCH'])
def patch_calendar(id):
    data = request.get_json()
    kwargs = {k: data[k] for k in ('name', 'color', 'active') if k in data}
    source = storage.update_calendar_source(id, **kwargs)
    return jsonify(source)


@app.route('/api/calendars/<int:id>', methods=['DELETE'])
def delete_calendar(id):
    storage.delete_calendar_source(id)
    return '', 204


@app.route('/api/sheets')
def get_sheets():
    return jsonify(storage.get_deadlines())


@app.route('/api/sheets/inbox')
def get_sheets_inbox():
    return jsonify(storage.get_sheets_inbox_items())


@app.route('/api/sheets/refresh', methods=['POST'])
def refresh_sheets():
    url = config.get('sheets_url', '')
    if url:
        rows = fetch_sheets(url)
        storage.upsert_deadlines(rows)
        storage.upsert_sheets_inbox_items(rows)
    return jsonify(storage.get_sheets_inbox_items())


@app.route('/api/sheets/<int:row_index>/done', methods=['PATCH'])
def patch_sheets_done(row_index):
    storage.mark_deadline_done(row_index)
    return jsonify({})


def _build_ics(blocks, cancelled_set):
    today = date_cls.today()
    window_end = today + timedelta(weeks=8)
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Productivity Tracker//blocks//EN',
        'CALSCALE:GREGORIAN',
    ]
    cur = today
    while cur <= window_end:
        dow = cur.weekday()
        for block in blocks:
            if not block['active'] or block['day_of_week'] != dow:
                continue
            if (block['id'], cur.isoformat()) in cancelled_set:
                continue
            end_date = cur + timedelta(days=1) if block['end_time'] <= block['start_time'] else cur
            dtstart = cur.strftime('%Y%m%d') + 'T' + block['start_time'].replace(':', '') + '00'
            dtend = end_date.strftime('%Y%m%d') + 'T' + block['end_time'].replace(':', '') + '00'
            lines += [
                'BEGIN:VEVENT',
                f'DTSTART:{dtstart}',
                f'DTEND:{dtend}',
                f'SUMMARY:{block["label"]}',
                f'UID:block-{block["id"]}-{cur.strftime("%Y%m%d")}@productivity-tracker',
                'END:VEVENT',
            ]
        cur += timedelta(days=1)
    lines.append('END:VCALENDAR')
    return '\r\n'.join(lines) + '\r\n'


@app.route('/api/blocks/export-ics', methods=['POST'])
def export_blocks_ics():
    today = date_cls.today()
    window_end = (today + timedelta(weeks=8)).isoformat()
    blocks = storage.get_blocks()
    overrides = storage.get_overrides_for_window(today.isoformat(), window_end)
    cancelled = {(o['block_id'], o['date']) for o in overrides}
    ics = _build_ics(blocks, cancelled)
    path = os.path.join(os.path.expanduser('~'), 'Downloads', 'blocks.ics')
    with open(path, 'w', newline='') as f:
        f.write(ics)
    return jsonify({'path': path})


# --- Block Feedback ---

@app.route('/api/journal')
def get_journal():
    today = date_cls.today().isoformat()
    return jsonify({
        'days': storage.get_journal_days(),
        'habit': storage.get_habit_week_for(today),
        'habits': storage.list_habit_weeks(),
    })


@app.route('/api/journal/<date>', methods=['PATCH'])
def patch_journal(date):
    data = request.get_json() or {}
    fields = {}
    if 'bottleneck' in data:
        fields['bottleneck'] = data['bottleneck'] or ''
    if 'problem' in data:
        fields['problem'] = data['problem'] or ''
    if 'active_experiment' in data:
        fields['active_experiment'] = data['active_experiment'] or ''
    if 'rating' in data:
        r = data['rating']
        if r in ('', None):
            fields['rating'] = None
        else:
            try:
                r = int(r)
            except (TypeError, ValueError):
                return jsonify({'error': 'rating must be 1-7'}), 400
            if not 1 <= r <= 7:
                return jsonify({'error': 'rating must be 1-7'}), 400
            fields['rating'] = r
    if 'habit_mark' in data:
        m = data['habit_mark']
        if m in ('', None):
            fields['habit_mark'] = None
        elif m in ('ehh', 'good', 'great'):
            fields['habit_mark'] = m
        else:
            return jsonify({'error': 'habit_mark must be ehh, good, or great'}), 400
    row = storage.upsert_journal_day(date, fields)
    return jsonify(row)


# --- Habits and their experiments ---
#
# Three surfaces, one write class each (the lens rule, applied to habits):
# the NIGHTLY journal step makes marks, the WEEKLY review passes verdicts,
# the JOURNAL tab reads everything. No Settings page — deciding happens in
# the review, so a fourth surface would just restate these.

@app.route('/api/habits')
def get_habits_route():
    today = date_cls.today().isoformat()
    return jsonify(dict(storage.get_habits_overview(today),
                        experiments=storage.get_habit_experiments_overview(today),
                        marks_today=storage.habit_marks_for(today)))


@app.route('/api/habits', methods=['POST'])
def post_habit():
    content = (request.get_json() or {}).get('content', '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400
    return jsonify(storage.create_habit(content, date_cls.today().isoformat())), 201


@app.route('/api/habits/<int:id>', methods=['PATCH'])
def patch_habit(id):
    data = request.get_json() or {}
    status = data.get('status')
    # 'forming' is how a verdict is undone; the other two are conclusions.
    if status not in ('forming', 'graduated', 'dropped'):
        return jsonify({'error': 'status must be forming, graduated or dropped'}), 400
    row = storage.set_habit_status(id, status, (data.get('verdict') or '').strip() or None)
    if not row:
        return jsonify({'error': 'no such habit'}), 404
    return jsonify(row)


@app.route('/api/habits/<int:id>/mark', methods=['POST'])
def post_habit_mark(id):
    data = request.get_json() or {}
    date = data.get('date') or date_cls.today().isoformat()
    kwargs = {}
    if 'mark' in data:
        if data['mark'] not in ('ehh', 'good', 'great', None):
            return jsonify({'error': 'mark must be ehh, good or great'}), 400
        kwargs['mark'] = data['mark']
    if 'effort' in data:
        if data['effort'] not in ('auto', 'deliberate', None):
            return jsonify({'error': 'effort must be auto or deliberate'}), 400
        kwargs['effort'] = data['effort']
    return jsonify(storage.mark_habit_day(id, date, **kwargs))


@app.route('/api/habit-experiments', methods=['POST'])
def post_habit_experiment():
    content = (request.get_json() or {}).get('content', '').strip()
    if not content:
        return jsonify({'error': 'content is required'}), 400
    row = storage.create_habit_experiment(content, date_cls.today().isoformat())
    if row is None:
        return jsonify({'error': 'an experiment is already running — resolve it first'}), 409
    return jsonify(row), 201


@app.route('/api/habit-experiments/<int:id>', methods=['PATCH'])
def patch_habit_experiment(id):
    data = request.get_json() or {}
    # Reword the running one — same variable, said better.
    if 'content' in data:
        content = (data.get('content') or '').strip()
        if not content:
            return jsonify({'error': 'content is required'}), 400
        row = storage.rename_habit_experiment(id, content)
        # Only a RUNNING one can be reworded, and the write says whether it was:
        # a 200 with the untouched row used to mean "reworded" to every caller.
        return jsonify(row) if row else (
            jsonify({'error': 'not running — nothing was reworded'}), 409)
    if 'resolution' in data:
        # The resolution is the EVIDENCE the weekly review judges, so an empty
        # one is refused rather than stored: a blank line reaches the review as
        # "resolved: —", which is the one thing the queue cannot act on. The
        # sheet asks for it and says so; this is the lock behind the sheet.
        resolution = (data.get('resolution') or '').strip()
        if not resolution:
            return jsonify({'error': 'one line on how it resolved is required'}), 400
        # WHICH DAY it resolved on comes from the surface that knows: the nightly
        # routine sends its pinned run day, so an experiment ended at 00:20
        # resolves on the night it belonged to rather than on the day that just
        # started. Same day stamps the one that replaces it — the two halves of
        # one act cannot disagree about when it happened.
        day = data.get('date') or date_cls.today().isoformat()
        row = storage.resolve_habit_experiment(id, resolution, day)
        if not row:
            return jsonify({'error': 'not running — it was already ended'}), 409
        # Dropping happens AT NIGHT as well as at the review: an experiment you
        # already know was a dead end should not have to sit in the review queue
        # to be closed. Resolve-then-evaluate, so there is one lifecycle rather
        # than a second way to end one. 'drop' spends no promotion slot.
        if data.get('outcome') == 'drop':
            out = storage.evaluate_habit_experiment(id, 'drop', day)
            row = (out or {}).get('experiment') or row
        # ENDING ONE AND STARTING THE NEXT IS ONE ACT (2026-08-19, Quentin's
        # instruction): the night you close an experiment is the night you
        # decide tomorrow's, and one-at-a-time means the new one can only be
        # started after this one is closed. Done HERE rather than as a second
        # client call so the ordering is the server's and every surface that
        # ends an experiment gets the same door — and so a start that lands
        # while the end failed is impossible.
        nxt = (data.get('next') or '').strip()
        row['next_experiment'] = storage.create_habit_experiment(nxt, day) if nxt else None
        return jsonify(row)
    outcome = data.get('outcome')
    if outcome == 'resolved':
        # The undo half of an evaluation.
        storage.unevaluate_habit_experiment(id)
        return jsonify({'ok': True})
    if outcome not in ('extend', 'habit', 'drop'):
        return jsonify({'error': 'outcome must be extend, habit or drop'}), 400
    out = storage.evaluate_habit_experiment(id, outcome)
    if out is None:
        return jsonify({'error': 'only a resolved experiment can be evaluated'}), 404
    if out.get('error') == 'promoted':
        return jsonify({'error': 'one promotion per week — this week\'s is already taken'}), 409
    return jsonify(out)


@app.route('/api/habit-experiments/<int:id>/reopen', methods=['POST'])
def reopen_habit_experiment_route(id):
    out = storage.reopen_habit_experiment(id)
    if not out:
        return jsonify({'error': 'no such experiment'}), 404
    if out.get('error'):
        return jsonify(out), 409
    return jsonify(out)


# --- GTD weekly review ---

@app.route('/api/gtd-review')
def get_gtd_review():
    review = storage.get_gtd_review(request.args.get('week'))
    review['counts'] = storage.get_gtd_review_counts()
    review['habit'] = storage.get_habit_week_for(date_cls.today().isoformat())
    # The STEPS are a routine now (storage._seed_review_flow) — this row keeps
    # only what is the review's own and no routine's: the note and the filing.
    review['flow_id'] = storage.get_review_flow_id()
    return jsonify(review)


@app.route('/api/gtd-review/finish', methods=['POST'])
def post_gtd_review_finish():
    data = request.get_json()
    week = data.get('week')
    if not week:
        return jsonify({'error': 'week is required'}), 400
    result = storage.finish_gtd_review(week, (data.get('note') or '').strip())
    # Finishing the review starts the habit week: an optional habit runs from
    # this week_start_date until the next one, rated daily on the sleep-QR form.
    habit = (data.get('habit') or '').strip()
    if habit:
        storage.set_habit_week(week, habit)
        result['habit'] = habit
    return jsonify(result)


# --- Observations ---

@app.route('/api/observations')
def list_observations():
    since = request.args.get('since')
    return jsonify(storage.get_observations(since))


@app.route('/api/observations', methods=['POST'])
def create_observation():
    data = request.get_json()
    if not data.get('kind'):
        return jsonify({'error': 'kind is required'}), 400
    result = storage.create_observation(data)
    return jsonify(result), 201


_YMD_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


# --- Accountability (local since 2026-08-08; was a Cloudflare Worker) ---
#
# These were proxies to /admin/* on the Worker. The judge and the scan
# endpoint now share this database, so they are ordinary reads and writes and
# the authenticated HTTP hop is gone. The RESPONSE SHAPES are unchanged —
# app.js reads days_of_week, weekly_windows, today_override and
# pending_changes off each node, and the QR manager is built around them.

def _node_payload(node, today, routines=None):
    ov = storage.qr_get_override(node['id'], today)
    # `routine` is what makes this gate PASS beyond presence, and it is set in
    # the routine editor rather than here — so the gate has to say it, or the
    # rule that judges it is invisible from the surface that configures it.
    rt = next((f for f in (routines or []) if f.get('qr_node_id') == node['id']), None)
    # `schedule_label` and `day_windows` come from the SAME resolution the judge
    # uses (qr_judge.resolve_window), so the panel, the timeline and the judge
    # cannot disagree about when a gate runs. The client is never handed a rule.
    resolve, _ = storage.schedule_resolver()
    label = _schedule_label(node)
    # A pending change to the schedule is a UID in the table, which is unreadable
    # on a sheet. The server knows what it means, so it says it here.
    pending = storage.qr_get_pending_changes(node['id'])
    for p in pending:
        if p['field'] == 'source_uid':
            new_src = resolve(p['new_value'])
            if new_src:
                try:
                    p['new_label'] = schedule.describe(new_src, resolve)
                except schedule.Cycle:
                    p['new_label'] = 'a schedule that refers to itself'
    # THE SERVER RENDERS THE CLOCK TIME, both here and in the day read-out.
    # qr_scan.scanned_at is UTC by design (the judge matches windows in UTC),
    # and two client sites were slicing HH:MM straight out of it — so a tap at
    # 01:21 local drew as "scanned 05:21" on a row describing a window written
    # in local time. Same fix as everywhere else: one function resolves it, the
    # client prints what it is given.
    state_now = storage.qr_node_day_state(node['id'], today)
    if state_now.get('scan'):
        state_now = dict(state_now, scan=dict(
            state_now['scan'],
            local_time=_scan_local_hhmm(state_now['scan']['scanned_at'])))
    return dict(node,
                today_override=ov,
                today_state=state_now,
                routine=rt['name'] if rt else None,
                routine_id=rt['id'] if rt else None,
                # The offset is set from the GATE sheet now (it is minutes from
                # this gate's deadline), so the gate has to carry it.
                routine_offset_min=(rt.get('offset_min') if rt else None),
                schedule_label=label,
                day_windows=storage.qr_gate_day_windows(node),
                pending_changes=pending,
                tags=_tag_payloads(node['id']),
                tap_url=_tap_url())


def _tap_url():
    # What to write to a tag: the scan URL's host with /t and the two mirror
    # placeholders the tag overwrites on every tap. Derived from the SAME config
    # value the scan links use, so there is one host to be wrong.
    base = (_gate_scan_url() or '').rstrip('/')
    if not base:
        return ''
    # gate_scan_url points at the /scan half; the tap route is its sibling.
    root = base[:-len('/scan')] if base.endswith('/scan') else base
    return root + '/t?e=' + '0' * 32 + '&c=' + '0' * 16


def _tag_payloads(node_id):
    # Whether a tag's KEYS are set, never what they are — the same contract
    # /api/config keeps for the Beeminder token. A tag with no keys can never
    # verify a tap, so saying so is the difference between "it is not working"
    # and "I never finished setting it up".
    keys = ntag.load_keys()
    out = []
    for t in storage.qr_tags_for_node(node_id):
        out.append(dict(t, keys_set=t['uid'].upper() in keys,
                        pending_live_at=storage.qr_tag_pending(t['id'])))
    return out


@app.route('/api/gates/billing')
def get_gates_billing():
    # Everything the Gates panel needs to show the money state, and nothing it
    # could use to LEAK it: the token is never returned, only whether it works
    # and who it bills. Reading this performs one Beeminder call, so it is a
    # deliberate fetch rather than part of loadAll.
    storage.qr_ensure_charge_columns()
    s = qr_judge.charge_settings()
    today = date_cls.today().isoformat()
    week_from = (date_cls.today() - timedelta(days=6)).isoformat()
    return jsonify({
        'live': s['live'],
        'dryrun': s['dryrun'],
        'cap_cents': s['cap_cents'],
        'default_cents': s['default_cents'],
        'fee_cents': s['fee_cents'],
        'spent_cents': storage.qr_weekly_spent_cents(today),
        'judge_last_run': (storage.get_settings() or {}).get('gate_judge_last_run'),
        'token': qr_judge.verify_token() if request.args.get('verify') else None,
        'has_token': bool(s['token']),
        # The USERNAME is not a secret and the panel has to show who would be
        # billed. Only the token is withheld.
        'user': s['user'],
        'has_user': bool(s['user']),
        'recent': storage.qr_charge_rows_between(week_from, today),
    })


@app.route('/api/gates/billing', methods=['PATCH'])
def patch_gates_billing():
    # The three settings the panel may change. The TOKEN is not among them by
    # design: it lives in config.json so that no request can read or write it
    # (see qr_judge's charging header).
    data = request.get_json() or {}
    allowed = {
        'gate_charging_live': lambda v: '1' if v else '0',
        'gate_charge_dryrun': lambda v: '1' if v else '0',
        'gate_weekly_cap_cents': lambda v: str(max(0, int(v))),
        'gate_charge_cents': lambda v: str(max(0, int(v))),
        'gate_card_fee_cents': lambda v: str(max(0, int(v))),
    }
    for key, clean in allowed.items():
        if key in data:
            storage.set_setting(key, clean(data[key]))
    # The Beeminder credential goes to config.json, NOT the setting table: the
    # db is dumped to backups/ and pushed to object storage, and a bearer token
    # that can move money does not belong in a backup set. An empty string
    # means "leave it alone", so saving the username can't wipe the token.
    creds = {k: str(data[k]).strip() for k in ('beeminder_auth_token', 'beeminder_user')
             if str(data.get(k) or '').strip()}
    if creds:
        _update_config(creds)
    return jsonify(qr_judge.charge_settings() | {'token': None, 'user': None})


# ── config.json, from inside the app (2026-08-16) ─────────────
#
# These values used to be reachable only over ssh, so in practice they were set
# once and never corrected. The keys are an ALLOWLIST, not whatever happens to
# be in the file: a config.json that arrives with something unknown in it keeps
# it untouched, and nothing the app does not read can be written from here.
#
# `secret` is the whole reason this needs care. A secret is WRITE-ONLY — the
# GET reports only whether one is set, never a value, not even masked, because
# a mask still has to travel. The db is dumped to backups/ and pushed off-box,
# which is why the token lives in this file and not in `setting`; sending it to
# a client would undo that on the wire instead of in the backup.
# A word, not an empty string: for a secret, empty already means "unchanged".
CLEAR_SENTINEL = '__clear__'

CONFIG_KEYS = [
    {'key': 'beeminder_user', 'label': 'Beeminder user',
     'hint': 'the account the gates bill'},
    {'key': 'beeminder_auth_token', 'label': 'Beeminder token', 'secret': True,
     'hint': 'moves real money — write-only, never shown again'},
    {'key': 'gate_scan_url', 'label': 'Scan URL',
     'hint': 'where a gate\'s QR link points'},
    {'key': 'app_url', 'label': 'App URL',
     'hint': 'the stable link to this app, shown in Settings -> About'},
    {'key': 'sheets_url', 'label': 'Sheets URL',
     'hint': 'the spreadsheet the aggregator reads'},
    {'key': 'gcal_credentials_path', 'label': 'Google credentials',
     'hint': 'path to the service-account JSON'},
    {'key': 'gcal_write_calendar_id', 'label': 'Calendar to write to',
     'hint': 'the one calendar the app may create events in'},
    {'key': 'gcal_write_source_id', 'label': 'Write-back source',
     'hint': 'which local calendar those events belong to'},
    {'key': 'autohotkey_path', 'label': 'AutoHotkey', 'hint': 'path to AutoHotkey.exe (Windows)'},
    {'key': 'arrival_token', 'label': 'Arrival token', 'secret': True,
     'hint': 'the shared secret the phone sends to /api/arrival — arrivals are '
             'refused until it is set'},
    {'key': 'notify_kind', 'label': 'Notify via',
     'hint': 'ntfy (free, the topic name is the only secret) or pushover'},
    {'key': 'notify_url', 'label': 'Notify URL',
     'hint': 'the ntfy topic URL, or https://api.pushover.net/1/messages.json'},
    {'key': 'notify_token', 'label': 'Notify token', 'secret': True,
     'hint': 'pushover only'},
    {'key': 'notify_user', 'label': 'Notify user',
     'hint': 'pushover only'},
    {'key': 'notify_live', 'label': 'Notifications live',
     'hint': 'blank = dry run: arrivals are resolved and logged, nothing is sent'},
    {'key': 'geocode_user_agent', 'label': 'Geocoder contact',
     'hint': 'OpenStreetMap requires a real contact, e.g. "qpa (you@example.com)" '
             '— address search is off until it is set'},
]
_CONFIG_BY_KEY = {c['key']: c for c in CONFIG_KEYS}


@app.route('/api/config')
def get_config():
    out = []
    for spec in CONFIG_KEYS:
        row = dict(spec)
        if spec.get('secret'):
            # Whether it is set, never what it is.
            row['set'] = bool(str(config.get(spec['key']) or '').strip())
        else:
            row['value'] = config.get(spec['key']) or ''
        out.append(row)
    return jsonify(out)


@app.route('/api/config', methods=['PATCH'])
def patch_config():
    data = request.get_json() or {}
    values, cleared = {}, []
    for key, raw in data.items():
        spec = _CONFIG_BY_KEY.get(key)
        if not spec:
            continue
        text = '' if raw is None else str(raw).strip()
        if spec.get('secret'):
            # Blank means LEAVE IT ALONE — the field renders empty every time
            # (there is nothing to render), so saving the row next to it must
            # not wipe the token. Clearing is a deliberate, separate word.
            if text == CLEAR_SENTINEL:
                cleared.append(key)
            elif text:
                values[key] = text
        elif text == CLEAR_SENTINEL or text == '':
            cleared.append(key)
        else:
            values[key] = text
    if cleared:
        values.update({k: '' for k in cleared})
    if values:
        _update_config(values)
    return get_config()



@app.route('/api/accountability/nodes', methods=['GET', 'POST'])
def accountability_nodes():
    today = date_cls.today().isoformat()
    if request.method == 'POST':
        d = request.get_json() or {}
        # 43 chars of URL-safe base64, the same shape the Worker minted: the
        # token IS the scan credential, so it has to be unguessable.
        token = secrets.token_urlsafe(32)
        # A gate created FROM the picker arrives with a source and no window
        # fields. Those columns are still the fallback (and the Worker-side copy
        # reads them), so they are derived from the source rather than guessed.
        if d.get('source_uid'):
            d = dict(d, **storage.qr_windows_from_source(d['source_uid']))
        node_id = storage.qr_create_node(
            d.get('label', 'Untitled'), token,
            d.get('window_start', '09:00'), d.get('window_end', '10:00'),
            d.get('window_end_offset_days') or 0,
            d.get('geofence_lat'), d.get('geofence_lng'), d.get('geofence_radius_m'),
            d.get('days_of_week') or '0123456', d.get('weekly_windows'))
        # A new gate gets its schedule immediately, rather than waiting for the
        # next start-up's adoption pass.
        if d.get('source_uid'):
            storage.qr_update_node(node_id, {'source_uid': d['source_uid']})
        else:
            storage.qr_ensure_node_source(node_id)
        node = [n for n in storage.qr_get_nodes() if n['id'] == node_id][0]
        return jsonify(_node_payload(node, today)), 201
    # Land anything whose 24h is up before answering — same idiom as
    # apply_due_flow_pendings inside get_flows. The judge does this on its own
    # tick, but a queued DELETE has no other way to take effect on a box where
    # the timer isn't running, and the answer would keep listing a gate the
    # user already deleted. apply_at has passed either way, so nothing about
    # judgment changes.
    storage.qr_apply_due_pending_changes(datetime.now().isoformat())
    routines = storage.get_flows()
    return jsonify([_node_payload(n, today, routines) for n in storage.qr_get_nodes()])


# WHAT THIS GATE IS, ON ONE DAY, out of this box's own database (2026-08-21,
# Quentin's instruction). The pill on the timeline said a label and a time; when
# a scan did not clear it there was nowhere to look, and "the app does not know
# I am in Kanji Hall" is not answerable from a label. Every number the judge
# would charge on is here, RESOLVED BY THE JUDGE'S OWN FUNCTIONS rather than
# assembled a second way: resolve_window, applies_on, routine_deadline and
# scan_satisfies. A transparency surface that re-derives its answers would show
# you a day the judge does not believe in, which is worse than showing nothing.
#
# The DATE is a read default (date_cls.today()); the client sends the day it is
# looking at.
# Two weeks: long enough to see a pattern rather than a mood, short enough to
# stay one glanceable row inside a 360px popup.
HISTORY_DAYS = 14


def _gate_day_payload(node, ymd, now=None):
    now = now or datetime.now()
    override = storage.qr_get_override(node['id'], ymd)
    applies = qr_judge.applies_on(node, ymd, override)
    skipped = bool(override and override.get('skipped'))
    start, end, offset = qr_judge.resolve_window(node, ymd, override)
    close_date = qr_judge.close_date_of(ymd, offset)
    open_iso = qr_judge._utc_iso(ymd, start)
    close_iso = qr_judge._utc_iso(close_date, end)

    # WHY the window is what it is. The pill shows one time; which of the four
    # layers produced it is the first thing you need when it is not the time you
    # expected. Same ladder as resolve_window, in the same order.
    if skipped:
        source = 'the day it was called off at'
    elif override:
        source = 'this day only (dragged on the timeline)'
    elif qr_judge.source_window_for(node, ymd):
        source = 'the schedule: ' + (_schedule_label(node) or 'its own rule')
    elif qr_judge.weekly_window_for(node, ymd):
        source = 'the weekly window for this weekday'
    else:
        source = 'the gate default'

    # The pawn moves the OPENING earlier by COMPUTATION, never as a written
    # override, so it is invisible in every column — which is exactly why it
    # belongs here. An override stands as written and the pawn does not apply
    # (resolve_window returns before _less_pawned), so say that rather than
    # showing minutes that did nothing.
    pawn_min = storage.pawned_minutes_for_node(node['id'], ymd)
    flow = storage.gating_flow_for_node(node['id'], ymd)
    pawned = []
    if flow:
        names = {f['id']: f['name'] for f in storage.get_flows()}
        for st in storage.steps_pawned_into(flow['id'], ymd):
            pawned.append({'content': st.get('content'),
                           'minutes': st.get('pawn_minutes') or 0,
                           'from_routine': names.get(st.get('flow_id'))})

    loc = None
    if node.get('geofence_lat') is not None:
        named = next((l for l in storage.get_locations()
                      if l['lat'] == node['geofence_lat']
                      and l['lng'] == node['geofence_lng']), None)
        loc = {'name': (named or {}).get('name'),
               'lat': node['geofence_lat'], 'lng': node['geofence_lng'],
               'radius_m': node.get('geofence_radius_m')}

    # EVERY scan of the day, not only the ones inside the window: a scan that
    # missed by four minutes or by forty metres is the whole answer, and
    # filtering it out leaves "nothing happened", which is a lie about the day.
    # Each one carries the distance the scan server measured it at and whether
    # it clears the gate, asked of scan_satisfies - the ONE predicate.
    # qr_scans_between is the judge's HISTORY read and selects three columns;
    # this needs the position and the proof, so it goes through the per-node
    # query instead. Its bounds are arguments, and the ones passed here are the
    # whole day rather than the window - which is the point.
    scans = []
    for sc in storage.qr_scans_in_window(
            node['id'], qr_judge._utc_iso(ymd, '00:00'),
            qr_judge._utc_iso(qr_judge._date_plus(ymd, 2), '00:00')):
        dist = None
        if loc and sc.get('lat') is not None:
            dist = round(qr_judge.haversine_m(sc['lat'], sc['lng'],
                                              node['geofence_lat'], node['geofence_lng']))
        scans.append(dict(sc, distance_m=dist,
                          local_time=_scan_local_hhmm(sc['scanned_at']),
                          in_window=open_iso <= sc['scanned_at'] <= close_iso,
                          satisfies=bool(qr_judge.scan_satisfies(node, sc))))

    r_due = qr_judge.routine_deadline(node, flow, ymd) if flow else None
    r_open_min, r_due_min = qr_judge.flow_day_window(flow, ymd) if flow else (None, None)
    settings = qr_judge.charge_settings()
    # WHERE THE DAY STANDS, priced. The same ladder the judge charges on
    # (day_credit), asked of the scans inside the window — so an unjudged day
    # shows what it would cost if it ended now, and a judged one is read back
    # from its row rather than recomputed under a config that has since moved.
    in_window = [sc for sc in scans if sc['in_window']]
    credit, credit_reason = qr_judge.day_credit(node, ymd, flow, in_window)
    judged = storage.qr_node_day_state(node['id'], ymd)['judged']
    if judged:
        credit = (judged.get('credit_pct') or 0) / 100.0
        credit_reason = judged.get('failure_reason')
    stake = qr_judge.node_charge_cents(node, settings)

    # THIS GATE'S OWN RECORD (2026-08-30, Quentin's instruction). The billing
    # panel answers "what did every gate cost me this week"; this answers "how
    # is THIS gate going", which had no home - you could see today's verdict
    # and nothing behind it. Same four-word vocabulary the pills already use,
    # so the strip and the calendar cannot describe a day differently.
    #
    # READ BACK, never recomputed: a judged day is frozen, so recomputing one
    # under today's config would show a day the judge does not believe in -
    # which is the whole reason judged_outcome exists and is asked here rather
    # than reimplemented. Days with no row (today, the future, days before the
    # gate existed) are simply absent, and the client leaves them blank rather
    # than inventing a verdict for them.
    hist_from = qr_judge._date_plus(ymd, -HISTORY_DAYS + 1)
    days = []
    charged = 0
    for r in storage.qr_judged_rows_for_node(node['id'], hist_from, ymd):
        off = (r.get('charge_status') or '') == 'n/a'
        days.append({
            'date': r['date'],
            # 'off' is not a verdict, it is the absence of one: the gate did
            # not run that day (a non-run weekday, or one called off).
            'outcome': 'off' if off else qr_judge.judged_outcome(r),
            'amount_cents': r.get('amount_cents') or 0,
        })
        charged += r.get('amount_cents') or 0
    history = {'from': hist_from, 'to': ymd, 'days': days,
               'charged_cents': charged}

    return {
        'node_id': node['id'], 'label': node['label'], 'date': ymd,
        'applies': applies, 'active': bool(node.get('active')),
        # THE DAY OFF, and whether it can still be turned on or off. Both are
        # resolutions the judge owns (applies_on, override_locked) and the
        # read-out renders them — a client deciding for itself whether the 24h
        # lock had bitten would draw a verb the server is about to refuse.
        'skipped': skipped,
        'skip_locked': qr_judge.override_locked(node, ymd, now),
        'proof_mode': node.get('proof_mode') or 'link',
        # THE MINUTES ARE SERVED, not re-derived. The timeline draws four
        # dotted lines from this payload — scan open/close and the routine's
        # open/due — and every one of them is a resolution rule the judge owns:
        # the window ladder, the offset, the pawn, the routine's own schedule
        # or its offset from the gate. A client that recomputed any of them
        # would draw a day the judge does not believe in.
        #
        # Minutes run from midnight of THIS date, so past 1440 means tomorrow
        # (a +1d deadline, a routine due after midnight). Same convention as
        # flow_day_window, and as the client's semantic minutes.
        'window': {'start': start, 'end': end, 'offset_days': offset,
                   'close_date': close_date, 'from': source,
                   'start_min': qr_judge._hhmm_min(start),
                   'end_min': qr_judge._hhmm_min(end) + int(offset or 0) * 1440,
                   'closed': now >= qr_judge._local_dt(close_date, end)},
        'history': history,
        'pawn': {'minutes': pawn_min, 'steps': pawned,
                 'applied': bool(pawn_min) and not override},
        'routine': None if not flow else {
            'name': flow['name'], 'id': flow['id'],
            'deadline': r_due.strftime('%H:%M') if r_due else None,
            # open_min is None for a routine with no schedule of its own: it
            # has a deadline but no hour it starts at, and the timeline draws
            # the line it has rather than inventing one.
            'open_min': r_open_min, 'due_min': r_due_min,
            'own_window': bool(r_open_min is not None),
            'completed_at': flow.get('completed_at')},
        'location': loc,
        'scans': scans,
        'judged': judged,
        # The two halves, named. A single "failed" hid the half that WAS met,
        # which is the thing the split exists to make visible.
        'credit': {
            'pct': int(credit * 100),
            'owed_cents': int(stake * (1 - credit)),
            'reason': credit_reason,
            'scan_half': any(sc['satisfies'] for sc in in_window),
            'routine_half': bool(flow and flow.get('completed_at')),
            'splits': flow is not None,
            'settles_at': qr_judge.settle_after(
                node, ymd, flow, (start, end, offset)).strftime('%Y-%m-%d %H:%M'),
        },
        'stake_cents': stake,
        'live': settings['live'] and not settings['dryrun'],
        'tags': _tag_payloads(node['id']),
        'pending_changes': storage.qr_get_pending_changes(node['id']),
    }


def _scan_local_hhmm(iso, fmt='%H:%M'):
    # UTC with a trailing Z into the wall clock the window is written in. The
    # process timezone is the app's one lever (_apply_timezone), so
    # fromtimestamp follows it with no zone threaded through.
    try:
        dt = datetime.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None
    return datetime.fromtimestamp(
        dt.replace(tzinfo=timezone.utc).timestamp()).strftime(fmt)


def _schedule_label(node):
    if not node.get('source_uid'):
        return ''
    resolve, _ = storage.schedule_resolver()
    src = resolve(node['source_uid'])
    if not src:
        return ''
    try:
        return schedule.describe(src, resolve)
    except schedule.Cycle:
        return 'broken: this schedule refers to itself'


@app.route('/api/accountability/nodes/<int:id>/day', methods=['GET'])
def accountability_node_day(id):
    ymd = request.args.get('date') or date_cls.today().isoformat()
    if not _YMD_RE.match(ymd):
        return jsonify({'error': 'date must be YYYY-MM-DD'}), 400
    node = next((n for n in storage.qr_get_nodes() if n['id'] == id), None)
    if not node:
        return jsonify({'error': 'no such gate'}), 404
    return jsonify(_gate_day_payload(node, ymd))


@app.route('/api/accountability/outcomes', methods=['GET'])
def accountability_outcomes():
    from_date = request.args.get('from', '')
    to_date = request.args.get('to', '')
    if not (_YMD_RE.match(from_date) and _YMD_RE.match(to_date)) or from_date > to_date:
        return jsonify({'error': 'from and to required (YYYY-MM-DD)'}), 400
    return jsonify(qr_judge.outcomes(from_date, to_date))


@app.route('/api/accountability/nodes/<int:id>', methods=['PATCH', 'DELETE'])
def patch_accountability_node(id):
    nodes = {n['id']: n for n in storage.qr_get_nodes()}
    node = nodes.get(id)
    if not node:
        return jsonify({'error': 'unknown node'}), 404

    # silent: a DELETE arrives with no body at all, and asking for JSON that
    # is not there is a 415 rather than an empty dict.
    data = request.get_json(silent=True) or {}
    # WHEN a change starts, asked once and answered in one place. A blank or
    # absent date means the old behaviour exactly: tightenings now, easings in
    # 24h. A date is a floor, never a bypass — qr_judge.schedule_node_patch
    # takes the later of the two.
    effective_from = (data.pop('effective_from', None) or
                      request.args.get('effective_from') or None)
    if effective_from and not _YMD_RE.match(effective_from):
        return jsonify({'error': 'effective_from must be YYYY-MM-DD'}), 400

    if request.method == 'DELETE':
        # An inactive gate is already off the hook, so it goes at once. A LIVE
        # one is deleted on the 24h road, exactly like disabling it: deleting
        # is the loosest change there is, and an instant delete would be the
        # escape hatch the whole system exists to close. Queued, not refused —
        # "deactivate first" was a dead end that read as a bug (2026-08-15).
        if not node['active'] and not effective_from:
            storage.qr_delete_node(id)
            return jsonify({'ok': True})
        at, effective = _gate_landing(effective_from, eases=True)
        storage.qr_cancel_pending_change(id, storage.QR_DELETE_FIELD)
        storage.qr_add_pending_change(id, storage.QR_DELETE_FIELD, '1', at, effective)
        return jsonify({'pending': True, 'apply_at': at, 'effective_date': effective})

    if str(data.get('proof_mode') or '') == 'tag' and node.get('proof_mode') != 'tag':
        # A gate nothing can clear is not a commitment, it is a charge every
        # day — so this is refused at the door instead of applied as the
        # tightening it technically is. (Refused IN WORDS, and the client
        # toasts it: the sheet's foot is where the keyboard sits.)
        live = [t for t in storage.qr_tags_for_node(id, active_only=True)
                if t['uid'].upper() in ntag.load_keys()]
        if not live:
            return jsonify({'error': 'add a tag with its keys first — a tag-only gate '
                                     'with no live tag could never be cleared'}), 400
    immediate, pending = qr_judge.schedule_node_patch(node, data, effective_from)
    if immediate:
        storage.qr_update_node(id, immediate)
        # Newest intent wins in BOTH directions: a field tightened now must drop
        # any deferred loosening still queued for it, or that older change would
        # land 24h later and quietly undo the tightening.
        for field in immediate:
            storage.qr_cancel_pending_change(id, field)
    for field, p in pending.items():
        storage.qr_cancel_pending_change(id, field)   # newest intent wins
        storage.qr_add_pending_change(id, field, p['value'], p['apply_at'],
                                      p['effective_date'])
    return jsonify({'immediate': list(immediate), 'pending': list(pending),
                    'scheduled': {f: {'apply_at': p['apply_at'],
                                      'effective_date': p['effective_date']}
                                  for f, p in pending.items()},
                    # Kept for the surfaces built around one timestamp: the
                    # LAST day anything in this patch starts, which is the day
                    # the whole change is really in force.
                    'apply_at': (max(p['apply_at'] for p in pending.values())
                                 if pending else None),
                    'effective_date': (max(p['effective_date'] for p in pending.values())
                                       if pending else None)})


# The same two floors as schedule_node_patch, for the routes that already know
# which way their change goes (a pause and a delete only ever ease).
def _gate_landing(effective_from, eases=True, now=None):
    now = now or datetime.now()
    at = now + timedelta(hours=qr_judge.LOOSEN_DELAY_H) if eases else now
    if effective_from:
        want = datetime.combine(date_cls.fromisoformat(effective_from),
                                datetime.min.time())
        if want > at:
            at = want
    return at.isoformat(), storage.effective_date_for(at)


@app.route('/api/accountability/nodes/<int:id>/disable', methods=['PATCH'])
def disable_accountability_node(id):
    data = request.get_json(silent=True) or {}
    effective_from = data.get('effective_from') or None
    if effective_from and not _YMD_RE.match(effective_from):
        return jsonify({'error': 'effective_from must be YYYY-MM-DD'}), 400
    at, effective = _gate_landing(effective_from, eases=True)
    storage.qr_cancel_pending_change(id, 'active')
    storage.qr_add_pending_change(id, 'active', '0', at, effective)
    return jsonify({'pending': True, 'apply_at': at, 'effective_date': effective})


# Calling a queued change off. Nothing was applied, so there is nothing to put
# back — cancelling is the gate staying exactly as it is, which is the tighter
# direction and therefore always immediate.
@app.route('/api/accountability/nodes/<int:id>/pending/<field>', methods=['DELETE'])
def cancel_accountability_pending(id, field):
    storage.qr_cancel_pending_change(id, field)
    return jsonify(storage.qr_get_pending_changes(id))


@app.route('/api/accountability/nodes/<int:id>/activate', methods=['PATCH'])
def activate_accountability_node(id):
    # Only cancels a PENDING disable inside its 24h window. A node that has
    # already gone inactive stays inactive — re-activating instantly would let
    # you park a commitment and resume it once the awkward day had passed.
    # A queued DELETION is called off too: keeping the gate is the same intent,
    # and tightening (here, staying committed) always applies at once.
    storage.qr_cancel_pending_change(id, 'active')
    storage.qr_cancel_pending_change(id, storage.QR_DELETE_FIELD)
    return jsonify({'ok': True})


@app.route('/api/locations', methods=['GET', 'POST'])
def locations():
    if request.method == 'POST':
        data = request.get_json()
        result = storage.create_location(
            data['name'], data['lat'], data['lng'], data.get('radius_m') or 150,
            active=0 if data.get('active') == 0 else 1)
        return jsonify(result), 201
    return jsonify(storage.get_locations())


# ARRIVAL — the cue the app could never give itself.
#
# The phone knows one thing this server cannot: that you just walked in. It
# sends that and nothing else; the message is composed HERE, from live data, at
# the moment it is sent. That is the whole reason this design has no ledger and
# no reconcile — nothing is ever copied onto the device, so nothing on the
# device can go stale, and a notification cannot name an errand already done.
#
# Deliberately NOT a write: an arrival changes no row. It reads, and it may
# send. Nothing about the day is recorded, which is also why no location
# history accumulates — see the design doc; storing the stream was rejected.
#
# Sent once per (place, day) unless the item set CHANGES. The memo is in
# memory, not a table: losing it on restart costs one duplicate notification,
# which is not worth a migration or a daybook classification.
_arrival_sent = {}


def _resolve_arrival(data):
    # Three ways in, because the phone app decides which it can offer.
    # OwnTracks sends a region transition whose `desc` is the waypoint name,
    # so name-matching is the path that needs no ids on the device.
    locs = storage.get_locations()
    if data.get('location_id') is not None:
        return next((l for l in locs if l['id'] == data['location_id']), None)
    name = (data.get('desc') or data.get('name') or '').strip().lower()
    if name:
        return next((l for l in locs if (l['name'] or '').strip().lower() == name), None)
    try:
        lat, lng = float(data['lat']), float(data.get('lon', data.get('lng')))
    except (KeyError, TypeError, ValueError):
        return None
    # Nearest whose radius actually contains the fix — never merely nearest,
    # which would fire at a place you drove past.
    best = None
    for l in locs:
        d = _haversine_m(lat, lng, l['lat'], l['lng'])
        if d <= (l['radius_m'] or 150) and (best is None or d < best[0]):
            best = (d, l)
    return best[1] if best else None


def _haversine_m(a_lat, a_lng, b_lat, b_lng):
    import math
    R = 6371000.0
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


@app.route('/api/arrival', methods=['POST'])
def post_arrival():
    data = request.get_json(silent=True) or {}

    # EVERY CONTACT LEAVES A MARK, whatever happens to it. `arrival_last` is
    # only written once a place has RESOLVED, so a rejected token and a phone
    # that never called look identical from Settings — which is exactly the
    # question being asked while setting the phone up. This answers it:
    #   (nothing)  the phone has never reached this server
    #   REJECTED   it is calling, and the token is wrong
    #   ping       it is calling and authenticated — the URL works — but has
    #              not crossed a region yet
    #   leave      it is sending transitions; you left rather than arrived
    # Never records the token, only the shape of what arrived.
    def seen(note):
        storage.set_setting('arrival_last_seen',
                            f'{datetime.now().isoformat(timespec="seconds")} {note}')

    want = (config.get('arrival_token') or '').strip()
    if not want:
        seen('REJECTED - arrival_token is not set on the server')
        return jsonify({'error': 'arrival_token is not set'}), 503
    # THREE PLACES, because the caller does not control all of them.
    # OwnTracks' URL field is documented as http[s]://[user[:password]@]host,
    # so the token can ride as the Basic-auth PASSWORD — and that is the form
    # to prefer: Werkzeug logs the request line, so a token in the query string
    # ends up in the access log, while an Authorization header does not. The
    # query string still works, for curl and for anything that cannot do Basic.
    auth = request.authorization
    sent = (data.get('token') or request.args.get('token')
            or (auth.password if auth and auth.password else '') or '').strip()
    if sent != want:
        seen('REJECTED - bad token' + ('' if sent else ' (none sent)'))
        return jsonify({'error': 'bad token'}), 403
    # ONLY A TRANSITION IS AN ARRIVAL. OwnTracks HTTP mode posts EVERY location
    # update to this one URL — `_type: location` pings, several a minute while
    # moving — and those carry a lat/lon that would resolve to whatever region
    # you are standing in. Without this guard the fix that told us you arrived
    # would keep telling us, and the dedup memo would be the only thing between
    # you and a notification per ping. A payload that names its type must say
    # `transition`; one that names none is a hand-made call and is trusted.
    kind = (data.get('_type') or '').strip().lower()
    if kind and kind != 'transition':
        seen(f'ping ({kind}) - authenticated, no region crossed yet')
        return '', 204
    # A geofence app sends enter AND leave. Only arriving is a cue; leaving is
    # accepted so the phone need not be taught to withhold it.
    event = (data.get('event') or 'enter').strip().lower()
    if event != 'enter':
        seen(f'{event} {data.get("desc") or ""}'.strip())
        return '', 204
    seen(f'enter {data.get("desc") or "(by coordinates)"}')
    loc = _resolve_arrival(data)
    if not loc:
        storage.set_setting('arrival_last', f'{datetime.now().isoformat(timespec="seconds")} '
                                            f'unknown place')
        return jsonify({'error': 'no matching location'}), 404
    today = date_cls.today().isoformat()
    items = storage.items_at_location(loc['id'], today)
    storage.set_setting('arrival_last',
                        f'{datetime.now().isoformat(timespec="seconds")} '
                        f'{loc["name"]} — {len(items)} live')
    if not items:
        return '', 204                      # arriving with nothing to do is silent
    key = (loc['id'], today)
    stamp = tuple(sorted(i['id'] for i in items))
    if _arrival_sent.get(key) == stamp:
        return '', 204                      # same place, same day, same items
    _arrival_sent[key] = stamp

    lines = [i['content'] for i in items[:5]]
    if len(items) > 5:
        lines.append(f'+{len(items) - 5} more')
    message = '\n'.join(lines)
    if not (config.get('notify_live') or '').strip():
        storage.set_setting('arrival_last_send',
                            f'{datetime.now().isoformat(timespec="seconds")} DRY RUN '
                            f'{loc["name"]}: {len(items)} item(s)')
        return jsonify({'dry_run': True, 'location': loc['name'], 'items': len(items),
                        'message': message}), 200
    try:
        aggregator.notify(
            config.get('notify_kind', 'ntfy'), config.get('notify_url', ''), message,
            title=loc['name'], token=config.get('notify_token'),
            user=config.get('notify_user'))
        storage.set_setting('arrival_last_send',
                            f'{datetime.now().isoformat(timespec="seconds")} sent '
                            f'{loc["name"]}: {len(items)} item(s)')
    except Exception as e:
        # LOUD. Silence is what success looks like here too, so a swallowed
        # failure is indistinguishable from a quiet day.
        _arrival_sent.pop(key, None)         # let the next arrival retry
        storage.set_setting('arrival_last_send',
                            f'{datetime.now().isoformat(timespec="seconds")} FAILED '
                            f'{loc["name"]}: {e}')
        print(f'arrival: send failed for {loc["name"]}: {e}')
        return jsonify({'error': f'send failed: {e}'}), 502
    return '', 204


# THE REGIONS, SERVED. This is what stops the phone being hand-wired: adding a
# location in Settings makes it live everywhere, instead of one geofence typed
# into the device per place.
#
# OwnTracks' waypoint shape. `tst` is the waypoint's IDENTITY on import — reuse
# it and the app updates that region, change it and you get a duplicate — so it
# has to be stable per location and cannot be "now". The location id is the
# stable identity we have, offset into plausible-timestamp range; nothing reads
# the date back, only the sameness.
#
# PAUSED LOCATIONS ARE INCLUDED, deliberately. "Just this once" pauses a place
# so the pickers stop offering it, never so its geofence stops working — that
# distinction is the whole point of a one-off address, and dropping them here
# would silently break exactly the errands this feature exists for.
WAYPOINT_TST_BASE = 1750000000


@app.route('/api/locations/waypoints')
def get_location_waypoints():
    want = (config.get('arrival_token') or '').strip()
    if not want:
        return jsonify({'error': 'arrival_token is not set'}), 503
    auth = request.authorization
    sent = ((request.args.get('token') or '')
            or (auth.password if auth and auth.password else '')).strip()
    if sent != want:
        # These are home addresses. Same secret as the arrivals they enable.
        return jsonify({'error': 'bad token'}), 403
    return jsonify({
        '_type': 'waypoints',
        'waypoints': [{
            '_type': 'waypoint',
            'desc': l['name'],
            'lat': l['lat'],
            'lon': l['lng'],
            'rad': l['radius_m'] or 150,
            'tst': WAYPOINT_TST_BASE + l['id'],
        } for l in storage.get_locations()],
    })


# ONE TAP INSTEAD OF A MENU HUNT. OwnTracks' own iOS setup docs are unwritten
# ("FIXME: configure the iOS app"), and its settings live behind an unlabelled
# icon — so configuring it by hand means guessing at an interface. A .otrc
# config file sidesteps all of it: open this URL on the phone and iOS offers to
# hand the file to OwnTracks, which imports the mode, the endpoint and every
# region in one go.
#
# mode 3 is HTTP (0 is MQTT) — from OwnTracks' JSON reference, not guessed.
#
# The URL is built from the request's OWN host, so whatever address the phone
# reached this on is the address it will post back to. Hard-coding a tailnet IP
# here would break the moment it is opened from anywhere else.
#
# The token is embedded as the Basic-auth password, which is both what keeps it
# out of the access log and what makes this file a SECRET: it is the whole
# credential. Served as an attachment so Safari treats it as a file to open
# rather than text to display.
OWNTRACKS_MODE_HTTP = 3


def _owntracks_config(token, req):
    # ONE builder for both delivery routes, so the file you download and the
    # link you tap can never describe different endpoints.
    scheme = req.headers.get('X-Forwarded-Proto') or req.scheme
    return {
        '_type': 'configuration',
        'mode': OWNTRACKS_MODE_HTTP,
        'url': f'{scheme}://qpa:{token}@{req.host}/api/arrival',
        'waypoints': [{
            '_type': 'waypoint',
            'desc': l['name'],
            'lat': l['lat'],
            'lon': l['lng'],
            'rad': l['radius_m'] or 150,
            'tst': WAYPOINT_TST_BASE + l['id'],
        } for l in storage.get_locations()],
    }


@app.route('/api/owntracks/config')
def get_owntracks_config():
    want = (config.get('arrival_token') or '').strip()
    if not want:
        return jsonify({'error': 'arrival_token is not set'}), 503
    auth = request.authorization
    sent = ((request.args.get('token') or '')
            or (auth.password if auth and auth.password else '')).strip()
    if sent != want:
        return jsonify({'error': 'bad token'}), 403
    payload = _owntracks_config(want, request)
    return app.response_class(
        json.dumps(payload, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename="owntracks.otrc"'})


# THE SAME CONFIG, HANDED STRAIGHT TO THE APP. The .otrc download above relies
# on Safari saving a file and iOS offering to open it with OwnTracks, and that
# hand-off failed in practice ("URI or file config not found"). OwnTracks
# documents exactly one alternative — owntracks:///config?inline=<base64> — and
# no remote-fetch parameter, so the config has to travel INSIDE the link.
#
# A 302 to that scheme is what makes it one tap: Safari follows the redirect
# and iOS hands the payload to the app. No file, no Files.app, no menu.
#
# This is a REDIRECT, not a page — the JSON-only rule is untouched.
@app.route('/api/owntracks/install')
def get_owntracks_install():
    want = (config.get('arrival_token') or '').strip()
    if not want:
        return jsonify({'error': 'arrival_token is not set'}), 503
    if (request.args.get('token') or '').strip() != want:
        return jsonify({'error': 'bad token'}), 403
    blob = json.dumps(_owntracks_config(want, request)).encode('utf-8')
    b64 = base64.b64encode(blob).decode('ascii')
    # Percent-encoded: raw base64 contains + and =, and a + in a query string
    # decodes as a SPACE, which would corrupt the payload for some fraction of
    # configs and look like a mystery parse failure.
    # The Location header is set BY HAND. flask.redirect() runs the target
    # through Werkzeug's URL normaliser, which rewrites owntracks:///config to
    # owntracks:/config — three slashes to one. OwnTracks documents the triple
    # form, and a scheme handler that does not match is exactly how this
    # surfaces: "URI or file config not found".
    target = 'owntracks:///config?inline=' + urllib.parse.quote(b64, safe='')
    resp = app.response_class(status=302)
    resp.headers['Location'] = target
    return resp


@app.route('/api/locations/<int:id>/items')
def get_location_items(id):
    # What is live AT a place. Read-only, and the answer an arrival will be
    # composed from — so the notification never restates a copy held anywhere
    # else, it asks this.
    return jsonify(storage.items_at_location(id, request.args.get('date')))


# ADDRESS IN, COORDINATES OUT. Typing a latitude by hand is the friction that
# kept one-off places out of the system entirely, so the geocoder exists to
# make creating a location cost one search instead of a map lookup.
#
# READ-ONLY: it returns candidates and writes nothing. Picking one is a
# separate POST, because deciding a place exists is a decision.
@app.route('/api/geocode')
def get_geocode():
    q = (request.args.get('q') or '').strip()
    if not q:
        return jsonify([])
    try:
        return jsonify(aggregator.geocode(q, config.get('geocode_user_agent', '')))
    except ValueError as e:
        # Not set up yet — a 400 the UI can SAY, rather than an empty list that
        # would read as "no such address".
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': f'lookup failed: {e}'}), 502


# --- Interactive routines (flows) ---
#
# There is no routine push any more (2026-08-11). The gate is enforced where the
# database is, by storage.routine_gate_for_node in qr_judge — so linking a
# routine is a local write and nothing has to be told about it.

@app.route('/api/flows')
def get_flows_route():
    date = request.args.get('date') or date_cls.today().isoformat()
    return jsonify(storage.get_flows(date))


@app.route('/api/flows', methods=['POST'])
def post_flow():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.create_flow(name)), 201


@app.route('/api/flows/<int:id>', methods=['PATCH'])
def patch_flow(id):
    data = request.get_json()
    _s = object()
    kwargs = {}
    if 'name' in data:
        kwargs['name'] = data['name']
    if 'qr_node_id' in data:
        kwargs['qr_node_id'] = data['qr_node_id']
    if 'offset_min' in data:
        kwargs['offset_min'] = data['offset_min']
    if 'before_node_id' in data:
        kwargs['before_node_id'] = data['before_node_id']
    if 'source_uid' in data:
        kwargs['source_uid'] = data['source_uid']
    for f in ('as_task', 'days_of_week', 'area_id', 'period'):
        if f in data:
            kwargs[f] = data[f]
    try:
        flow = storage.update_flow(id, **kwargs)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(flow)


# PUT IT IN THE POOL NOW (2026-08-25, asked for). A routine that is also a task
# appears on the days its schedule says; this is the explicit "I want it today"
# — the same seeding, the same ledger, one action per period either way. No date
# default to argue about: the client sends the day it is looking at.
@app.route('/api/flows/<int:id>/seed-task', methods=['POST'])
def post_flow_seed_task(id):
    d = request.get_json(silent=True) or {}
    ymd = d.get('date')
    if ymd and not _YMD_RE.match(ymd):
        return jsonify({'error': 'date must be YYYY-MM-DD'}), 400
    item = storage.seed_flow_task_now(id, ymd)
    if not item:
        return jsonify({'error': 'it is already in the pool, or this period is '
                                 'already finished'}), 409
    return jsonify(item), 201


@app.route('/api/flows/<int:id>', methods=['DELETE'])
def delete_flow_route(id):
    # A gated routine's deletion is an easing and comes back deferred, in the
    # same shape the step-delete route uses.
    apply_at = storage.delete_flow(id)
    if apply_at:
        return jsonify({'pending': True, 'apply_at': apply_at})
    return '', 204


@app.route('/api/flows/<int:id>/steps', methods=['POST'])
def post_flow_step(id):
    data = request.get_json()
    content = (data.get('content') or '').strip()
    if not content and data.get('kind', 'text') == 'text':
        return jsonify({'error': 'content is required'}), 400
    return jsonify(storage.create_flow_step(
        id, content, data.get('kind', 'text'), data.get('requirement', 'hard'),
        data.get('days_of_week'), data.get('duration_min'))), 201


@app.route('/api/flow-steps/<int:id>', methods=['PATCH'])
def patch_flow_step(id):
    data = request.get_json()
    return jsonify(storage.update_flow_step(
        id, content=data.get('content'), kind=data.get('kind'),
        requirement=data.get('requirement'), position=data.get('position'),
        days_of_week=data.get('days_of_week', storage._UNSET),
        rrule=data.get('rrule', storage._UNSET),
        pawn_to_flow_id=data.get('pawn_to_flow_id', storage._UNSET),
        pawn_minutes=data.get('pawn_minutes', storage._UNSET),
        soft_content=data.get('soft_content', storage._UNSET),
        ref_list_id=data.get('ref_list_id', storage._UNSET),
        duration_min=data.get('duration_min', storage._UNSET)))


# Pawning is a DAY-level act, not a config edit, so it is its own route rather
# than a field on the PATCH above: pushing a step onto tonight's routine should
# never be reachable by accident from a form that edits the routine itself.
@app.route('/api/flow-steps/<int:id>/pawn', methods=['POST', 'DELETE'])
def pawn_flow_step_route(id):
    try:
        # The DAY comes from the runner's pinned run-day, not this process's
        # wall clock: a run opened at 23:50 and continued past midnight would
        # otherwise stamp pawned_date with the NEW day — the step never arrives
        # in tonight's receiving routine, tonight's gate is not shortened, and
        # TOMORROW's deadline silently moves earlier for debt incurred tonight.
        body = request.get_json(silent=True) or {}
        step = storage.pawn_flow_step(id, on=request.method == 'POST',
                                      date=body.get('date') or request.args.get('date'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if step is None:
        return jsonify({'error': 'unknown step'}), 404
    return jsonify(step)


@app.route('/api/flow-steps/<int:id>', methods=['DELETE'])
def delete_flow_step_route(id):
    # {'pending': True} = the 24h easing gate deferred it (gated routine).
    return jsonify(storage.delete_flow_step(id))


@app.route('/api/flow-steps/<int:id>/pending', methods=['DELETE'])
def cancel_flow_step_pending_route(id):
    return jsonify(storage.cancel_flow_step_pending(id) or {})


@app.route('/api/flows/<int:id>/pending', methods=['DELETE'])
def cancel_flow_pending_route(id):
    return jsonify(storage.cancel_flow_pending(id, request.args.get('field')) or {})


@app.route('/api/flows/<int:id>/run', methods=['PUT'])
def put_flow_run(id):
    data = request.get_json()
    date = data.get('date') or date_cls.today().isoformat()
    # The client sends the DAY it is on; which run that day belongs to is the
    # flow's business (a weekly routine files under its Monday). Normalising
    # here means no caller has to know the rule.
    date = storage.flow_period_key_for(id, date)
    steps = data.get('steps') or {}
    # The client's `completed` is a request, not a verdict — a gate can hang on
    # it, so the server re-checks today's steps and every hard metrics step.
    completed = bool(data.get('completed')) and storage.run_completion_ok(id, date, steps)
    run = storage.upsert_flow_run(id, date, json.dumps(steps), completed)
    return jsonify(run)


# --- Schedules: the one occurrence source (schedule.py) ------
#
# One collection for all three constructors — the picker decides which by what
# was answered, so the route never asks. `?date=` adds each source's wall-clock
# intervals for that day, which is the half the client can evaluate itself.

_SOURCE_FIELDS = ('title', 'start', 'duration', 'recurrenceRules',
                  'overrides', 'entries', 'follows', 'ends')


def _with_label(row):
    if not row:
        return row
    resolve, _ = storage.schedule_resolver()
    try:
        row['label'] = schedule.describe(resolve(row['uid']), resolve)
    except schedule.Cycle:
        row['label'] = 'broken: this schedule refers to itself'
    return row


@app.route('/api/schedules')
def get_schedules_route():
    return jsonify(storage.get_schedule_sources(
        request.args.get('date'),
        include_unnamed=request.args.get('unnamed') == '1'))


@app.route('/api/schedules', methods=['POST'])
def post_schedule():
    data = request.get_json()
    kind = data.get('kind')
    if kind not in schedule.KINDS:
        return jsonify({'error': 'kind must be rule, schedule or derived'}), 400
    fields = {k: data[k] for k in _SOURCE_FIELDS if k in data}
    try:
        return jsonify(_with_label(storage.create_schedule_source(kind, **fields))), 201
    except schedule.Cycle as e:
        return jsonify({'error': f'that would make {e} contain itself'}), 400


@app.route('/api/schedules/<uid>', methods=['PATCH'])
def patch_schedule(uid):
    data = request.get_json()
    fields = {k: data[k] for k in _SOURCE_FIELDS if k in data}
    if data.get('kind') in schedule.KINDS:
        fields['kind'] = data['kind']
    try:
        row = storage.update_schedule_source(uid, **fields)
    except schedule.Cycle as e:
        return jsonify({'error': f'that would make {e} contain itself'}), 400
    return jsonify(_with_label(row)) if row else ('', 404)


@app.route('/api/schedules/<uid>', methods=['DELETE'])
def delete_schedule(uid):
    # Always allowed: every holder keeps an unnamed copy of the hours, so this
    # un-shares rather than removes. See storage.delete_schedule_source.
    storage.delete_schedule_source(uid)
    return '', 204


# --- Context bindings: tag→time, tag→device -----------------

@app.route('/api/tag-times')
def get_tag_times_route():
    return jsonify(storage.get_tag_times())


@app.route('/api/tag-times', methods=['POST'])
def post_tag_time():
    data = request.get_json()
    tag = (data.get('tag') or '').strip().lower()
    if not tag or not data.get('source_uid'):
        return jsonify({'error': 'tag and source_uid are required'}), 400
    storage.set_tag_time(tag, data['source_uid'])
    return jsonify(storage.get_tag_times()), 201


@app.route('/api/tag-times/<tag>', methods=['DELETE'])
def delete_tag_time_route(tag):
    storage.delete_tag_time(tag)
    return '', 204


# Which tags get asked about each morning, and today's answers. One GET so the
# client needs a single round trip for both halves of the gate.
@app.route('/api/tag-daily')
def get_tag_daily_route():
    date = request.args.get('date') or date_cls.today().isoformat()
    return jsonify({'tags': storage.get_tag_daily(), 'answers': storage.get_tag_day(date)})


@app.route('/api/tag-daily', methods=['POST'])
def post_tag_daily():
    data = request.get_json() or {}
    tag = (data.get('tag') or '').strip().lower()
    if not tag:
        return jsonify({'error': 'tag is required'}), 400
    storage.set_tag_daily(tag, bool(data.get('on', True)))
    return jsonify({'tags': storage.get_tag_daily()}), 201


@app.route('/api/tag-daily/answer', methods=['POST'])
def post_tag_day():
    data = request.get_json() or {}
    tag = (data.get('tag') or '').strip().lower()
    if not tag:
        return jsonify({'error': 'tag is required'}), 400
    date = data.get('date') or date_cls.today().isoformat()
    # applies=null CLEARS the answer, which is what an undo replays — back to
    # unanswered, which excludes nothing.
    return jsonify(storage.set_tag_day(tag, date, data.get('applies')))


@app.route('/api/tag-devices')
def get_tag_devices_route():
    return jsonify(storage.get_tag_devices())


@app.route('/api/tag-devices', methods=['POST'])
def post_tag_device():
    data = request.get_json()
    tag = (data.get('tag') or '').strip().lower()
    device = (data.get('device') or '').strip().lower()
    if not tag or device not in ('pc', 'phone'):
        return jsonify({'error': 'tag and device (pc|phone) are required'}), 400
    storage.set_tag_device(tag, device)
    return jsonify(storage.get_tag_devices()), 201


@app.route('/api/tag-devices/<tag>', methods=['DELETE'])
def delete_tag_device_route(tag):
    storage.delete_tag_device(tag)
    return '', 204


@app.route('/api/tag-locations')
def get_tag_locations_route():
    return jsonify(storage.get_tag_locations())


@app.route('/api/tag-locations', methods=['POST'])
def post_tag_location():
    data = request.get_json()
    tag = (data.get('tag') or '').strip().lower()
    if not tag or not data.get('location_id'):
        return jsonify({'error': 'tag and location_id are required'}), 400
    storage.set_tag_location(tag, data['location_id'])
    return jsonify(storage.get_tag_locations()), 201


@app.route('/api/tag-locations/<tag>', methods=['DELETE'])
def delete_tag_location_route(tag):
    storage.delete_tag_location(tag)
    return '', 204


@app.route('/api/locations/<int:id>', methods=['PATCH'])
def patch_location(id):
    # Rename and pause, the same two verbs every other settings item has. The
    # coordinates are deliberately not patchable — see storage.update_location.
    data = request.get_json() or {}
    name = None
    if 'name' in data:
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name is required'}), 400
    active = data.get('active') if 'active' in data else None
    if name is None and active is None:
        return jsonify({'error': 'name or active is required'}), 400
    row = storage.update_location(id, name, active)
    if row is None:
        return jsonify({'error': 'unknown location'}), 404
    return jsonify(row)


@app.route('/api/locations/<int:id>', methods=['DELETE'])
def delete_location(id):
    storage.delete_location(id)
    return jsonify({'ok': True})


# ── The tags a gate accepts ────────────────────────────────
#
# A tag belongs to ONE gate and a gate may have several (Quentin, 2026-08-19).
# Everything here obeys the same 24h rule the gate's own fields do, in the same
# store: a tag going LIVE is a new way to clear the gate, so on a tag-only gate
# it waits; pausing or deleting one is tightening and lands at once.
@app.route('/api/accountability/nodes/<int:id>/tags', methods=['POST'])
def post_accountability_tag(id):
    node = next((n for n in storage.qr_get_nodes() if n['id'] == id), None)
    if not node:
        return jsonify({'error': 'unknown node'}), 404
    d = request.get_json() or {}
    uid = re.sub(r'[^0-9A-Fa-f]', '', str(d.get('uid') or '')).upper()
    if len(uid) != 14:
        return jsonify({'error': 'the UID is 7 bytes — 14 hex characters'}), 400
    label = (d.get('label') or '').strip() or ('Tag ' + uid[-4:])
    # A LIVE tag on a tag-only gate waits its 24h, so it is created paused with
    # the easing queued. On a link gate there is nothing to ease: the gate is
    # already clearable by link, and the tag only makes the evidence stronger.
    hard = (node.get('proof_mode') or 'link') == 'tag'
    tag = storage.qr_add_tag(id, label, uid, active=0 if hard else 1)
    if not tag:
        return jsonify({'error': 'that UID already belongs to a gate'}), 409
    if hard:
        tag['pending_live_at'] = storage.qr_pend_tag_live(tag['id'])
    tag['keys_set'] = uid in ntag.load_keys()
    return jsonify(tag), 201


@app.route('/api/accountability/tags/<int:tag_id>', methods=['PATCH', 'DELETE'])
def patch_accountability_tag(tag_id):
    tag = next((t for t in storage.qr_all_tags() if t['id'] == tag_id), None)
    if not tag:
        return jsonify({'error': 'unknown tag'}), 404
    hard = (tag.get('proof_mode') or 'link') == 'tag'
    others = [t for t in storage.qr_tags_for_node(tag['node_id'], active_only=True)
              if t['id'] != tag_id and t['uid'].upper() in ntag.load_keys()]

    if request.method == 'DELETE':
        # The last live tag of a tag-only gate cannot go: the gate would charge
        # for a day nothing could have cleared. Named in words, with the two
        # ways out, rather than silently loosening the gate to link proof.
        if hard and not others:
            return jsonify({'error': 'this is the only tag that can clear ' + tag['node_label']
                                     + ' — move the gate to link proof, or pause the gate '
                                       'first'}), 400
        storage.qr_delete_tag(tag_id)
        return jsonify({'ok': True})

    d = request.get_json(silent=True) or {}
    fields = {}
    if 'label' in d:
        label = (d.get('label') or '').strip()
        if not label:
            return jsonify({'error': 'a tag needs a name'}), 400
        fields['label'] = label
    if 'active' in d:
        want = 0 if storage.falsy(d.get('active')) else 1
        if want and not tag['active']:
            # Waking a tag up is the loosening — the same 24h a new one waits.
            if hard:
                return jsonify({'pending': True,
                                'apply_at': storage.qr_pend_tag_live(tag_id)})
            fields['active'] = 1
        elif not want and tag['active']:
            if hard and not others:
                return jsonify({'error': 'this is the only tag that can clear '
                                         + tag['node_label'] + ' — pausing it would '
                                         'make the gate impossible to clear'}), 400
            storage.qr_unpend_tag(tag_id)      # a queued wake-up is off
            fields['active'] = 0
    if not fields:
        return jsonify(tag)
    return jsonify(storage.qr_update_tag(tag_id, fields))


@app.route('/api/accountability/tags/<int:tag_id>/keys', methods=['PUT'])
def put_accountability_tag_keys(tag_id):
    """The tag's two AES keys — WRITE ONLY, and not into the database.

    They go to config.json beside the Beeminder token, for the same reason: the
    db is dumped into backups/ and pushed, so a key in the db is a key in git.
    Merged per tag rather than replacing the object, so entering the second
    tag's keys cannot wipe the first's — which is also why this is its own door
    instead of an entry in CONFIG_KEYS (a write-only blob nothing can read back
    cannot be edited one tag at a time).
    """
    tag = next((t for t in storage.qr_all_tags() if t['id'] == tag_id), None)
    if not tag:
        return jsonify({'error': 'unknown tag'}), 404
    d = request.get_json() or {}
    pair = {}
    for name, field in (('meta', 'meta'), ('mac', 'mac')):
        raw = re.sub(r'[^0-9A-Fa-f]', '', str(d.get(field) or ''))
        if len(raw) != 32:
            return jsonify({'error': 'the ' + name + ' key is 16 bytes — '
                                     '32 hex characters'}), 400
        pair[field] = raw.upper()
    keys = dict(_config_file().get('ntag_keys') or {})
    keys[tag['uid'].upper()] = pair
    _update_config({'ntag_keys': keys})
    return jsonify({'ok': True, 'keys_set': True})


@app.route('/api/accountability/tags/<int:tag_id>/keys', methods=['DELETE'])
def delete_accountability_tag_keys(tag_id):
    tag = next((t for t in storage.qr_all_tags() if t['id'] == tag_id), None)
    if not tag:
        return jsonify({'error': 'unknown tag'}), 404
    if (tag.get('proof_mode') or 'link') == 'tag':
        others = [t for t in storage.qr_tags_for_node(tag['node_id'], active_only=True)
                  if t['id'] != tag_id and t['uid'].upper() in ntag.load_keys()]
        if not others:
            return jsonify({'error': 'clearing these keys would leave '
                                     + tag['node_label'] + ' with no way to be '
                                     'cleared'}), 400
    keys = dict(_config_file().get('ntag_keys') or {})
    keys.pop(tag['uid'].upper(), None)
    _update_config({'ntag_keys': keys})
    return jsonify({'ok': True, 'keys_set': False})


@app.route('/api/accountability/nodes/<int:id>/taps')
def accountability_node_taps(id):
    """DID THE TAP LAND — the last few, refused ones included.

    A READ, and only a read. It exists because the tap is the one part of a
    hard gate that happens away from the app: you hold a phone to a tag and
    the app has nothing to say about it unless the tap verified. Refusals now
    have somewhere to live (qr_tap_attempt), so this serves both halves in one
    list, newest first, with the reason attached.

    Nothing here is a judgment. The judge reads qr_scan and has never heard of
    this table — a refusal that could reach the money path is a refusal that
    could clear a gate.
    """
    if not any(n['id'] == id for n in storage.qr_get_nodes()):
        return jsonify({'error': 'unknown gate'}), 404
    out = []
    for t in storage.qr_recent_taps(id):
        out.append(dict(t, at=_scan_local_hhmm(t['tapped_at'], '%m-%d %H:%M')))
    return jsonify(out)


@app.route('/api/accountability/nodes/<int:id>/overrides', methods=['POST'])
def post_accountability_override(id):
    d = request.get_json() or {}
    date = d.get('date', '')
    nodes = {n['id']: n for n in storage.qr_get_nodes()}
    if id not in nodes or not _YMD_RE.match(date):
        return jsonify({'error': 'unknown node or bad date'}), 400
    node = nodes[id]

    # CALLING THE DAY OFF is a day-level statement, so it is made here — on the
    # gate's day surface — and not with the view-only dismissal the timeline
    # hands blocks and events. Those have no money path; this one does, and a
    # gesture that hid the pill without telling the judge left the day charging
    # while the calendar said it was gone.
    #
    # The window is RESOLVED SERVER-SIDE and stamped onto the row: the client
    # does not get to say which window it is calling off, and the row records
    # what was actually skipped. A skip on a day that already carries a dragged
    # window keeps that window, because resolve_window reads the override first.
    if 'skipped' in d:
        want = bool(d['skipped'])
        # Skipping LOOSENS — same 24h lock the drag takes, so tonight's gate
        # cannot be dodged tonight. Un-skipping re-commits the day, which is a
        # tightening, and tightening is always allowed to land at once. It
        # cannot reach backwards either: a day the judge has already frozen as
        # 'n/a' stays 'n/a' (qr_judgment_exists), so re-committing a past day
        # is inert rather than retroactively chargeable.
        if want and qr_judge.override_locked(node, date):
            return jsonify({'error': 'Locked — deadline within 24h'}), 403
        w = qr_judge.resolve_window(node, date)
        storage.qr_set_override(id, date, w[0], w[1], w[2], skipped=want)
        return jsonify({'ok': True, 'skipped': want})

    if qr_judge.override_locked(node, date):
        return jsonify({'error': 'Locked — deadline within 24h'}), 403
    offset = d.get('window_end_offset_days') or 0
    # A deadline dragged above its own opening is an unsatisfiable gate — the
    # window would be empty and every day would judge absent. Same clamp the
    # pawn shortening uses: never past the opening. (The drag is bounded client
    # side too; this is the lock on the money path.)
    if qr_judge._hhmm_min(d['window_end']) + offset * 1440 < qr_judge._hhmm_min(d['window_start']):
        return jsonify({'error': 'A deadline cannot come before the window opens'}), 400
    storage.qr_set_override(id, date, d['window_start'], d['window_end'], offset)
    return jsonify({'ok': True})


@app.route('/api/accountability/nodes/<int:id>/overrides/<date>', methods=['DELETE'])
def delete_accountability_override(id, date):
    nodes = {n['id']: n for n in storage.qr_get_nodes()}
    if id not in nodes or not _YMD_RE.match(date):
        return jsonify({'error': 'unknown node or bad date'}), 400
    # Removal is gated too: dropping an override that made a day HARDER would
    # otherwise be a loophole back to the slacker default. A SKIPPED day is the
    # one exception — deleting that row puts the gate back on duty, which is a
    # tightening, and refusing it would be refusing to re-commit.
    existing = storage.qr_get_override(id, date)
    if not (existing and existing.get('skipped'))             and qr_judge.override_locked(nodes[id], date):
        return jsonify({'error': 'Locked — deadline within 24h'}), 403
    storage.qr_delete_override(id, date)
    return jsonify({'ok': True})


# --- People CRM ---

@app.route('/api/people')
def get_people():
    include_archived = request.args.get('include_archived') == '1'
    return jsonify(storage.get_people(include_archived))


@app.route('/api/people', methods=['POST'])
def post_person():
    data = request.get_json()
    if not data.get('name'):
        return jsonify({'error': 'name is required'}), 400
    # A name that already exists is a LOG, not a new contact. The client
    # resolves this itself; 409 is the backstop for the paths that can't (a
    # stale people list, the phone). It hands back the person so the caller can
    # go log to them instead of guessing. `allow_duplicate` is the deliberate
    # escape for two genuinely different people with one name.
    if not data.get('allow_duplicate'):
        existing = storage.find_person_by_name(data['name'])
        if existing:
            return jsonify({'error': 'exists', 'person': existing}), 409
    return jsonify(storage.create_person(data)), 201


@app.route('/api/people/<int:id>', methods=['PATCH'])
def patch_person(id):
    data = request.get_json()
    if 'name' in data and not (data.get('name') or '').strip():
        return jsonify({'error': 'name cannot be blank'}), 400
    return jsonify(storage.update_person(id, data))


@app.route('/api/people/<int:id>', methods=['DELETE'])
def delete_person(id):
    storage.delete_person(id)
    return '', 204


@app.route('/api/people/<int:id>/interactions', methods=['POST'])
def post_person_interaction(id):
    data = request.get_json()
    if not data.get('date'):
        return jsonify({'error': 'date is required'}), 400
    return jsonify(storage.add_interaction(id, data)), 201


@app.route('/api/people/<int:id>/skip-cycle', methods=['POST'])
def post_person_skip_cycle(id):
    return jsonify(storage.skip_cycle(id))


@app.route('/api/people/night', methods=['GET', 'POST'])
def post_people_night():
    if request.method == 'GET':
        # Was tonight's fill recorded? The routine runner asks, so its CRM step
        # can state the fact instead of asking you to attest to it.
        date = request.args.get('date') or date_cls.today().isoformat()
        return jsonify(storage.get_crm_night(date) or {})
    data = request.get_json()
    if not data or not data.get('date') or not data.get('kind'):
        return jsonify({'error': 'date and kind required'}), 400
    # The Worker push that used to follow this went with the Worker itself
    # (2026-08-11), but the CALL was left behind — so every nightly fill wrote
    # its row and then answered 500 on a NameError, which only the client's
    # .catch() hid. There is nothing to notify any more: the row IS the record.
    return jsonify(storage.record_crm_night(data['date'], data['kind']))


# The sleep-QR scan opens a 30-minute fill window: find the most recent scan of
# the configured sleep node and count 30 min from it. Test override:
# settings.people_window_override_until (ISO). No config -> always closed.
def _people_window():
    now = datetime.now(timezone.utc)
    settings = storage.get_settings()
    ov = settings.get('people_window_override_until')
    if ov:
        left = (_parse_ts(ov) - now).total_seconds()
        if left > 0:
            return {'open': True, 'seconds_left': int(left), 'opened_at': None}
    node_id = settings.get('qr_sleep_node_id')
    if not node_id:
        return {'open': False, 'seconds_left': 0, 'opened_at': None}
    data = storage.qr_recent_scans(200)
    scans = [s for s in data if str(s.get('node_id')) == str(node_id) and s.get('scanned_at')]
    if not scans:
        return {'open': False, 'seconds_left': 0, 'opened_at': None}
    latest = max(scans, key=lambda s: s['scanned_at'])
    left = (_parse_ts(latest['scanned_at']) + timedelta(minutes=30) - now).total_seconds()
    return {'open': left > 0, 'seconds_left': max(0, int(left)), 'opened_at': latest['scanned_at']}


@app.route('/api/people/window')
def people_window():
    return jsonify(_people_window())


# --- People buckets ---
# (Was headed "Social gamification": that was the dormant points system's
# banner, and the buckets sat under it only by adjacency. They are the CRM's.)

@app.route('/api/buckets')
def get_buckets():
    return jsonify(storage.get_buckets())


@app.route('/api/buckets', methods=['POST'])
def post_bucket():
    data = request.get_json()
    if not data.get('name'):
        return jsonify({'error': 'name is required'}), 400
    return jsonify(storage.create_bucket(data['name'])), 201


@app.route('/api/buckets/<int:id>', methods=['PATCH'])
def patch_bucket(id):
    return jsonify(storage.update_bucket(id, request.get_json()))


# Client mode (PT_SERVER): the backend lives on a remote host; this process
# owns only the windows and a localhost bridge for the global hotkeys.
_CLIENT_SERVER = os.environ.get('PT_SERVER', '').rstrip('/')
_client_panel_hidden = False


class WindowApi:
    # Called from the main window's JS (the Engage eye / Settings toggle).
    # Local mode flips the setting directly; client mode asks the server to
    # flip it and mirrors the result onto the local window.
    def toggle_panel(self):
        global _client_panel_hidden
        if _CLIENT_SERVER:
            hidden = not _client_panel_hidden
            try:
                req = urllib.request.Request(_CLIENT_SERVER + '/api/panel/toggle', method='POST')
                with urllib.request.urlopen(req, timeout=5) as r:
                    hidden = json.loads(r.read().decode()).get('hidden', hidden)
            except Exception:
                pass
            _client_panel_hidden = hidden
        else:
            hidden = not _panel_toggled_off()
            storage.set_setting('panel_hidden', '1' if hidden else '0')
        if _panel_window:
            if hidden:
                _panel_window.hide()
            else:
                _panel_show()
        return hidden


def _remote_settings(server):
    try:
        with urllib.request.urlopen(server + '/api/settings', timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


# The hotkeys post to 127.0.0.1:5000 by design (loopback dodges Plucky). In
# client mode there is no local Flask, so a tiny stdlib bridge takes that
# port: panel marks are handled against the LOCAL windows (that is where the
# windows live now), and inbox capture/view is proxied to the server so
# inbox_cli.py works unchanged.
def _client_bridge():
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Bridge(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _done(self, code=204, body=None):
            self.send_response(code)
            if body is not None:
                self.send_header('Content-Type', 'application/json')
            self.end_headers()
            if body is not None:
                self.wfile.write(body)

        def _proxy(self):
            length = int(self.headers.get('Content-Length') or 0)
            data = self.rfile.read(length) if length else None
            req = urllib.request.Request(_CLIENT_SERVER + self.path, data=data,
                                         method=self.command,
                                         headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    self._done(r.status, r.read())
            except urllib.error.HTTPError as e:
                self._done(e.code, e.read())
            except Exception:
                self._done(502, b'{"error": "server unreachable"}')

        def do_GET(self):
            self._proxy()

        def do_POST(self):
            if self.path == '/api/panel/switch':
                if _panel_window and not _client_panel_hidden:
                    _panel_window.evaluate_js('npOpenSwitch()')
                self._done()
            elif self.path == '/api/panel/interrupted':
                if _panel_window and not _client_panel_hidden:
                    _panel_window.evaluate_js('npMarkInterrupted()')
                self._done()
            elif self.path == '/api/panel/hide':
                if _panel_window and not _client_panel_hidden:
                    _panel_window.hide()
                    threading.Timer(10, lambda: None if _panel_off() else _panel_show()).start()
                self._done()
            else:
                self._proxy()
                # A hotkey capture went through to the server — the laptop
                # main window should show it without a manual reload.
                if self.path == '/api/inbox' and _main_window:
                    try:
                        _main_window.evaluate_js('refreshTodoNow()')
                    except Exception:
                        pass

    port = int(os.environ.get('PT_BRIDGE_PORT', '5000'))
    HTTPServer(('127.0.0.1', port), Bridge).serve_forever()


def _active_monitor_origin():
    if sys.platform != 'win32':
        return 0, 0
    user32 = ctypes.windll.user32

    class POINT(ctypes.Structure):
        _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]

    class RECT(ctypes.Structure):
        _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                    ('right', ctypes.c_long), ('bottom', ctypes.c_long)]

    class MONITORINFO(ctypes.Structure):
        _fields_ = [('cbSize', ctypes.c_ulong), ('rcMonitor', RECT),
                    ('rcWork', RECT), ('dwFlags', ctypes.c_ulong)]

    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    hmon = user32.MonitorFromPoint(pt, 2)  # MONITOR_DEFAULTTONEAREST
    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
    return mi.rcWork.left, mi.rcWork.top


def _panel_yield_to_app():
    # The NOW panel floats above every OTHER app, but it should not float above
    # the productivity app itself: the main window is 1400x900 in a ~1536x912
    # work area, so there is nowhere to move it to and the panel would always
    # sit over the tab rail. While one of our own windows is in the foreground,
    # drop the panel out of the topmost band so the main window covers it;
    # restore topmost the moment focus leaves the app. SetWindowPos is safe to
    # call across threads (pywebview's on_top setter touches WinForms directly,
    # which is not), and the panel is found by exact title like inbox.ahk does.
    user32 = ctypes.windll.user32
    # c_void_p, not a plain int: the HWND_TOPMOST/HWND_NOTOPMOST sentinels are
    # negative, and ctypes would marshal them as 32-bit ints, so SetWindowPos
    # gets a truncated handle and fails (returns 0, z-order unchanged).
    HWND_TOPMOST = ctypes.c_void_p(-1)
    # NOSIZE | NOMOVE | NOACTIVATE | ASYNCWINDOWPOS (the panel belongs to the GUI
    # thread, so post the request instead of blocking this one on it).
    KEEP_PLACE = 0x0001 | 0x0002 | 0x0010 | 0x4000
    GWL_EXSTYLE, WS_EX_TOPMOST = -20, 0x8
    GW_HWNDNEXT = 2
    pid = ctypes.c_ulong()
    ours = os.getpid()
    while True:
        time.sleep(0.3)
        hwnd = user32.FindWindowW(None, 'NOW')
        if not hwnd:
            continue
        fg = user32.GetForegroundWindow()
        user32.GetWindowThreadProcessId(fg, ctypes.byref(pid))
        # Query the live z-order every tick instead of tracking state, so
        # anything else that reorders the panel (Ctrl+Alt+M's hide/show, a
        # resize, the user raising a window) self-heals on the next tick.
        if pid.value != ours:
            if not user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST:
                user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, KEEP_PLACE)
        elif fg != hwnd and user32.GetWindow(fg, GW_HWNDNEXT) != hwnd:
            # Sink the panel to DIRECTLY BENEATH the focused window. HWND_NOTOPMOST
            # is not enough on its own: it only moves the panel to the top of the
            # non-topmost band, which is still above the app window Windows just
            # raised — that is why the panel stayed over the app when you switched
            # back to it. Inserting after a non-topmost window clears the topmost
            # style too, so this one call does both. Skipped when the panel itself
            # has focus (Ctrl+Alt+S), where it must stay visible to be typed into.
            user32.SetWindowPos(hwnd, ctypes.c_void_p(fg), 0, 0, 0, 0, KEEP_PLACE)


HS_BEGIN = '-- >>> ef-exobrain hotkeys (managed — do not edit this block) >>>'
HS_END = '-- <<< ef-exobrain hotkeys <<<'


def _ensure_hammerspoon_config():
    # ~/.hammerspoon/init.lua loads inbox.lua by ABSOLUTE path, so moving the
    # repo unbinds every hotkey silently: Hammerspoon keeps running, the
    # dofile just fails, and nothing says so. Rewrite the line whenever it
    # does not point at this checkout. Returns True if the file changed.
    #
    # Only the marked block is ours. Anything else in init.lua belongs to the
    # user and is preserved.
    target = os.path.join(_REPO_DIR, 'inbox-hotkey', 'inbox.lua')
    if not os.path.exists(target):
        return False
    cfg_dir = os.path.expanduser(os.path.join('~', '.hammerspoon'))
    cfg = os.path.join(cfg_dir, 'init.lua')
    block = '%s\ndofile("%s")\n%s' % (HS_BEGIN, target, HS_END)
    try:
        existing = ''
        if os.path.exists(cfg):
            with open(cfg, encoding='utf-8') as f:
                existing = f.read()
        if block in existing:
            return False
        if HS_BEGIN in existing and HS_END in existing:
            head, rest = existing.split(HS_BEGIN, 1)
            updated = head + block + rest.split(HS_END, 1)[1]
        else:
            # First run here, or a pre-block install: drop any legacy line that
            # dofile'd an inbox.lua (that is the stale path) and its comment.
            kept = [ln for ln in existing.splitlines()
                    if 'inbox.lua' not in ln
                    and 'Productivity Tracker hotkeys' not in ln]
            while kept and not kept[-1].strip():
                kept.pop()
            updated = ('\n'.join(kept) + '\n\n' if kept else '') + block + '\n'
        os.makedirs(cfg_dir, exist_ok=True)
        with open(cfg, 'w', encoding='utf-8') as f:
            f.write(updated)
        print('Hammerspoon config pointed at', target)
        return True
    except OSError as e:
        print('Hammerspoon config not written:', e)
        return False


def _start_inbox_hotkeys():
    # Launch the global hotkey script (inbox-hotkey/inbox.ahk) alongside the app
    # so the shortcut boots both. It is its own AHK process and outlives us on
    # purpose — capture still works with the app closed. inbox.ahk is
    # #SingleInstance Force, so relaunching just replaces any live instance,
    # and the Startup-folder shortcut stays valid.
    if sys.platform == 'darwin':
        # Hammerspoon is the Mac AutoHotkey (inbox-hotkey/inbox.lua). It starts
        # at login on its own, but launching it here too keeps the parity that
        # any app launch path boots the hotkeys. -g = no focus steal; it is
        # single-instance by nature, and a missing install is a silent skip.
        if os.path.exists('/Applications/Hammerspoon.app'):
            if _ensure_hammerspoon_config():
                # The config changed, so a running Hammerspoon is holding the
                # old one — `open` alone does not re-read init.lua.
                subprocess.run(['killall', 'Hammerspoon'],
                               capture_output=True)
            subprocess.Popen(['open', '-ga', 'Hammerspoon'])
        return
    if sys.platform != 'win32':
        return
    exe = config.get('autohotkey_path', '')
    if not exe:
        for p in (r'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe',
                  r'C:\Program Files\AutoHotkey\v2\AutoHotkey32.exe',
                  r'C:\Program Files\AutoHotkey\AutoHotkey.exe'):
            if os.path.exists(p):
                exe = p
                break
    # Relative to THIS FILE, not cwd: cwd is the data dir (PT_DATA_DIR), which
    # is deliberately outside the repo, and the script ships with the code.
    script = os.path.join(_REPO_DIR, 'inbox-hotkey', 'inbox.ahk')
    if not exe or not os.path.exists(exe) or not os.path.exists(script):
        return
    subprocess.Popen([exe, script], cwd=os.path.dirname(script),
                     creationflags=subprocess.CREATE_NO_WINDOW)


class PanelApi:
    # _window is underscored on purpose: pywebview walks the public attributes
    # of a js_api object to expose them to JS and recurses into any non-callable
    # object, which on a Window descends into native WinForms objects and blows
    # the recursion limit. A leading underscore keeps it out of that walk.
    def set_height(self, height):
        # Panel is pinned at the monitor's top-left, so it grows downward
        # (default NORTH|WEST anchor keeps the top edge fixed).
        global _panel_pending_height
        # Never resize a panel that is switched off — resize() is also a show
        # (SWP_SHOWWINDOW, see _panel_show). Keep the measurement for when it
        # comes back, so it returns at the size its content needs.
        if _panel_off():
            _panel_pending_height = int(height)
            return
        self._window.resize(320, int(height))


if __name__ == '__main__':

    # Built as a --console exe (the windowed bootloader is unreliable here), so
    # hide our own console window at startup — the pywebview windows are the UI.
    if getattr(sys, 'frozen', False):
        try:
            ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 0)
        except Exception:
            pass

    # ── Three launch modes ────────────────────────────────────
    # PT_HEADLESS=1        server (Oracle VM): Flask only, no windows/hotkeys
    # PT_SERVER=http://…   client (laptop): windows + hotkey bridge, no Flask/db
    # (neither)            local all-in-one, unchanged

    if os.environ.get('PT_HEADLESS'):
        storage.init_db()
        port = int(os.environ.get('PT_PORT', '5000'))
        print(f'Headless server mode — Flask on 0.0.0.0:{port}, no windows.')
        app.run(host='0.0.0.0', port=port, use_reloader=False)
        sys.exit(0)

    if webview is None:
        print('pywebview is not installed — set PT_HEADLESS=1 to run as a server.')
        sys.exit(1)

    if _CLIENT_SERVER:
        base = _CLIENT_SERVER
        _client_panel_hidden = _remote_settings(base).get('panel_hidden') == '1'
        panel_hidden = _client_panel_hidden
        _start_inbox_hotkeys()
        threading.Thread(target=_client_bridge, daemon=True).start()
        print(f'Client mode — windows on {base}, hotkey bridge on 127.0.0.1:5000.')
    else:
        base = 'http://localhost:5000'
        storage.init_db()
        _start_inbox_hotkeys()
        # 0.0.0.0 so the phone's browser can use the app over the same WiFi.
        try:
            _probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            _probe.connect(('8.8.8.8', 80))
            print(f'Phone URL: http://{_probe.getsockname()[0]}:5000')
            _probe.close()
        except Exception:
            pass
        t = threading.Thread(target=lambda: app.run(host='0.0.0.0', port=5000, use_reloader=False))
        t.daemon = True
        t.start()
        panel_hidden = _panel_toggled_off()

    main_window = webview.create_window(
        'Productivity Tracker',
        base,
        width=430,
        height=930,
        js_api=WindowApi(),
    )
    origin_x, origin_y = _active_monitor_origin()
    panel_api = PanelApi()
    panel_window = webview.create_window(
        'NOW',
        base + '/panel',
        width=320,
        height=84,  # panel.js re-measures and hugs its content on first render
        frameless=True,
        on_top=True,
        easy_drag=False,  # pinned to the top-left; not draggable (hide via Ctrl+Alt+M)
        x=origin_x + 16,
        y=origin_y + 16,
        js_api=panel_api,
        hidden=panel_hidden,  # the Panel toggle persists across launches
    )
    panel_api._window = panel_window
    _panel_window = panel_window
    _main_window = main_window

    def _close_panel(*args):
        panel_window.destroy()

    main_window.events.closed += _close_panel
    if sys.platform == 'win32':
        threading.Thread(target=_panel_yield_to_app, daemon=True).start()
    webview.start()
