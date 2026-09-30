#!/usr/bin/env python3
# A CLAUDE CODE TOOL FOR THE WEEKLY BLOCK SCHEDULE (2026-09-30, Quentin's
# instruction: "create a tool such that AI could edit my weekly block
# schedule").
#
# The gate tool's twin (mcp/gates_mcp.py), and it shares that file's plumbing:
# the same HTTP client, the same `X-QPA-Actor: assistant` mark with the reason
# in `X-QPA-Reason`, the same JSON-RPC loop. It reads the week and one day, and
# writes BLOCKS only — add, edit, pause, delete, date a change forward, and a
# day's own hours or cancellation. app.py's ASSISTANT_WRITES admits exactly
# those routes, and every marked write is logged (Settings -> AI changes).
#
# A block is not on the money path — qr_judge reads none of this — so there is
# no 24h rule to respect. What a block DOES decide is the domain in force for
# its hours, so an edit changes what Engage and the NOW panel say you are on.
#
# Configure with QPA_URL, exactly as the gate tool is:
#   {"mcpServers": {"blocks": {"command": "python",
#     "args": ["ef-exobrain/mcp/blocks_mcp.py"],
#     "env": {"QPA_URL": "https://<vm>.<tailnet>.ts.net"}}}}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gates_mcp import (DAYS, ToolError, call, main, need_date,   # noqa: E402
                       need_reason, need_time)

# The app's weekday is 0 = Monday, the same order DAYS spells.
DAY_NAMES = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
# A block the week has never seen before still needs a colour; one of the
# palette's own, rather than one invented here.
DEFAULT_COLOR = '#98b9dd'


# HH:MM is a boundary format: parse once, compare minutes.
def minutes(hhmm):
    h, m = str(hhmm).split(':')[:2]
    return int(h) * 60 + int(m)


def need_days(a, key='days'):
    raw = a.get(key)
    if not isinstance(raw, list) or not raw:
        raise ToolError(f'{key} must be a non-empty list, e.g. ["mo","we","fr"]')
    out = []
    for d in raw:
        d = str(d).strip().lower()
        if d.isdigit() and int(d) < 7:
            out.append(int(d))
        elif d[:2] in DAYS:
            out.append(DAYS.index(d[:2]))
        else:
            raise ToolError(f'{d!r} is not a day: use mo tu we th fr sa su')
    return sorted(set(out))


def need_day(a, key='day'):
    return need_days({key: [a.get(key)]}, key)[0]


def filing(a):
    # An area OR a domain OR nothing, never both — storage.filing_updates keeps
    # the pair exclusive, so the tool only has to not send both.
    if a.get('area_id') is not None and a.get('domain_id') is not None:
        raise ToolError('file a block under an area OR a domain, not both')
    return {'area_id': a.get('area_id'), 'domain_id': a.get('domain_id')}


def names():
    return ({x['id']: x['name'] for x in call('GET', '/api/areas')},
            {x['id']: x['name'] for x in call('GET', '/api/domains')})


def block_line(b, areas, domains):
    filed = (f"area: {areas.get(b['area_id'], b['area_id'])}" if b.get('area_id')
             else f"domain: {domains.get(b['domain_id'], b['domain_id'])}" if b.get('domain_id')
             else 'unfiled')
    out = {'block_id': b['id'], 'label': b['label'], 'day': DAYS[b['day_of_week']],
           'start': b['start_time'], 'end': b['end_time'],
           'crosses_midnight': minutes(b['end_time']) <= minutes(b['start_time']),
           'filed_under': filed, 'active': bool(b['active']), 'color': b['color']}
    if b.get('location_name'):
        out['location'] = b['location_name']
    if b.get('description'):
        out['description'] = b['description']
    if b.get('scheduled_changes'):
        out['scheduled_changes'] = [{'field': c['field'], 'to': c['new_value'],
                                     'from_day': c['effective_date']}
                                    for c in b['scheduled_changes']]
    return out


