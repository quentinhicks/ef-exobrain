#!/usr/bin/env python3
# A CLAUDE CODE TOOL FOR GATE DEADLINES (2026-09-29, Quentin's instruction).
#
# An MCP server over stdio, standard library only: Claude Code starts it, and
# it talks to the app's own HTTP API. It can read every gate's day and change
# DEADLINES — a day's window, calling a day off or putting it back, a gate's
# weekly schedule — and nothing else.
#
# Every write is marked `X-QPA-Actor: assistant` with the reason Claude gave
# in `X-QPA-Reason`. app.py refuses a marked write outside those four kinds
# and logs every one, refusals included (Settings -> AI changes). The mark is a
# RECORD, not a lock: what keeps any client from dodging a gate is the
# server's own rules, which this tool cannot bypass — an easing waits 24h,
# nothing moves within 24h of a close, and a judged day is frozen.
#
# Configure with QPA_URL, the app's base URL (the tailnet address), e.g. in
# the private workspace's .mcp.json:
#   {"mcpServers": {"gates": {"command": "python",
#     "args": ["ef-exobrain/mcp/gates_mcp.py"],
#     "env": {"QPA_URL": "https://<vm>.<tailnet>.ts.net"}}}}
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = (os.environ.get('QPA_URL') or '').rstrip('/')
YMD = re.compile(r'^\d{4}-\d{2}-\d{2}$')
HHMM = re.compile(r'^([01]?\d|2[0-3]):[0-5]\d$')
DAYS = ('mo', 'tu', 'we', 'th', 'fr', 'sa', 'su')


class ToolError(Exception):
    pass


def call(method, path, body=None, reason=None):
    if not BASE:
        raise ToolError('QPA_URL is not set — point it at the app, e.g. https://<vm>.<tailnet>.ts.net')
    headers = {'Accept': 'application/json'}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if method != 'GET':
        headers['X-QPA-Actor'] = 'assistant'
        # Headers are latin-1 on the wire; the server unquotes this.
        headers['X-QPA-Reason'] = urllib.parse.quote(reason or '', safe=' ')
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read() or b'{}').get('error')
        except Exception:
            msg = None
        raise ToolError(f'the app refused it ({e.code}): {msg or e.reason}')
    except urllib.error.URLError as e:
        raise ToolError(f'could not reach the app at {BASE}: {e.reason}')


def need_date(a, key='date'):
    d = str(a.get(key) or '')
    if not YMD.match(d):
        raise ToolError(f'{key} must be YYYY-MM-DD (get_day tells you the app\'s today)')
    return d


def need_time(a, key):
    t = str(a.get(key) or '').strip()
    if not HHMM.match(t):
        raise ToolError(f'{key} must be HH:MM, 24-hour')
    h, m = t.split(':')
    return f'{int(h):02d}:{m}', int(h) * 60 + int(m)


def need_reason(a):
    r = str(a.get('reason') or '').strip()
    if not r:
        raise ToolError('say why in `reason` — it is logged beside the change')
    return r


def gate_line(g):
    w = g.get('window') or {}
    out = {
        'gate_id': g['node_id'], 'label': g['label'], 'runs': bool(g.get('applies')),
        'called_off': bool(g.get('skipped')),
        'window': f"{w.get('start')}–{w.get('end')}" + (' (+1 day)' if w.get('offset_days') else ''),
        'window_set_by': w.get('from'), 'all_day': bool(w.get('all_day')),
        'locked_within_24h': bool(g.get('skip_locked')),
        'judged': bool(g.get('judged')), 'closed': bool(w.get('closed')),
        'settles_at': (g.get('verdict') or {}).get('settles_at'),
        'cleared_so_far': bool((g.get('verdict') or {}).get('met')),
    }
    if g.get('pending_changes'):
        out['scheduled_changes'] = [{'field': p['field'], 'to': p.get('new_label') or p['new_value'],
                                     'from_day': p['effective_date']} for p in g['pending_changes']]
    return out


