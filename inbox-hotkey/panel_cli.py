import socket
import sys

# Fallback driver for the NOW-panel hotkeys, used only if AHK's own loopback
# call is blocked. Raw socket, no urllib — importing urllib.request costs
# ~450ms of interpreter time, which is the whole point of avoiding it here.
#   switch       -> open the switch form
#   interrupted  -> toggle the interruption mark

action = sys.argv[1] if len(sys.argv) > 1 else ''
if action not in ('switch', 'interrupted'):
    sys.exit(1)

req = (
    'POST /api/panel/' + action + ' HTTP/1.1\r\n'
    'Host: localhost\r\n'
    'Content-Length: 0\r\n'
    'Connection: close\r\n\r\n'
).encode()
try:
    s = socket.create_connection(('127.0.0.1', 5000), timeout=3)
    s.sendall(req)
    s.recv(64)
    s.close()
except Exception:
    pass