def one_block(block_id):
    b = next((x for x in call('GET', '/api/blocks') if x['id'] == int(block_id)), None)
    if not b:
        raise ToolError(f'no block {block_id} — list_blocks gives the ids')
    return b


def list_blocks(a):
    areas, domains = names()
    rows = call('GET', '/api/blocks')
    return {
        'week': [block_line(b, areas, domains) for b in rows],
        'areas': [{'area_id': k, 'name': v} for k, v in areas.items()],
        'domains': [{'domain_id': k, 'name': v} for k, v in domains.items()],
        'locations': [{'location_id': x['id'], 'name': x['name']}
                      for x in call('GET', '/api/locations') if x.get('active')],
        'note': 'each block is ONE weekday; a block on five days is five rows',
    }


def get_day(a):
    date = need_date(a)
    segs = call('GET', f'/api/blocks/day?date={date}&all=1')
    fmt = lambda m: f'{(m // 60) % 24:02d}:{m % 60:02d}' + (' (+1 day)' if m >= 1440 else '')
    return {'date': date, 'blocks': [{
        'block_id': s['block_id'], 'label': s['label'],
        'start': 'from the day before' if s['start'] < 0 else fmt(s['start']),
        'end': fmt(s['end']), 'cancelled': bool(s.get('cancelled')),
        'changed_for_this_day': bool(s.get('overridden'))} for s in segs]}


def add_block(a):
    reason = need_reason(a)
    label = str(a.get('label') or '').strip()
    if not label:
        raise ToolError('a block needs a label')
    days = need_days(a)
    start, _ = need_time(a, 'start')
    end, _ = need_time(a, 'end')
    color = a.get('color')
    if not color:
        same = [b for b in call('GET', '/api/blocks') if b['label'].lower() == label.lower()]
        color = same[0]['color'] if same else DEFAULT_COLOR
    body = dict(filing(a), label=label, color=color, days=days, start_time=start, end_time=end,
                location_id=a.get('location_id'), description=a.get('description') or '')
    made = call('POST', '/api/blocks', body, reason)
    return {'ok': True, 'block_ids': [b['id'] for b in made],
            'added': f"{label} {' '.join(DAYS[d] for d in days)} {start}–{end}"}


EDITABLE = ('label', 'color', 'day', 'start', 'end', 'area_id', 'domain_id', 'location_id',
            'description')


def update_block(a):
    reason = need_reason(a)
    b = one_block(a.get('block_id'))
    given = {k for k in EDITABLE if k in a}
    if not given:
        raise ToolError(f'nothing to change — give any of {", ".join(EDITABLE)}')
    ch = {}
    if 'label' in a:
        ch['label'] = str(a['label']).strip() or b['label']
    if 'color' in a:
        ch['color'] = a['color']
    if 'day' in a:
        ch['day_of_week'] = need_day(a)
    if 'start' in a:
        ch['start_time'] = need_time(a, 'start')[0]
    if 'end' in a:
        ch['end_time'] = need_time(a, 'end')[0]
    if 'area_id' in a or 'domain_id' in a:
        ch.update(filing(a))
    if 'location_id' in a:
        ch['location_id'] = a['location_id']
    if 'description' in a:
        ch['description'] = a['description'] or ''
    if a.get('effective_from'):
        # DATED: only what moves, from that day; nothing about today changes.
        body = dict(ch, effective_from=need_date(a, 'effective_from'))
        call('PATCH', f"/api/blocks/{b['id']}", body, reason)
        return {'ok': True, 'block_id': b['id'], 'from_day': body['effective_from'],
                'note': 'scheduled; cancel_scheduled_change calls it off'}
    # NOW: the route replaces the whole row, so the rest is sent as it stands.
    body = {'label': b['label'], 'color': b['color'], 'day_of_week': b['day_of_week'],
            'start_time': b['start_time'], 'end_time': b['end_time'],
            'area_id': b['area_id'], 'domain_id': b['domain_id'],
            'location_id': b['location_id']}
    if 'area_id' in ch or 'domain_id' in ch:
        body['area_id'], body['domain_id'] = ch.pop('area_id'), ch.pop('domain_id')
    body.update(ch)
    out = call('PATCH', f"/api/blocks/{b['id']}", body, reason)
    return {'ok': True, 'block': f"{out['label']} {DAYS[out['day_of_week']]} "
                                 f"{out['start_time']}–{out['end_time']}"}


