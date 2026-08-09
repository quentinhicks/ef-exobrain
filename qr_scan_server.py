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
    now_iso = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.') + \
        '%03dZ' % (datetime.utcnow().microsecond // 1000)
    storage.qr_log_scan(node['id'], now_iso, lat, lng, geofence_pass, accuracy)

    if geofence_pass == 1 or geofence_pass is None:
        return 'Logged', 200
    if dist is None:
        return ('Logged — no location captured, so this scan cannot satisfy '
                'the geofence. Re-scan with location on.'), 200
    return ('Logged — OUT OF RANGE: %dm from the target (limit %dm). '
            'Re-scan to try again.' % (dist, node.get('geofence_radius_m') or 0)), 200


@app.route('/health')
def health():
    return 'ok', 200


if __name__ == '__main__':
    data_dir = os.environ.get('PT_DATA_DIR')
    if data_dir:
        os.chdir(data_dir)
    app.run(host='127.0.0.1', port=int(os.environ.get('QR_PORT', '5001')),
            use_reloader=False)