def list_gates(a):
    return [{'gate_id': n['id'], 'label': n['label'], 'active': bool(n['active']),
             'schedule': n.get('schedule_label') or 'no schedule',
             'proof': n.get('proof_mode') or 'link', 'all_day': bool(n.get('all_day')),
             'scheduled_changes': [{'field': p['field'], 'to': p.get('new_label') or p['new_value'],
                                    'from_day': p['effective_date']}
                                   for p in n.get('pending_changes') or []]}
            for n in call('GET', '/api/accountability/nodes')]


def get_day(a):
    q = ''
    if a.get('date'):
        q = '?date=' + need_date(a)
    d = call('GET', '/api/gates/day' + q)
    return {'date': d['date'], 'gates': [gate_line(g) for g in d['gates']]}


def set_day_window(a):
    date, reason = need_date(a), need_reason(a)
    start, s = need_time(a, 'start')
    end, e = need_time(a, 'end')
    # An end at or before the start closes the next morning.
    body = {'date': date, 'window_start': start, 'window_end': end,
            'window_end_offset_days': 1 if e <= s else 0}
    call('POST', f"/api/accountability/nodes/{int(a['gate_id'])}/overrides", body, reason)
    return {'ok': True, 'date': date, 'window': f'{start}–{end}' + (' (+1 day)' if e <= s else ''),
            'note': 'this day only; the schedule is unchanged'}


def clear_day_window(a):
    date, reason = need_date(a), need_reason(a)
    call('DELETE', f"/api/accountability/nodes/{int(a['gate_id'])}/overrides/{date}", None, reason)
    return {'ok': True, 'date': date, 'note': 'the day is back on its schedule'}


def call_off_day(a):
    date, reason = need_date(a), need_reason(a)
    call('POST', f"/api/accountability/nodes/{int(a['gate_id'])}/overrides",
         {'date': date, 'skipped': True}, reason)
    return {'ok': True, 'date': date, 'note': 'called off: the day will land as "did not run"'}


def put_day_back(a):
    date, reason = need_date(a), need_reason(a)
    call('DELETE', f"/api/accountability/nodes/{int(a['gate_id'])}/overrides/{date}", None, reason)
    return {'ok': True, 'date': date, 'note': 'the gate runs that day again'}


def set_weekly_schedule(a):
    reason = need_reason(a)
    days = [str(d).lower()[:2] for d in (a.get('days') or [])]
    if not days or any(d not in DAYS for d in days):
        raise ToolError('days must be a non-empty list of mo tu we th fr sa su')
    start, s = need_time(a, 'start')
    end, e = need_time(a, 'end')
    dur = (e - s) % 1440 or 1440
    today = call('GET', '/api/gates/day')['date']
    src = call('POST', '/api/schedules', {
        'kind': 'rule', 'start': f'{today}T{start}:00',
        'duration': 'PT%dH%dM' % divmod(dur, 60),
        'recurrenceRules': [{'@type': 'RecurrenceRule', 'frequency': 'weekly',
                             'byDay': [{'@type': 'NDay', 'day': d} for d in DAYS if d in days]}],
    }, reason)
    body = {'source_uid': src['uid']}
    if a.get('effective_from'):
        body['effective_from'] = need_date(a, 'effective_from')
    out = call('PATCH', f"/api/accountability/nodes/{int(a['gate_id'])}", body, reason)
    when = (out.get('scheduled') or {}).get('source_uid')
    return {'ok': True, 'schedule': f"{' '.join(d for d in DAYS if d in days)} {start}–{end}",
            'takes_effect': when['effective_date'] if when else 'now',
            'note': ('an easing waits 24h and can be called off on /gates until then'
                     if when else 'a tightening applies at once')}


DATE = {'type': 'string', 'description': 'YYYY-MM-DD, the day it is about'}
GATE = {'type': 'integer', 'description': 'the gate_id from list_gates or get_day'}
REASON = {'type': 'string', 'description': 'why — shown to Quentin beside the change'}
TIME = {'type': 'string', 'description': 'HH:MM, 24-hour'}

