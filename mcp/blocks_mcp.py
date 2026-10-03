#!/usr/bin/env python3
# A CLAUDE CODE TOOL FOR THE WEEKLY BLOCK SCHEDULE (2026-09-30, Quentin's
# instruction: "create a tool such that AI could edit my weekly block
# schedule").
#
# TWO FAMILIES, NAMED APART (2026-10-03, Quentin's instruction: "there is a
# difference between global changes and local day to day changes, and do NOT
# mix the two"). `week_*` tools write the WEEK — every <weekday> from now, or
# from an effective_from. `day_*` tools write ONE DATE and nothing else: a
# weekly block's hours or cancellation that day, or a block that exists on
# that date only (`day_block`). The prefix is the contract, so a model reading
# the tool list cannot reach for a weekly write to plan one Tuesday — that was
# the only road before, and it filed a local fact in the global store. The
# server refuses the mix too: a date on a weekly route, a weekday on a day
# route.
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
from datetime import date as date_cls, datetime, timedelta

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
        raise ToolError(f'no block {block_id} — week_list or days_view gives the ids')
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


def fmt(m):
    return f'{(m // 60) % 24:02d}:{m % 60:02d}' + (' (+1 day)' if m >= 1440 else '')


def span(a):
    # HH:MM in, minutes from the date's midnight out; an end at or before the
    # start runs past midnight. Parsed once — never compare the strings.
    _, s = need_time(a, 'start')
    _, e = need_time(a, 'end')
    if e <= s:
        e += 1440
    return s, e


