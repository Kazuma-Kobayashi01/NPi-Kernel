#!/usr/bin/env python3
"""Only the trusted controller can call this socket; accepts a Bot ID, never a command or path."""
import json
import re
import socket
import sys

if len(sys.argv) != 2 or not re.fullmatch(r'(b[0-9a-f]{10}|labbot)', sys.argv[1]):
    raise SystemExit('invalid bot id')
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(40)
    client.connect('/run/npi-quota.sock')
    client.sendall(json.dumps({'botId': sys.argv[1]}).encode())
    result = json.loads(client.recv(4096))
    if result.get('ok') is not True:
        raise SystemExit('quota allocation failed')
    print(json.dumps(result))
