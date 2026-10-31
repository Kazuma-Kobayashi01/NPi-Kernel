#!/usr/bin/env python3
"""Backport Incus PR #2624 to ONLY npi's generated nesting profile; never modify the managed source."""
import pathlib
import subprocess

source = pathlib.Path('/var/lib/incus/security/apparmor/profiles/incus-npi')
target = pathlib.Path('/etc/apparmor.d/incus-npi-backport')
text = source.read_text()
if 'profile "incus-npi_</var/lib/incus>"' not in text or '### Configuration: nesting' not in text:
    raise SystemExit('unexpected instance or profile; refusing policy change')
# Exact upstream conditional sections: omit these only for a nesting-enabled instance.
for start, end in [
    ('  # Block dangerous paths under /proc/sys', '  ### Feature: unix'),
    ('  ### Feature: apparmor stacking\n', '  change_profile ->'),
]:
    if text.count(start) != 1 or end not in text[text.index(start):]:
        raise SystemExit('unexpected Incus policy layout; refusing policy change')
    begin = text.index(start)
    finish = text.index(end, begin)
    text = text[:begin] + text[finish:]
target.write_text('# Incus nesting fix: https://github.com/lxc/incus/pull/2624\n' + text)
subprocess.run(['/usr/sbin/apparmor_parser', '-r', str(target)], check=True)