def events_on(date, events):
    # The calendar's timed events that START on this date, in this machine's
    # local time (the laptop and the app follow the same timezone).
    out = []
    for e in events:
        if e.get('allday'):
            continue
        try:
            s = datetime.fromisoformat(e['start'].replace('Z', '+00:00'))
            t = datetime.fromisoformat(e['end'].replace('Z', '+00:00'))
        except (KeyError, ValueError):
            continue
        if s.tzinfo is not None:
            s, t = s.astimezone(), t.astimezone()
        if s.date().isoformat() != date:
            continue
        sm = s.hour * 60 + s.minute
        out.append({'title': e.get('summary') or '', 'start': sm,
                    'end': sm + max(0, int((t - s).total_seconds() // 60))})
    return out


def seg_line(s):
    out = {'kind': 'day' if s.get('day_block_id') else 'weekly', 'label': s['label'],
           'start': 'from the day before' if s['start'] < 0 else fmt(s['start']),
           'end': fmt(s['end']), 'minutes': s['end'] - max(0, s['start'])}
    if s.get('day_block_id'):
        out['day_block_id'] = s['day_block_id']
    else:
        out['block_id'] = s['block_id']
        out['cancelled'] = bool(s.get('cancelled'))
        out['changed_for_this_day'] = bool(s.get('overridden'))
    if s.get('description'):
        out['description'] = s['description']
    return out


def free_gaps(busy, lo, hi):
    gaps, cur = [], lo
    for s, e in sorted(busy):
        if s > cur:
            gaps.append((cur, min(s, hi)))
        cur = max(cur, e)
        if cur >= hi:
            break
    if cur < hi:
        gaps.append((cur, hi))
    return [(s, e) for s, e in gaps if e - s >= 15]


def days_view(a):
    first = date_cls.fromisoformat(need_date(a, 'from'))
    last = date_cls.fromisoformat(need_date(a, 'to')) if a.get('to') else first
    if last < first or (last - first).days > 31:
        raise ToolError('give from <= to, at most a month apart')
    lo = need_time(a, 'awake_from')[1] if a.get('awake_from') else 8 * 60
    hi = need_time(a, 'awake_to')[1] if a.get('awake_to') else 23 * 60
    if hi <= lo:
        hi += 1440
    events = call('GET', '/api/gcal')
    days, totals = [], {}
    d = first
    while d <= last:
        ymd = d.isoformat()
        segs = call('GET', f'/api/blocks/day?date={ymd}&all=1')
        evs = events_on(ymd, events)
        live = [s for s in segs if not s.get('cancelled')]
        for s in live:
            if s['start'] >= 0:
                t = totals.setdefault(s['label'], [0, 0])
                t[1 if s.get('day_block_id') else 0] += s['end'] - s['start']
        busy = [(s['start'], s['end']) for s in live] + [(e['start'], e['end']) for e in evs]
        days.append({'date': ymd, 'weekday': DAY_NAMES[d.weekday()],
                     'blocks': [seg_line(s) for s in segs],
                     'events': [dict(e, start=fmt(e['start']), end=fmt(e['end'])) for e in evs],
                     'free': [f'{fmt(s)}–{fmt(e)} ({e - s} min)'
                              for s, e in free_gaps(busy, lo, hi)]})
        d += timedelta(days=1)
    return {'days': days,
            'hours_by_label': {k: {'weekly': round(w / 60, 2), 'day_only': round(o / 60, 2),
                                   'total': round((w + o) / 60, 2)}
                               for k, (w, o) in sorted(totals.items())},
            'note': f'free = covered by no block and no timed event, between {fmt(lo)} and '
                    f'{fmt(hi)}; a cancelled block is not busy'}


def clashes(date, s, e, skip=None):
    segs = call('GET', f'/api/blocks/day?date={date}')
    out = [f"{x['label']} {fmt(max(0, x['start']))}–{fmt(x['end'])}" for x in segs
           if not (skip and x.get('day_block_id') == skip) and x['start'] < e and s < x['end']]
    out += [f"event {x['title']} {fmt(x['start'])}–{fmt(x['end'])}"
            for x in events_on(date, call('GET', '/api/gcal')) if x['start'] < e and s < x['end']]
    return out


def refuse_clash(a, date, s, e, skip=None):
    if a.get('allow_overlap'):
        return
    hit = clashes(date, s, e, skip)
    if hit:
        raise ToolError(f'{date} {fmt(s)}–{fmt(e)} overlaps {"; ".join(hit)}. Cut what it '
                        'overlaps on this date first (day_cancel_block / day_set_block_hours) '
                        'if Quentin agreed to that tradeoff, or pass allow_overlap=true.')


def day_add_block(a):
    date, reason = need_date(a), need_reason(a)
    label = str(a.get('label') or '').strip()
    if not label:
        raise ToolError('a block needs a label')
    s, e = span(a)
    refuse_clash(a, date, s, e)
    color = a.get('color')
    if not color:
        same = [b for b in call('GET', '/api/blocks') if b['label'].lower() == label.lower()]
        color = same[0]['color'] if same else DEFAULT_COLOR
    body = dict(filing(a), date=date, start_min=s, end_min=e, label=label, color=color,
                location_id=a.get('location_id'), description=a.get('description') or '')
    made = call('POST', '/api/day-blocks', body, reason)
    return {'ok': True, 'day_block_id': made['id'],
            'added': f'{label} on {date} {fmt(s)}–{fmt(e)}',
            'note': 'this date only; the weekly schedule is unchanged'}


def one_day_block(a):
    i = a.get('day_block_id')
    if i is None:
        raise ToolError('give day_block_id — days_view lists them')
    b = next((x for x in call('GET', '/api/day-blocks?from=0001-01-01&to=9999-12-31')
              if x['id'] == int(i)), None)
    if not b:
        raise ToolError(f'no day block {i} — days_view lists them')
    return b


def day_update_block(a):
    reason = need_reason(a)
    b = one_day_block(a)
    body = {}
    date = need_date(a) if a.get('date') else b['date']
    if a.get('date'):
        body['date'] = date
    s, e = b['start_min'], b['end_min']
    if a.get('start') or a.get('end'):
        s, e = span({'start': a.get('start') or fmt(b['start_min'] % 1440),
                     'end': a.get('end') or fmt(b['end_min'] % 1440)})
        body['start_min'], body['end_min'] = s, e
    for k in ('label', 'color', 'location_id', 'description'):
        if k in a:
            body[k] = a[k]
    if 'area_id' in a or 'domain_id' in a:
        body.update(filing(a))
    if not body:
        raise ToolError('nothing to change — give date, start, end, label, color, area_id, '
                        'domain_id, location_id or description')
    if 'date' in body or 'start_min' in body:
        refuse_clash(a, date, s, e, skip=b['id'])
    out = call('PATCH', f"/api/day-blocks/{b['id']}", body, reason)
    return {'ok': True, 'day_block': f"{out['label']} on {out['date']} "
                                     f"{fmt(out['start_min'])}–{fmt(out['end_min'])}"}


def day_remove_block(a):
    reason = need_reason(a)
    b = one_day_block(a)
    call('DELETE', f"/api/day-blocks/{b['id']}", None, reason)
    return {'ok': True, 'removed': f"{b['label']} on {b['date']}",
            'note': 'that date only; nothing weekly existed to change'}


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
                        'week_list shows its scheduled_changes')
    call('DELETE', f"/api/blocks/{b['id']}/scheduled/{field}", None, reason)
    return {'ok': True, 'block_id': b['id'], 'called_off': field}


def day_set_block_hours(a):
    date, reason = need_date(a), need_reason(a)
    start, _ = need_time(a, 'start')
    end, _ = need_time(a, 'end')
    call('POST', '/api/overrides', {'block_id': int(a['block_id']), 'date': date,
                                    'cancelled': False, 'start_time': start, 'end_time': end},
         reason)
    return {'ok': True, 'date': date, 'hours': f'{start}–{end}',
            'note': 'this day only; the weekly block is unchanged'}


def day_cancel_block(a):
    date, reason = need_date(a), need_reason(a)
    call('POST', '/api/overrides', {'block_id': int(a['block_id']), 'date': date,
                                    'cancelled': True}, reason)
    return {'ok': True, 'date': date, 'note': 'cancelled for this day only'}


def day_restore_block(a):
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


DATE = {'type': 'string', 'description': 'YYYY-MM-DD, the one date it is about'}
BLOCK = {'type': 'integer', 'description': 'a WEEKLY block_id, from week_list or days_view'}
DAYBLOCK = {'type': 'integer', 'description': 'a day_block_id, from days_view or day_add_block'}
REASON = {'type': 'string', 'description': 'why — shown to Quentin beside the change'}
TIME = {'type': 'string', 'description': 'HH:MM, 24-hour; an end at or before the start runs past midnight'}
DAYSLIST = {'type': 'array', 'items': {'type': 'string'}, 'description': 'e.g. ["mo","we","fr"]'}
EFFECTIVE = {'type': 'string', 'description': 'optional YYYY-MM-DD: the WEEKLY change starts '
                                              'that day instead of now (and holds every week after)'}
AREA = {'type': 'integer', 'description': 'file under this area (not with domain_id); null unfiles'}
DOMAIN = {'type': 'integer', 'description': 'file under this domain (not with area_id); null unfiles'}
LOCATION = {'type': 'integer', 'description': 'optional location_id from week_list'}
OVERLAP = {'type': 'boolean', 'description': 'default false: refuse a clash with a block or event. '
                                             'True only when Quentin accepted the double-booking.'}

# Every description opens with which half it writes, in the same words.
WEEK = 'GLOBAL (every week): '
DAY = 'LOCAL (this date only; the week is untouched): '

TOOLS = {
    # ── READ ─────────────────────────────────────────────────
    'week_list': (list_blocks, 'The weekly block schedule: one row per block per weekday, what '
                  'each is filed under and changes already scheduled, plus the areas, domains '
                  'and locations a block can be given.', {}, []),
    'days_view': (days_view, "A run of dates (up to a month) as the app resolves them: every "
                  "block in force (kind 'weekly' or 'day'), cancelled ones marked, the "
                  "calendar's timed events, the FREE gaps, and hours per label across the range "
                  "— what a plan is made from.",
                  {'from': DATE, 'to': {'type': 'string', 'description': 'YYYY-MM-DD, default = from'},
                   'awake_from': {'type': 'string', 'description': 'HH:MM, where free gaps start '
                                  'each day (default 08:00)'},
                   'awake_to': {'type': 'string', 'description': 'HH:MM, where free gaps end '
                                'each day (default 23:00)'}},
                  ['from']),

    # ── LOCAL: one date ──────────────────────────────────────
    'day_add_block': (day_add_block, DAY + 'add a block that exists on this date and no other — '
                      'a one-off study session, an exam-week push. Refused if it overlaps a block '
                      'or event that day unless allow_overlap. Colour defaults to the weekly '
                      'block with the same label.',
                      {'date': DATE, 'label': {'type': 'string'}, 'start': TIME, 'end': TIME,
                       'color': {'type': 'string', 'description': 'optional #rrggbb'},
                       'area_id': AREA, 'domain_id': DOMAIN, 'location_id': LOCATION,
                       'description': {'type': 'string'}, 'allow_overlap': OVERLAP,
                       'reason': REASON},
                      ['date', 'label', 'start', 'end', 'reason']),
    'day_update_block': (day_update_block, DAY + 'move or edit a day block (one day_add_block '
                         'made): its date, hours, label, colour, filing or description.',
                         {'day_block_id': DAYBLOCK, 'date': DATE, 'start': TIME, 'end': TIME,
                          'label': {'type': 'string'}, 'color': {'type': 'string'},
                          'area_id': AREA, 'domain_id': DOMAIN, 'location_id': LOCATION,
                          'description': {'type': 'string'}, 'allow_overlap': OVERLAP,
                          'reason': REASON},
                         ['day_block_id', 'reason']),
    'day_remove_block': (day_remove_block, DAY + 'remove a day block.',
                         {'day_block_id': DAYBLOCK, 'reason': REASON},
                         ['day_block_id', 'reason']),
    'day_set_block_hours': (day_set_block_hours, DAY + 'give a WEEKLY block different hours on '
                            'this date — shorten it to make room, or move it.',
                            {'block_id': BLOCK, 'date': DATE, 'start': TIME, 'end': TIME,
                             'reason': REASON},
                            ['block_id', 'date', 'start', 'end', 'reason']),
    'day_cancel_block': (day_cancel_block, DAY + 'cancel a WEEKLY block on this date.',
                         {'block_id': BLOCK, 'date': DATE, 'reason': REASON},
                         ['block_id', 'date', 'reason']),
    'day_restore_block': (day_restore_block, DAY + "undo this date's cancellation or changed "
                          "hours: the weekly block runs as usual that day again.",
                          {'block_id': BLOCK, 'date': DATE, 'reason': REASON},
                          ['block_id', 'date', 'reason']),

    # ── GLOBAL: the week ─────────────────────────────────────
    'week_add_block': (add_block, WEEK + 'add a recurring block on one or more weekdays (one row '
                       'per day). NEVER for a one-off — that is day_add_block. Refused if it '
                       'overlaps an active weekly block.',
                       {'label': {'type': 'string'}, 'days': DAYSLIST, 'start': TIME, 'end': TIME,
                        'color': {'type': 'string', 'description': 'optional #rrggbb'},
                        'area_id': AREA, 'domain_id': DOMAIN, 'location_id': LOCATION,
                        'description': {'type': 'string'}, 'reason': REASON},
                       ['label', 'days', 'start', 'end', 'reason']),
    'week_update_block': (update_block, WEEK + 'change one weekly block row: any of label, '
                          'color, day, start, end, area_id / domain_id, location_id, '
                          'description. Only what you give changes. For one date, use the day_ '
                          'tools.',
                          {'block_id': BLOCK, 'label': {'type': 'string'},
                           'color': {'type': 'string'},
                           'day': {'type': 'string', 'description': 'mo tu we th fr sa su'},
                           'start': TIME, 'end': TIME, 'area_id': AREA, 'domain_id': DOMAIN,
                           'location_id': LOCATION, 'description': {'type': 'string'},
                           'effective_from': EFFECTIVE, 'reason': REASON},
                          ['block_id', 'reason']),
    'week_set_active': (set_block_active, WEEK + 'pause (active=false) or resume a weekly block. '
                        'To skip ONE date use day_cancel_block.',
                        {'block_id': BLOCK, 'active': {'type': 'boolean'},
                         'effective_from': EFFECTIVE, 'reason': REASON},
                        ['block_id', 'active', 'reason']),
    'week_delete_block': (delete_block, WEEK + 'delete a weekly block row, or with '
                          'effective_from schedule it to leave. Prefer week_set_active(false) '
                          'when it might come back.',
                          {'block_id': BLOCK, 'effective_from': EFFECTIVE, 'reason': REASON},
                          ['block_id', 'reason']),
    'week_cancel_scheduled_change': (cancel_scheduled_change, WEEK + 'call off a change already '
                                     'scheduled on a weekly block (a field from its '
                                     'scheduled_changes, or "delete").',
                                     {'block_id': BLOCK, 'field': {'type': 'string'},
                                      'reason': REASON},
                                     ['block_id', 'field', 'reason']),
}


if __name__ == '__main__':
    main(TOOLS, 'qpa-blocks')
