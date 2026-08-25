# The PUBLIC half of the QR system, and the only part of this project exposed
# outside the tailnet. Two routes, one table written, nothing else reachable.
#
# WHY A SEPARATE PROCESS, not a blueprint on the main app:
#   1. The main app has NO AUTHENTICATION — the tailnet is its entire auth
#      boundary. Serving both from one process means one routing mistake
#      publishes every journal, task and log. Here there is no such route to
#      mis-serve: this module defines two, and neither can read anything but a
#      node's label.
#   2. It survives `systemctl restart productivity` during a deploy, so a scan
#      at the wrong moment is not lost.
#   3. Its dependency footprint stays tiny.
#
# Bound to 127.0.0.1 and published by `tailscale serve --funnel`, which
# terminates TLS. Nothing is opened in the OCI security list or in iptables:
# the box keeps zero public listeners, which is the point.
#
# A scan is UNAUTHENTICATED by design — the QR sticker's token is the secret,
# exactly as with the Worker. The token is 43 chars of URL-safe base64; the
# route pattern rejects anything else before a query runs.
import json
import math
import os
import re
from datetime import datetime

from flask import Flask, Response, request

import ntag
import storage

app = Flask(__name__)

TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{16,64}$')


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


SCAN_PAGE = '''<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%(label)s</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      margin:0;padding:32px 20px;background:#0d0d0d;color:#e8e8e8}
 h3{font-size:22px;margin:0 0 12px} p{color:#9a9a9a;line-height:1.5}
 button{width:100%%;padding:16px;font-size:17px;font-weight:600;border:0;
        border-radius:10px;background:#5b8ce8;color:#fff;margin-top:20px}
 button:disabled{background:#2a2a2a;color:#666}
</style></head><body>
<h3>%(label)s</h3>
<p id="status">Checking location...</p>
<button id="submitBtn" disabled>Submit</button>
<script>
let coords = {};
const watchId = navigator.geolocation.watchPosition(
  (pos) => {
    coords = { lat: pos.coords.latitude, lng: pos.coords.longitude,
               accuracy: Math.round(pos.coords.accuracy) };
    document.getElementById("status").textContent =
      "Location captured (\\u00b1" + coords.accuracy + "m) \\u2014 waiting refines it.";
    document.getElementById("submitBtn").disabled = false;
  },
  () => {
    document.getElementById("status").textContent =
      "Location unavailable \\u2014 submitting without it.";
    document.getElementById("submitBtn").disabled = false;
  },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
);
document.getElementById("submitBtn").onclick = async () => {
  navigator.geolocation.clearWatch(watchId);
  const resp = await fetch(window.location.pathname, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(coords),
  });
  document.body.innerHTML = "<h3>" + (await resp.text()) + "</h3>";
};
</script></body></html>'''