def set_block_active(a):
    reason = need_reason(a)
    b = one_block(a.get('block_id'))
    active = 1 if a.get('active') else 0
    body = {'active': active}
    if a.get('effective_from'):
        body['effective_from'] = need_date(a, 'effective_from')
    call('PATCH', f"/api/blocks/{b['id']}", body, reason)
    return {'ok': True, 'block_id': b['id'], 'active': bool(active),
            'from_day': body.get('effective_from', 'now')}


def delete_block(a):
    reason = need_reason(a)
    b = one_block(a.get('block_id'))
    q = ''
    if a.get('effective_from'):
        q = '?effective_from=' + need_date(a, 'effective_from')
    call('DELETE', f"/api/blocks/{b['id']}{q}", None, reason)
    return {'ok': True, 'deleted': f"{b['label']} {DAYS[b['day_of_week']]}",
            'from_day': a.get('effective_from') or 'now'}


def cancel_scheduled_change(a):
    reason = need_reason(a)
    b = one_block(a.get('block_id'))
    field = str(a.get('field') or '')
    if not any(c['field'] == field for c in b.get('scheduled_changes') or []):
        raise ToolError(f'block {b["id"]} has no scheduled change to {field!r} — '
                        'list_blocks shows its scheduled_changes')
    call('DELETE', f"/api/blocks/{b['id']}/scheduled/{field}", None, reason)
    return {'ok': True, 'block_id': b['id'], 'called_off': field}


def set_day_hours(a):
    date, reason = need_date(a), need_reason(a)
    start, _ = need_time(a, 'start')
    end, _ = need_time(a, 'end')
    call('POST', '/api/overrides', {'block_id': int(a['block_id']), 'date': date,
                                    'cancelled': False, 'start_time': start, 'end_time': end},
         reason)
    return {'ok': True, 'date': date, 'hours': f'{start}–{end}',
            'note': 'this day only; the weekly block is unchanged'}


def cancel_day(a):
    date, reason = need_date(a), need_reason(a)
    call('POST', '/api/overrides', {'block_id': int(a['block_id']), 'date': date,
                                    'cancelled': True}, reason)
    return {'ok': True, 'date': date, 'note': 'cancelled for this day only'}


def restore_day(a):
    date, reason = need_date(a), need_reason(a)
    bid = int(a['block_id'])
    # The route also returns yesterday's rows (for overnight blocks), so the
    # match is on the exact date, never "the first row".
    ov = next((o for o in call('GET', f'/api/overrides?date={date}')
               if o['block_id'] == bid and o['date'] == date), None)
    if not ov:
        return {'ok': True, 'date': date, 'note': 'nothing to restore — the day already follows the week'}
    call('DELETE', f"/api/overrides/{ov['id']}", None, reason)
    return {'ok': True, 'date': date, 'note': 'the day follows the weekly block again'}


DATE = {'type': 'string', 'description': 'YYYY-MM-DD, the day it is about'}
BLOCK = {'type': 'integer', 'description': 'the block_id from list_blocks or get_day'}
REASON = {'type': 'string', 'description': 'why — shown to Quentin beside the change'}
TIME = {'type': 'string', 'description': 'HH:MM, 24-hour; an end at or before the start runs past midnight'}
DAYSLIST = {'type': 'array', 'items': {'type': 'string'}, 'description': 'e.g. ["mo","we","fr"]'}
EFFECTIVE = {'type': 'string', 'description': 'optional YYYY-MM-DD: schedule the change to start '
                                              'that day instead of now'}
