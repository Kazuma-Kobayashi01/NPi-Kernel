#!/usr/bin/env python3
"""Command agent of the sandbox VM.

Speaks the plugin's line protocol (src/protocol.ts) with the host helper over the second virtio console port
(/dev/hvc1): one JSON object per line, several commands in flight at once. `exec` runs a command with bash
and streams its output (stdout and stderr merged) back; commands with the same sessionKey share exported
variables and functions, the way one persistent shell would. `mount` attaches a virtio-fs share, `cancel`
kills a running command, `release` forgets a session, `poweroff` shuts the guest down. The `pty-*` ops run an
interactive bash on a pseudo-terminal (the Desktop's terminal panel): `pty-open` starts it, `pty-input` and
`pty-resize` drive it, `pty-close` ends it; its output and exit come back as `pty` and `pty-exit` lines that carry a
`ptyId` instead of a request id.
"""
import base64
import codecs
import fcntl
import ctypes
import hashlib
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import tty

PORT = "/dev/hvc1"
STATE_ROOT = "/run/npi"
BASE_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "USER": "root",
    "SHELL": "/bin/bash",
    "TERM": "dumb",
}

# Runs one command in the session's state: variables and functions the earlier commands left, then the command,
# then (on any exit) what it left for the next one. The command text is sourced from a file, so it is parsed
# exactly as typed, `exit N` included.
WRAPPER = r"""
S="$NPI_STATE"
[ -f "$S/env" ] && . "$S/env" 2>/dev/null
[ -f "$S/funcs" ] && . "$S/funcs" 2>/dev/null
if [ -n "$NPI_CWD" ]; then cd "$NPI_CWD" || exit 1; fi
trap 'export -p | grep -v -E "^declare -x (PWD|OLDPWD|SHLVL|_|NPI_[A-Z]+)=" > "$S/env.tmp" 2>/dev/null && mv "$S/env.tmp" "$S/env"; declare -f > "$S/funcs.tmp" 2>/dev/null && mv "$S/funcs.tmp" "$S/funcs"; pwd > "$S/cwd"' EXIT
. "$NPI_CMDFILE"
"""

write_lock = threading.Lock()
jobs_lock = threading.Lock()
jobs = {}  # request id -> {"proc": Popen, "cancelled": bool, "timed_out": bool}
port_fd = -1


def send(message):
    data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
    with write_lock:
        view = memoryview(data)
        while view:
            written = os.write(port_fd, view)
            view = view[written:]


def state_dir(key):
    path = os.path.join(STATE_ROOT, "s", hashlib.sha1(key.encode("utf-8")).hexdigest()[:20])
    os.makedirs(path, exist_ok=True)
    return path


def kill_group(proc, sig=signal.SIGKILL):
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def run_exec(request):
    rid = request["id"]
    key = request.get("sessionKey") or "anonymous-%d" % rid
    sdir = state_dir(key)
    cmd_dir = os.path.join(STATE_ROOT, "c")
    os.makedirs(cmd_dir, exist_ok=True)
    cmd_file = os.path.join(cmd_dir, "%d.sh" % rid)
    with open(cmd_file, "w", encoding="utf-8") as handle:
        handle.write(request.get("command", ""))
        handle.write("\n")
    cwd = request.get("cwd") or ""
    env = dict(BASE_ENV)
    for name, value in (request.get("env") or {}).items():
        if isinstance(name, str) and isinstance(value, str):
            env[name] = value
    env.update(NPI_STATE=sdir, NPI_CWD=cwd, NPI_CMDFILE=cmd_file)
    job = {"cancelled": False, "timed_out": False}
    try:
        proc = subprocess.Popen(
            ["bash", "--noprofile", "--norc", "-c", WRAPPER],
            env=env, cwd="/", stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as error:
        send({"id": rid, "type": "error", "message": "could not start bash: %s" % error})
        return
    job["proc"] = proc
    with jobs_lock:
        jobs[rid] = job

    timeout_ms = request.get("timeoutMs")
    timer = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        def expire():
            job["timed_out"] = True
            kill_group(proc)
        timer = threading.Timer(timeout_ms / 1000.0, expire)
        timer.daemon = True
        timer.start()

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    fd = proc.stdout.fileno()

    def pump():
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                send({"id": rid, "type": "chunk", "data": text})

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    code = proc.wait()
    # A background process may keep the pipe open; give the output a moment, then let go of it.
    reader.join(timeout=1.0)
    if timer:
        timer.cancel()
    with jobs_lock:
        jobs.pop(rid, None)
    try:
        os.unlink(cmd_file)
    except OSError:
        pass

    exit_message = {"id": rid, "type": "exit"}
    if job["timed_out"]:
        exit_message["timedOut"] = True
    elif job["cancelled"] or code < 0:
        exit_message["cancelled"] = True
    else:
        exit_message["exitCode"] = code
        try:
            with open(os.path.join(sdir, "cwd"), encoding="utf-8") as handle:
                where = handle.read().strip()
            if where and where != cwd:
                exit_message["workingDir"] = where
        except OSError:
            pass
    send(exit_message)


def do_mount(request):
    rid = request["id"]
    path = request["path"]
    try:
        os.makedirs(path, exist_ok=True)
        args = ["mount", "-t", "virtiofs"]
        if request.get("readOnly"):
            args += ["-o", "ro"]
        subprocess.run(args + [request["tag"], path], check=True, capture_output=True, text=True)
        send({"id": rid, "type": "result"})
    except subprocess.CalledProcessError as error:
        send({"id": rid, "type": "error", "message": (error.stderr or str(error)).strip()})
    except OSError as error:
        send({"id": rid, "type": "error", "message": str(error)})


def do_cancel(request):
    target = request.get("target")
    with jobs_lock:
        job = jobs.get(target)
    if job:
        job["cancelled"] = True
        kill_group(job["proc"])
    send({"id": request["id"], "type": "result"})


def do_release(request):
    key = request.get("sessionKey") or ""
    prefix = hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]
    shutil.rmtree(os.path.join(STATE_ROOT, "s", prefix), ignore_errors=True)
    # Background jobs of the session (`<key>:async:<id>`) have their own state folders.
    send({"id": request["id"], "type": "result"})


