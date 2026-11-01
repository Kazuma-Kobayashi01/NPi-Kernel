#!/usr/bin/env python3
"""Incus-host quota allocator. Only the NPi controller receives access to its Unix socket."""
import fcntl
import json
import os
import pathlib
import re
import socket
import subprocess

ROOT = pathlib.Path('/var/lib/npi-deploy/bots')
STATE = pathlib.Path('/var/lib/npi-deploy/projects.json')
SOCKET = '/run/npi-quota.sock'


def provision(bot):
    if not isinstance(bot, str) or not re.fullmatch(r'(b[0-9a-f]{10}|labbot)', bot):
        raise ValueError('invalid bot id')
    # Incus 6 can reload its old policy at container startup before the path
    # watcher runs. Finish the NPi-only fix before permitting Docker provisioning.
    subprocess.run(['/usr/local/sbin/npi-apparmor-backport'], check=True, timeout=15, stdout=subprocess.DEVNULL)
    with open(str(STATE) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        projects = json.loads(STATE.read_text()) if STATE.exists() else {}
        if bot not in projects:
            projects[bot] = max([10000] + list(projects.values())) + 1
            temporary = STATE.with_suffix('.tmp')
            temporary.write_text(json.dumps(projects))
            os.chmod(temporary, 0o600)
            os.replace(temporary, STATE)
        directory = ROOT / bot
        if directory.is_symlink():
            raise ValueError('invalid directory')
        directory.mkdir(mode=0o700, exist_ok=True)
        # The controller may rename entries in its mount. Pin a real directory;
        # never let a path substitution redirect privileged host operations.
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            project = projects[bot]
            for command in [f'project -s -p /proc/self/fd/{fd}/. {project}', f'limit -p bhard=5g ihard=100000 {project}']:
                result = subprocess.run(['/usr/sbin/xfs_quota', '-x', '-c', command, str(ROOT)], capture_output=True, text=True, timeout=30, pass_fds=(fd,))
                if result.returncode or result.stderr.strip():
                    raise RuntimeError('quota allocation failed')
            os.fchown(fd, 1001000, 1001000)
        finally:
            os.close(fd)
        return {'ok': True, 'bytes': 5368709120, 'inodes': 100000}


if __name__ == '__main__':
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        server.listen(8)
        while True:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(35)
                try:
                    request = json.loads(connection.recv(1024))
                    if set(request) != {'botId'}:
                        raise ValueError('invalid request')
                    response = provision(request['botId'])
                except Exception:
                    response = {'ok': False, 'error': 'quota allocation failed'}
                try:
                    connection.sendall(json.dumps(response).encode() + b'\n')
                except OSError:
                    pass