AREA = {'type': 'integer', 'description': 'file under this area (not with domain_id); null unfiles'}
DOMAIN = {'type': 'integer', 'description': 'file under this domain (not with area_id); null unfiles'}
LOCATION = {'type': 'integer', 'description': 'optional location_id from list_blocks'}

TOOLS = {
    'list_blocks': (list_blocks, 'The whole weekly block schedule, one row per block per weekday, '
                    'with what each is filed under and any changes already scheduled — plus the '
                    'areas, domains and locations a block can be given.', {}, []),
    'get_day': (get_day, 'The blocks in force on one date as the app resolves it: that day\'s own '
                'changes applied, cancelled ones marked.', {'date': DATE}, ['date']),
    'add_block': (add_block, 'Add a weekly block on one or more weekdays (one row per day). Refused '
                  'if it overlaps an active block on that day. Colour defaults to an existing '
                  'block with the same label.',
                  {'label': {'type': 'string'}, 'days': DAYSLIST, 'start': TIME, 'end': TIME,
                   'color': {'type': 'string', 'description': 'optional #rrggbb'},
                   'area_id': AREA, 'domain_id': DOMAIN, 'location_id': LOCATION,
                   'description': {'type': 'string'}, 'reason': REASON},
                  ['label', 'days', 'start', 'end', 'reason']),
    'update_block': (update_block, 'Change one weekly block (one weekday\'s row): any of label, '
                     'color, day, start, end, area_id / domain_id, location_id, description. Only '
                     'what you give changes. With effective_from it is scheduled from that day '
                     'and the week before it is left alone.',
                     {'block_id': BLOCK, 'label': {'type': 'string'}, 'color': {'type': 'string'},
                      'day': {'type': 'string', 'description': 'mo tu we th fr sa su'},
                      'start': TIME, 'end': TIME, 'area_id': AREA, 'domain_id': DOMAIN,
                      'location_id': LOCATION, 'description': {'type': 'string'},
                      'effective_from': EFFECTIVE, 'reason': REASON},
                     ['block_id', 'reason']),
    'set_block_active': (set_block_active, 'Pause (active=false) or resume (active=true) a weekly '
                         'block. Paused keeps it, and stops it running.',
                         {'block_id': BLOCK, 'active': {'type': 'boolean'},
                          'effective_from': EFFECTIVE, 'reason': REASON},
                         ['block_id', 'active', 'reason']),
    'delete_block': (delete_block, 'Delete a weekly block (one weekday\'s row) — or, with '
                     'effective_from, schedule it to leave from that day. Prefer '
                     'set_block_active(false) when it might come back.',
                     {'block_id': BLOCK, 'effective_from': EFFECTIVE, 'reason': REASON},
                     ['block_id', 'reason']),
    'cancel_scheduled_change': (cancel_scheduled_change, 'Call off a change already scheduled on a '
                                'block (a field from its scheduled_changes, or "delete").',
                                {'block_id': BLOCK, 'field': {'type': 'string'}, 'reason': REASON},
                                ['block_id', 'field', 'reason']),
    'set_day_hours': (set_day_hours, 'Give a block different hours on ONE date; the weekly block '
                      'is unchanged.',
                      {'block_id': BLOCK, 'date': DATE, 'start': TIME, 'end': TIME, 'reason': REASON},
                      ['block_id', 'date', 'start', 'end', 'reason']),
    'cancel_day': (cancel_day, 'Cancel a block on ONE date; the weekly block is unchanged.',
                   {'block_id': BLOCK, 'date': DATE, 'reason': REASON},
                   ['block_id', 'date', 'reason']),
    'restore_day': (restore_day, 'Undo a date\'s cancellation or changed hours: the block follows '
                    'its weekly schedule that day again.',
                    {'block_id': BLOCK, 'date': DATE, 'reason': REASON},
                    ['block_id', 'date', 'reason']),
}


if __name__ == '__main__':
    main(TOOLS, 'qpa-blocks')
