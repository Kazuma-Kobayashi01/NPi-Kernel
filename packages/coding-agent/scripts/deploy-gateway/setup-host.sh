#!/bin/bash
# On the Incus host only. Existing `npi` must be this deployment's unprivileged container.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo 'run as root on the Incus host' >&2; exit 1; }
incus config set npi user.npi.gateway true
[ "$(incus config get npi security.privileged)" != true ] || { echo 'refusing a privileged controller' >&2; exit 1; }
incus config set npi limits.memory=8GiB limits.memory.swap=true security.nesting=true boot.autostart=true
incus config unset npi limits.cpu
incus config unset npi limits.processes
install -m755 "$SRC/apparmor-backport.py" /usr/local/sbin/npi-apparmor-backport
install -m755 "$SRC/quota-helper.py" /usr/local/sbin/npi-quota-helper
install -d /var/lib/npi-deploy/bots
if [ ! -e /var/lib/npi-deploy/bots.xfs ]; then
    truncate -s 32G /var/lib/npi-deploy/bots.xfs
    mkfs.xfs -q /var/lib/npi-deploy/bots.xfs
fi
MOUNT_UNIT=$(systemd-escape --path --suffix=mount /var/lib/npi-deploy/bots)
cat > "/etc/systemd/system/$MOUNT_UNIT" <<EOF
[Unit]
Description=NPi dedicated Bot storage
Before=incus.service
[Mount]
What=/var/lib/npi-deploy/bots.xfs
Where=/var/lib/npi-deploy/bots
Type=xfs
Options=loop,pquota
[Install]
WantedBy=local-fs.target
EOF
cat > /etc/systemd/system/npi-quota.service <<EOF
[Unit]
Description=NPi restricted project quota allocator
Requires=$MOUNT_UNIT
After=$MOUNT_UNIT
[Service]
ExecStart=/usr/bin/python3 /usr/local/sbin/npi-quota-helper
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/npi-nested-policy.service <<'EOF'
[Unit]
Description=Apply official Incus nesting fix only to NPi
After=incus.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/npi-apparmor-backport
EOF
cat > /etc/systemd/system/npi-nested-policy.path <<'EOF'
[Unit]
Description=Reapply NPi-only nesting fix when Incus regenerates its profile
After=incus.service
[Path]
PathChanged=/var/lib/incus/security/apparmor/profiles/incus-npi
Unit=npi-nested-policy.service
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$MOUNT_UNIT" npi-quota.service npi-nested-policy.path
/usr/local/sbin/npi-apparmor-backport
chown 1000000:1000000 /var/lib/npi-deploy/bots
if ! incus config device get npi bot-data source >/dev/null 2>&1; then
    incus config device add npi bot-data disk source=/var/lib/npi-deploy/bots path=/var/lib/npi-gateway/bots
fi
if ! incus config device get npi quota connect >/dev/null 2>&1; then
    incus config device add npi quota proxy bind=container listen=unix:/run/npi-quota.sock connect=unix:/run/npi-quota.sock mode=0600 uid=0 gid=0
fi
incus file push "$SRC/quota-client.py" npi/usr/local/bin/npi-quota --mode=0755
