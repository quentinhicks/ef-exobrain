# QR accountability — running it on the VM

Was a Cloudflare Worker + D1 until 2026-08-08. Now three pieces on the VM:

| Piece | Unit | Reachable from |
|---|---|---|
| Scan endpoint (`qr_scan_server.py`) | `qpa-scan.service` | **the public internet**, via Tailscale Funnel on :8443 |
| Judge (`qr_judge.py`) | `qpa-judge.timer`, every 5 min | nothing — it only reads the db |
| QR manager (`/api/accountability/*`) | inside the main app | the tailnet |

## The exposure model, and why it is this shape

The main app has **no authentication** — the tailnet is its entire auth
boundary — so the public endpoint is a SEPARATE PROCESS on a SEPARATE PORT,
not a path on the same server. Port separation over path filtering is
deliberate: a path rule is one typo away from publishing the whole API,
whereas :8443 reaches a process that defines two routes and cannot serve an
app route at all.

- `qr_scan_server.py` binds **127.0.0.1:5001** — never a public interface.
- `tailscale funnel` on **:8443** is the only public ingress and terminates TLS.
- **Nothing is opened in iptables or the OCI security list.** The box still has
  zero public listeners; `iptables -S INPUT` must keep ending in `REJECT`.
- Port **443 stays tailnet-only** and serves the app. Verify after any change:

```
tailscale funnel status          # must list :8443 and nothing else
ss -tlnp | grep 5001             # must be 127.0.0.1 only
curl -s -o /dev/null -w '%{http_code}' https://<host>.<tailnet>.ts.net:8443/api/logs   # must be 404
```

A scan is unauthenticated by design: the token in the QR is the credential,
43 chars of URL-safe base64, same as under the Worker.

## Judgment

Presence-only. A window is judged when it closes; the test is a satisfying
scan (geofence-passing where a geofence is set). The retired to-do gate and
the routine gate are gone — a QR URL is location proof again.

`qr_charge_log` is a **failure log**: no row on success. Outcomes are
recomputed from scans by `qr_judge.outcomes()`, which is what lets a
late-logged scan still flip a day to ✓. Writing success rows would freeze the
wrong answer and paint good days red.

**Times are stored UTC with a Z; windows are local wall clock.** Convert with
`_utc_iso()` before comparing. Comparing a naive local bound against a UTC
timestamp misses every scan after local midnight in UTC — for a 21:45 window
that is all of them, and every night judges absent.

## The 24h gates

Tightening applies immediately; loosening waits 24h, by which time the window
being dodged has passed. Loosening = later start, earlier end, wider geofence,
dropped weekday, smaller end-offset, or any weekday whose merged weekly window
loosens. Deleting an override is gated too — dropping one that made a day
harder would be a loophole back to the slacker default. An active node cannot
be deleted (409); activate only cancels a *pending* disable.

## Charging

Not ported, deliberately. It was disabled at five layers on the Worker and
re-enabling is the staged protocol in `RE-ENABLE.md`, not a code move.
Failures record `charge_status='would_fire'`; no money path exists here.

## Changing the QR stickers

Tokens are stable across the move — only the host changed. Reprint from:

```
python3 -c "import storage; [print(n['label'], 'https://<host>.<tailnet>.ts.net:8443/scan/'+n['token']) for n in storage.qr_get_nodes() if n['active']]"
```
