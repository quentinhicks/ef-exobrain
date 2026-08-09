# Full export of the Worker's D1 database via the Cloudflare REST API.
# Preferred over export_from_worker.py, which can only reach the admin API's
# hardcoded LIMIT 60 and cannot see node_overrides at all.
#
#   CF_API_TOKEN=... python3 export_d1.py <account_id> <database_id> [out.json]
#
# The token is read from the environment and never written to the output.
import json
import os
import sys
import urllib.request

TABLES = ('nodes', 'scan_events', 'charge_log', 'node_overrides', 'pending_changes')


def query(account, database, token, sql):
    req = urllib.request.Request(
        'https://api.cloudflare.com/client/v4/accounts/%s/d1/database/%s/query'
        % (account, database),
        data=json.dumps({'sql': sql}).encode(),
        headers={'Authorization': 'Bearer ' + token,
                 'Content-Type': 'application/json'},
        method='POST')
    with urllib.request.urlopen(req, timeout=60) as f:
        body = json.loads(f.read())
    if not body.get('success'):
        raise SystemExit('D1 error: %s' % body.get('errors'))
    return body['result'][0]['results']


def main(account, database, out='qr-d1-export.json'):
    token = os.environ.get('CF_API_TOKEN')
    if not token:
        raise SystemExit('set CF_API_TOKEN')
    data = {}
    for t in TABLES:
        data[t] = query(account, database, token, 'SELECT * FROM ' + t)
        print('%-16s %d rows' % (t, len(data[t])))
    json.dump(data, open(out, 'w'), indent=1)
    print('wrote ' + out)


if __name__ == '__main__':
    main(*sys.argv[1:])
