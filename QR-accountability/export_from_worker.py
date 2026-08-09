# Pulls the Worker's live D1 data out through its own admin API, which is the
# only door left: the Cloudflare API token in QR-accountability/.env is dead,
# so `wrangler d1 export` is unavailable.
#
# LIMITATION: /admin/scan-log and /admin/charge-log are hardcoded LIMIT 60 with
# no override, so this captures the most recent 60 of each. That covers every
# date the app can display (±3 days) and the whole judgment range, but it is
# NOT the full scan history. For 100% fidelity, restore Cloudflare API access
# and use `wrangler d1 export --remote` instead.
#
# A browser User-Agent is required: Cloudflare answers urllib's default with
# `error code: 1010` (banned browser signature), which looks like a 403 auth
# failure and is not one.
import json
import sys
import urllib.request

UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124 Safari/537.36')


def main(config_path='config.json', out='qr-export.json'):
    cfg = json.load(open(config_path))
    base = cfg['qr_worker_url'].rstrip('/')
    secret = cfg.get('qr_admin_secret', '')

    def get(path):
        req = urllib.request.Request(
            base + path,
            headers={'Authorization': 'Bearer ' + secret, 'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as f:
            return json.loads(f.read())

    data = {}
    for name, path in (('nodes', '/admin/nodes'),
                       ('scan_log', '/admin/scan-log'),
                       ('charge_log', '/admin/charge-log')):
        data[name] = get(path)
        print('%-11s %d rows' % (name, len(data[name])))
    json.dump(data, open(out, 'w'), indent=1)
    print('wrote ' + out)


if __name__ == '__main__':
    main(*sys.argv[1:])
