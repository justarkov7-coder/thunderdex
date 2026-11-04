"""A single private IPC call. Requests travel through stdin, not process args."""
import json
from pathlib import Path
import socket
import sys

request = sys.stdin.buffer.read(1048577)
if len(request) > 1048576:
    raise ValueError('Request too large')
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
    sock.settimeout(100)
    sock.connect(str(Path.home() / '.local/state/thunderdex/codex-ui.sock'))
    sock.sendall(request.rstrip(b'\n') + b'\n')
    if '--stream' in sys.argv:
        sock.settimeout(None)
        for response in sock.makefile('rb'):
            sys.stdout.buffer.write(response)
            sys.stdout.buffer.flush()
    else:
        response = sock.makefile('rb').readline(20000000)
        sys.stdout.buffer.write(response)