ptys = {}  # ptyId -> {"pid": int, "fd": int}
ptys_lock = threading.Lock()


def set_window(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0))


def pty_reader(pty_id, pid, fd):
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        send({"type": "pty", "ptyId": pty_id, "d": base64.b64encode(chunk).decode("ascii")})
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        code = 0
    with ptys_lock:
        ptys.pop(pty_id, None)
    try:
        os.close(fd)
    except OSError:
        pass
    send({"type": "pty-exit", "ptyId": pty_id, "code": code})


def do_pty_open(request):
    pty_id = request["ptyId"]
    cols = int(request.get("cols") or 80)
    rows = int(request.get("rows") or 24)
    cwd = request.get("cwd") or "/"
    env = dict(BASE_ENV)
    env.update(TERM=request.get("term") or "xterm-256color", PS1=r"\u@npi-vm:\w\$ ", HISTFILE="/dev/null")
    pid, fd = os.forkpty()
    if pid == 0:
        try:
            try:
                os.chdir(cwd)
            except OSError:
                os.chdir("/")
            os.execvpe("bash", ["bash", "--noprofile", "--norc", "-i"], env)
        finally:
            os._exit(127)
    set_window(fd, cols, rows)
    with ptys_lock:
        ptys[pty_id] = {"pid": pid, "fd": fd}
    threading.Thread(target=pty_reader, args=(pty_id, pid, fd), daemon=True).start()


def do_pty_input(request):
    with ptys_lock:
        entry = ptys.get(request.get("ptyId"))
    if entry:
        data = base64.b64decode(request.get("d") or "")
        view = memoryview(data)
        while view:
            view = view[os.write(entry["fd"], view):]


def do_pty_resize(request):
    with ptys_lock:
        entry = ptys.get(request.get("ptyId"))
    if entry:
        set_window(entry["fd"], int(request.get("cols") or 80), int(request.get("rows") or 24))


def do_pty_close(request):
    with ptys_lock:
        entry = ptys.get(request.get("ptyId"))
    if entry:
        try:
            os.killpg(entry["pid"], signal.SIGHUP)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.kill(entry["pid"], signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def do_poweroff(request):
    send({"id": request["id"], "type": "result"})
    os.sync()
    # reboot(2) with LINUX_REBOOT_CMD_POWER_OFF: no `poweroff` binary needed (an Ubuntu root has none without systemd).
    ctypes.CDLL(None, use_errno=True).reboot(0x4321FEDC)
    subprocess.run(["poweroff", "-f"], check=False)


HANDLERS = {"mount": do_mount, "cancel": do_cancel, "release": do_release, "poweroff": do_poweroff}
PTY_HANDLERS = {"pty-open": do_pty_open, "pty-input": do_pty_input, "pty-resize": do_pty_resize, "pty-close": do_pty_close}


def dispatch(request):
    op = request.get("op")
    rid = request.get("id")
    try:
        if op == "exec":
            threading.Thread(target=run_exec, args=(request,), daemon=True).start()
        elif op in HANDLERS:
            HANDLERS[op](request)
        elif op in PTY_HANDLERS:
            PTY_HANDLERS[op](request)
        else:
            send({"id": rid, "type": "error", "message": "unknown op %r" % op})
    except Exception as error:  # a bad request must not take the agent down
        send({"id": rid, "type": "error", "message": "%s: %s" % (type(error).__name__, error)})


def main():
    global port_fd
    port_fd = os.open(PORT, os.O_RDWR | os.O_NOCTTY)
    tty.setraw(port_fd, termios.TCSANOW)
    os.makedirs(STATE_ROOT, exist_ok=True)
    # `pty`: this agent runs terminals (`pty-*` ops); an older image's agent does not say so.
    send({"type": "state", "state": "running", "pty": True})
    buffer = b""
    while True:
        chunk = os.read(port_fd, 65536)
        if not chunk:
            continue
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                request = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            if isinstance(request, dict):
                dispatch(request)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