def _utc_now_iso():
    # UTC with a trailing Z, the shape qr_scan.scanned_at is written in and the
    # one the judge matches window bounds against. Not local: this process
    # never applies setting.timezone, so its idea of local is the VM's.
    now = datetime.utcnow()
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (now.microsecond // 1000)


def _esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


@app.route('/scan/<token>', methods=['GET', 'POST'])
def scan(token):
    if not TOKEN_RE.match(token or ''):
        return 'Not found', 404
    node = storage.qr_get_node_by_token(token)
    if not node:
        return 'Unknown or inactive node', 404

    if request.method == 'GET':
        return Response(SCAN_PAGE % {'label': _esc(node['label'])},
                        mimetype='text/html')

    body = request.get_json(silent=True) or {}
    lat, lng = body.get('lat'), body.get('lng')
    accuracy = body.get('accuracy')

    dist = None
    geofence_pass = None
    if node.get('geofence_lat') is not None:
        if lat is None or lng is None:
            geofence_pass = 0
        else:
            dist = round(haversine_m(lat, lng, node['geofence_lat'], node['geofence_lng']))
            geofence_pass = 1 if dist <= (node.get('geofence_radius_m') or 0) else 0

    # UTC with a trailing Z — the format the Worker wrote and the format
    # qr_judge compares against. Writing local time here would make every scan
    # fall outside its own window.
    now_iso = _utc_now_iso()
    storage.qr_log_scan(node['id'], now_iso, lat, lng, geofence_pass, accuracy)

    if geofence_pass == 1 or geofence_pass is None:
        return 'Logged', 200
    if dist is None:
        return ('Logged — no location captured, so this scan cannot satisfy '
                'the geofence. Re-scan with location on.'), 200
    return ('Logged — OUT OF RANGE: %dm from the target (limit %dm). '
            'Re-scan to try again.' % (dist, node.get('geofence_radius_m') or 0)), 200


TAP_PAGE = '''<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%(label)s</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      margin:0;padding:32px 20px;background:#0d0d0d;color:#e8e8e8}
 h3{font-size:22px;margin:0 0 12px} p{color:#9a9a9a;line-height:1.5}
 .ok{color:#7fd08a} .no{color:#e2857f}
</style></head><body>
<h3>%(label)s</h3>
<p class="%(cls)s">%(msg)s</p>
</body></html>'''


def _tap_page(label, msg, ok, code):
    return Response(TAP_PAGE % {'label': _esc(label), 'msg': _esc(msg),
                                'cls': 'ok' if ok else 'no'},
                    mimetype='text/html', status=code)


def _log_tap(*a, **kw):
    """The tap log, which may never cost a tap.

    qr_tap_attempt is a diagnostic — nothing judges it, nothing is charged on
    it. So a failure to WRITE it must not turn a genuine tap into a 500: the
    row is worth less than the tap it would be describing, and the two
    services deploy separately (qpa-scan runs its own process), so this code
    can legitimately be newer than the schema for a few seconds after a push.
    The exception goes to the journal, where the other refusals already go.
    """
    try:
        storage.qr_log_tap(*a, **kw)
    except Exception as e:
        print('tap log failed: %s' % e)


@app.route('/t')
def tap():
    """A VERIFIED TAP — the hard proof, and the only route that can write one.

    The tag mirrors two values into this URL and re-computes them on every tap
    (see ntag.py). Nothing here is trusted: the UID arrives encrypted, the MAC
    is checked with that tag's own key, and the read counter has to be one this
    tag has never used. Which means a captured URL is worth nothing — replaying
    it lands on a counter that is no longer new.

    GET, not POST, because the tag hands the phone a URL and the browser
    follows it: there is nothing to submit. It writes one row and reads one
    label, exactly like /scan, so the public surface stays two routes wide.
    """
    # WHATEVER THE PROGRAMMING TOOL CALLED THEM. Every SDM implementation picks
    # its own query names — `e`/`c` here, `picc_data`/`cmac` in some encoders,
    # `enc_picc_data`/`sdmmac` in NXP's own backend — and which one a tag ends
    # up with is decided by an app on a phone, not by this code. So all three
    # are accepted, plus the BULK form that concatenates the two mirrors into
    # one 48-hex parameter. Nothing is trusted either way: the CMAC still has to
    # verify and the counter still has to be new.
    picc = (request.args.get('e') or request.args.get('picc_data')
            or request.args.get('enc_picc_data') or '').strip()
    cm = (request.args.get('c') or request.args.get('cmac')
          or request.args.get('sdmmac') or '').strip()
    if not cm and len(picc) == 48:
        picc, cm = picc[:32], picc[32:]
    # EVERY EXIT BELOW WRITES ONE ATTEMPT ROW, refusals included. The page a
    # stranger sees stays vague on purpose ('Not a valid tap.'); the REASON
    # goes to the db, where only the app can read it. That is the whole
    # difference between a gate you can debug and a print() on a VM's stdout —
    # a refused tap used to leave no trace at all, so "no taps yet" read the
    # same whether you had never tapped or tapped ten times against a factory
    # key, which is exactly the state a tag is in while being set up.
    now_iso = _utc_now_iso()
    keys = ntag.load_keys()
    if not keys:
        # No keys configured at all: say so plainly. This is the state a fresh
        # tag is in before its keys are pasted into Settings, and it is not
        # something a stranger learns anything from.
        _log_tap(now_iso, False, 'no tag keys are configured yet')
        return _tap_page('Tag', 'No tag keys are configured yet.', False, 503)
    try:
        uid, counter = ntag.identify(picc, cm, keys)
    except ntag.TapError as e:
        print('tap refused: %s' % e)
        _log_tap(now_iso, False, str(e))
        return _tap_page('Tag', 'Not a valid tap.', False, 403)

    tag = storage.qr_tag_by_uid(uid)
    if not tag:
        # A real tag whose keys are configured but which no gate claims. Worth
        # saying, because it is the state between programming a tag and adding
        # it in Settings.
        _log_tap(now_iso, False, 'verified, but no gate claims this tag',
                           uid=uid, counter=counter)
        return _tap_page('Tag %s' % uid, 'This tag is not attached to a gate yet.',
                         False, 404)
    if not tag['active'] or not tag['node_active']:
        pend = storage.qr_tag_pending(tag['id'])
        _log_tap(now_iso, False,
                           ('this tag starts counting %s' % pend[:16].replace('T', ' '))
                           if pend else 'this tag is paused',
                           node_id=tag['node_id'], tag_id=tag['id'],
                           uid=uid, counter=counter)
        return _tap_page(tag['label'],
                         ('This tag starts counting %s.' % pend[:16].replace('T', ' '))
                         if pend else 'This tag is paused.', False, 409)

    if not storage.qr_accept_tap(tag['id'], counter, now_iso):
        # The counter is not new: a refresh of the page, or a replay of a URL
        # someone kept. Either way this tap is already history, and it must not
        # log a second scan.
        _log_tap(now_iso, False, 'read %d was already logged — a refresh, '
                           'or a URL replayed' % counter, node_id=tag['node_id'],
                           tag_id=tag['id'], uid=uid, counter=counter)
        return _tap_page(tag['label'], 'Already logged — tap the tag again.', True, 200)

    storage.qr_log_scan(tag['node_id'], now_iso, None, None, None, None,
                        proof='tag', tag_id=tag['id'])
    _log_tap(now_iso, True, None, node_id=tag['node_id'], tag_id=tag['id'],
                       uid=uid, counter=counter)
    return _tap_page(tag['node_label'], 'Logged — %s, read %d.' % (tag['label'], counter),
                     True, 200)


@app.route('/health')
def health():
    return 'ok', 200


if __name__ == '__main__':
    data_dir = os.environ.get('PT_DATA_DIR')
    if data_dir:
        os.chdir(data_dir)
    # A scan is stamped with a time the judge compares against local windows —
    # this process dates things too, so it takes the same lever.
    storage.apply_timezone()
    app.run(host='127.0.0.1', port=int(os.environ.get('QR_PORT', '5001')),
            use_reloader=False)
