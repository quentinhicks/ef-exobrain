#!/usr/bin/env python3
# THE ASSISTANT CAN DO WHAT THE INTERFACE CAN (2026-10-21, Quentin's
# instruction: "the assistant tools should aim to be able to do everything
# someone who uses the app's interface can do").
#
# The interface is a client of the app's own JSON routes, so the one way to
# keep up with it — every route it has now and every one added later — is to
# offer the routes themselves: `app_request` sends one request to any /api
# path, through the same doors app.js, gates.js and panel.js use, and so meets
# the same rules there (the 24h easing wait, the lock, the frozen judged day).
# The named tools (mcp/gates_mcp.py, mcp/blocks_mcp.py) stay the first reach
# for what they cover; they carry the semantics this one leaves to the caller.
# The routes are in ef-exobrain/app.py — read them before writing.
#
# Shares gates_mcp's plumbing: the same HTTP client, the same
# `X-QPA-Actor: assistant` mark with the reason in `X-QPA-Reason` (logged in
# Settings -> AI changes), the same JSON-RPC loop.
#
# Configure with QPA_URL, exactly as the gate tool is:
#   {"mcpServers": {"app": {"command": "python",
#     "args": ["ef-exobrain/mcp/app_mcp.py"],
#     "env": {"QPA_URL": "https://<vm>.<tailnet>.ts.net"}}}}
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gates_mcp import ToolError, call, main, need_reason   # noqa: E402

METHODS = ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')


def app_request(a):
    method = str(a.get('method') or '').upper()
    if method not in METHODS:
        raise ToolError(f'method must be one of {", ".join(METHODS)}')
    path = str(a.get('path') or '')
    if not path.startswith('/api/'):
        raise ToolError('path must be an /api/... route of the app (see ef-exobrain/app.py)')
    reason = None if method == 'GET' else need_reason(a)
    return call(method, path, a.get('body'), reason)


TOOLS = {
    'app_request': (app_request, 'Do anything the app\'s interface can: one request to any /api route '
                    '(the routes are in ef-exobrain/app.py — read the route before writing). Writes '
                    'are logged with the reason and meet the same rules the interface does. Prefer '
                    'the gates_ and blocks_ tools for what they cover.',
                    {'method': {'type': 'string', 'description': 'GET, POST, PUT, PATCH or DELETE'},
                     'path': {'type': 'string', 'description': 'e.g. /api/inbox or /api/settings, '
                              'with any ?query'},
                     'body': {'type': 'object', 'description': 'the JSON body, as the interface sends it'},
                     'reason': {'type': 'string', 'description': 'why — required for a write, shown '
                                'to Quentin beside the change'}},
                    ['method', 'path']),
}


if __name__ == '__main__':
    main(TOOLS, 'qpa-app')
