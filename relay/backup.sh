#!/bin/sh
# Nightly online backup of the Relay database (installed to /opt/npi-relay/backup.sh, run by cron as root).
# Uses SQLite's backup API, so it is consistent while the Relay keeps writing.
set -eu
VOLUME=npi-relay_npi-relay-data
DEST=/var/backups/npi-relay
KEEP=14

src="$(docker volume inspect "$VOLUME" --format '{{.Mountpoint}}')/relay.db"
umask 077
mkdir -p "$DEST"
out="$DEST/relay-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$src" ".backup '$out'"
if [ "$(sqlite3 "$out" 'PRAGMA integrity_check;')" != "ok" ]; then
	echo "integrity check failed for $out" >&2
	rm -f "$out"
	exit 1
fi
gzip "$out"
ls -1t "$DEST"/relay-*.db.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup written: $out.gz"
