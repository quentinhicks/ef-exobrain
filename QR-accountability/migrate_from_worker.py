# One-shot import of the Cloudflare Worker's D1 data into the app's SQLite.
# Reads the JSON produced by export_from_worker.py. Idempotent: re-running
# replaces node config and skips scans/judgments it already has.
#
# Node IDs are PRESERVED. area.qr_node_id, the engage day's hairlines and the
# timeline pill all reference them, so remapping would silently detach every
# routine and block from its QR.
import json
import sys

import storage


def main(path):
    data = json.load(open(path))
    conn = storage.get_conn()

    nodes = data.get('nodes') or []
    for n in nodes:
        conn.execute(
            '''INSERT INTO qr_node (id, label, token, window_start, window_end,
                                    window_end_offset_days, geofence_lat, geofence_lng,
                                    geofence_radius_m, active, days_of_week, weekly_windows)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 label=excluded.label, token=excluded.token,
                 window_start=excluded.window_start, window_end=excluded.window_end,
                 window_end_offset_days=excluded.window_end_offset_days,
                 geofence_lat=excluded.geofence_lat, geofence_lng=excluded.geofence_lng,
                 geofence_radius_m=excluded.geofence_radius_m, active=excluded.active,
                 days_of_week=excluded.days_of_week, weekly_windows=excluded.weekly_windows''',
            (n['id'], n['label'], n['token'], n['window_start'], n['window_end'],
             n.get('window_end_offset_days') or 0, n.get('geofence_lat'),
             n.get('geofence_lng'), n.get('geofence_radius_m'),
             n.get('active', 1), n.get('days_of_week') or '0123456',
             n.get('weekly_windows')))

        # today_override rides on the node payload; there is no bulk override
        # export, and past overrides only affect already-judged days.
        ov = n.get('today_override')
        if ov and ov.get('date'):
            conn.execute(
                '''INSERT OR REPLACE INTO qr_override
                     (node_id, date, window_start, window_end, window_end_offset_days)
                   VALUES (?,?,?,?,?)''',
                (n['id'], ov['date'], ov['window_start'], ov['window_end'],
                 ov.get('window_end_offset_days') or 0))

        for pc in (n.get('pending_changes') or []):
            conn.execute(
                '''INSERT INTO qr_pending_change (node_id, field, new_value, apply_at)
                   VALUES (?,?,?,?)''',
                (n['id'], pc['field'], pc['new_value'], pc['apply_at']))

    scans = data.get('scan_log') or []
    for s in scans:
        conn.execute(
            '''INSERT OR IGNORE INTO qr_scan (id, node_id, scanned_at, lat, lng,
                                              geofence_pass, accuracy_m)
               VALUES (?,?,?,?,?,?,?)''',
            (s.get('id'), s['node_id'], s['scanned_at'], s.get('lat'), s.get('lng'),
             s.get('geofence_pass'), s.get('accuracy_m')))

    judged = data.get('charge_log') or []
    for c in judged:
        conn.execute(
            '''INSERT OR IGNORE INTO qr_charge_log (node_id, date, failure_reason,
                                                    charge_status, charge_ref, amount_cents)
               VALUES (?,?,?,?,?,?)''',
            (c['node_id'], c['date'], c.get('failure_reason'),
             c.get('charge_status'), c.get('stripe_payment_intent_id'),
             c.get('amount_cents')))

    conn.commit()
    print('nodes %d | scans %d | judgments %d' % (len(nodes), len(scans), len(judged)))
    for t in ('qr_node', 'qr_scan', 'qr_override', 'qr_pending_change', 'qr_charge_log'):
        print('  %-18s %d rows' % (t, conn.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]))
    conn.close()


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'qr-export.json')
