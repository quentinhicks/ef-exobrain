# One-shot import of the Worker's D1 tables into the app's SQLite, consuming
# the JSON that export_d1.py writes. Idempotent: re-running refreshes node
# config and skips scans/judgments already present.
#
#   python3 migrate_from_worker.py qr-d1-export.json
#
# IDs ARE PRESERVED. area.qr_node_id, the engage day's QR hairlines and the
# timeline pill all reference node ids, so remapping them would silently
# detach every routine and block from its QR.
#
# Dropped on the way across, deliberately: requires_todo and
# todo_grace_minutes (dead columns — judgment has been presence-only since the
# to-do list was retired), and the routine/todo/social gate tables, which are
# not part of the ported judge.
import json
import sys

import storage


def main(path='qr-d1-export.json'):
    d = json.load(open(path))
    conn = storage.get_conn()

    for n in d.get('nodes', []):
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
             n.get('geofence_lng'), n.get('geofence_radius_m'), n.get('active', 1),
             n.get('days_of_week') or '0123456', n.get('weekly_windows')))

    for s in d.get('scan_events', []):
        conn.execute(
            '''INSERT OR IGNORE INTO qr_scan (id, node_id, scanned_at, lat, lng,
                                              geofence_pass, accuracy_m)
               VALUES (?,?,?,?,?,?,?)''',
            (s['id'], s['node_id'], s['scanned_at'], s.get('lat'), s.get('lng'),
             s.get('geofence_pass'), s.get('accuracy_m')))

    for o in d.get('node_overrides', []):
        conn.execute(
            '''INSERT OR REPLACE INTO qr_override
                 (node_id, date, window_start, window_end, window_end_offset_days)
               VALUES (?,?,?,?,?)''',
            (o['node_id'], o['date'], o['window_start'], o['window_end'],
             o.get('window_end_offset_days') or 0))

    for p in d.get('pending_changes', []):
        conn.execute(
            '''INSERT INTO qr_pending_change (node_id, field, new_value, apply_at)
               VALUES (?,?,?,?)''',
            (p['node_id'], p['field'], p['new_value'], p['apply_at']))

    # charge_log.stripe_payment_intent_id kept its name in D1 for schema
    # stability long after Beeminder replaced Stripe; it lands in charge_ref
    # here, which is what it has actually held since 2026-08.
    for c in d.get('charge_log', []):
        conn.execute(
            '''INSERT OR IGNORE INTO qr_charge_log (node_id, date, failure_reason,
                                                    charge_status, charge_ref, amount_cents)
               VALUES (?,?,?,?,?,?)''',
            (c['node_id'], c['date'], c.get('failure_reason'), c.get('charge_status'),
             c.get('stripe_payment_intent_id'), c.get('amount_cents')))

    conn.commit()
    for t in ('qr_node', 'qr_scan', 'qr_override', 'qr_pending_change', 'qr_charge_log'):
        print('  %-18s %d rows' % (t, conn.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]))
    conn.close()


if __name__ == '__main__':
    main(*sys.argv[1:])