TOOLS = {
    'list_gates': (list_gates, 'Every gate: its schedule, proof, and changes already scheduled.',
                   {}, []),
    'get_day': (get_day, 'Every gate on one day as the judge resolves it: whether it runs, its '
                'window and what set it, whether it is locked (closes within 24h), judged or '
                'called off. Without a date it returns the app\'s today and says which date that is.',
                {'date': DATE}, []),
    'set_day_window': (set_day_window, 'Move ONE day\'s window for a gate (this day only). An end '
                       'at or before the start closes the next morning. Refused within 24h of the '
                       'close and on a judged day.',
                       {'gate_id': GATE, 'date': DATE, 'start': TIME, 'end': TIME, 'reason': REASON},
                       ['gate_id', 'date', 'start', 'end', 'reason']),
    'clear_day_window': (clear_day_window, 'Remove a day\'s window change so the day follows its '
                         'schedule again. Refused within 24h of the close.',
                         {'gate_id': GATE, 'date': DATE, 'reason': REASON},
                         ['gate_id', 'date', 'reason']),
    'call_off_day': (call_off_day, 'Call a gate\'s day off, so it lands as "did not run" and costs '
                     'nothing. An easing: refused within 24h of the close.',
                     {'gate_id': GATE, 'date': DATE, 'reason': REASON}, ['gate_id', 'date', 'reason']),
    'put_day_back': (put_day_back, 'Undo a call-off: the gate runs that day again. Always allowed.',
                     {'gate_id': GATE, 'date': DATE, 'reason': REASON}, ['gate_id', 'date', 'reason']),
    'set_weekly_schedule': (set_weekly_schedule, 'Give a gate a new weekly schedule: the days it '
                            'runs and its window. Making it easier waits 24h (and can be called '
                            'off on /gates); making it stricter applies at once.',
                            {'gate_id': GATE, 'days': {'type': 'array', 'items': {'type': 'string'},
                                                       'description': 'e.g. ["mo","we","fr"]'},
                             'start': TIME, 'end': TIME,
                             'effective_from': {'type': 'string', 'description':
                                                'optional YYYY-MM-DD it starts from (a floor, never '
                                                'a bypass of the 24h wait)'},
                             'reason': REASON},
                            ['gate_id', 'days', 'start', 'end', 'reason']),
}


# The JSON-RPC half is shared: mcp/blocks_mcp.py imports handle() and main()
# and hands them its own tool table and name, so the two servers cannot drift
# on the protocol while each keeps its own scope.
def tool_list(tools=TOOLS):
    return [{'name': name, 'description': desc,
             'inputSchema': {'type': 'object', 'properties': props, 'required': req}}
            for name, (_, desc, props, req) in tools.items()]


def handle(msg, tools=TOOLS, server='qpa-gates'):
    method, mid, params = msg.get('method'), msg.get('id'), msg.get('params') or {}
    if method == 'initialize':
        return {'protocolVersion': params.get('protocolVersion') or '2025-06-18',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': server, 'version': '1.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': tool_list(tools)}
    if method == 'tools/call':
        name = params.get('name')
        if name not in tools:
            return {'content': [{'type': 'text', 'text': f'no tool named {name}'}], 'isError': True}
        try:
            out = tools[name][0](params.get('arguments') or {})
            return {'content': [{'type': 'text', 'text': json.dumps(out, indent=1)}]}
        except (ToolError, KeyError, ValueError) as e:
            return {'content': [{'type': 'text', 'text': str(e)}], 'isError': True}
    if mid is None:
        return None                    # a notification: no answer owed
    raise LookupError(method)


def main(tools=TOOLS, server='qpa-gates'):
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get('id')
        try:
            result = handle(msg, tools, server)
            if mid is None:
                continue
            reply = {'jsonrpc': '2.0', 'id': mid, 'result': result}
        except LookupError as e:
            reply = {'jsonrpc': '2.0', 'id': mid,
                     'error': {'code': -32601, 'message': f'method not found: {e}'}}
        sys.stdout.write(json.dumps(reply) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
