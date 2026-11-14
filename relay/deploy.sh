#!/usr/bin/env bash
# Build, ship and start the Relay on the server, or roll back to the previous image.
#
#   ./deploy.sh            build linux/amd64 image tagged with the git sha, deploy, health-check
#   ./deploy.sh rollback   restart the previously deployed image
#
# The server keeps the current and previous images only. A deploy whose container
# does not turn healthy within 60s is rolled back automatically.
set -euo pipefail

SSH_HOST="${RELAY_SSH_HOST:-labserver-relay}"
PUBLIC_URL="${RELAY_PUBLIC_URL:-https://35.213.93.187/relay}"
cd "$(dirname "$0")"

# Runs on the server as the deploy user (needs passwordless sudo and docker group).
remote_activate() {
	# shellcheck disable=SC2029 # mode and tag are meant to expand locally
	ssh "$SSH_HOST" "sudo -n bash -s -- $1 $2" <<'EOF'
set -euo pipefail
mode=$1 tag=$2
cd /opt/npi-relay
current=$(sed -n 's/^RELAY_IMAGE_TAG=//p' .env 2>/dev/null || true)
current=${current:-latest}
previous=$(cat .previous-tag 2>/dev/null || true)
if [ "$mode" = rollback ]; then
	[ -n "$previous" ] || { echo "no previous deploy recorded" >&2; exit 1; }
	tag=$previous
fi
start() {
	printf 'RELAY_IMAGE_TAG=%s\n' "$1" > .env
	docker compose up -d --remove-orphans >/dev/null
	for _ in $(seq 60); do
		status=$(docker inspect -f '{{.State.Health.Status}}' npi-relay 2>/dev/null || echo missing)
		[ "$status" = healthy ] && return 0
		sleep 1
	done
	return 1
}
if ! start "$tag"; then
	echo "npi-relay:$tag did not become healthy; restoring npi-relay:$current" >&2
	docker logs --tail 20 npi-relay >&2 || true
	start "$current"
	exit 1
fi
echo "$current" > .previous-tag
echo "running npi-relay:$tag (previous: $current)"
for image in $(docker image ls npi-relay --format '{{.Tag}}'); do
	if [ "$image" != "$tag" ] && [ "$image" != "$current" ] && [ "$image" != "<none>" ]; then
		if docker image rm "npi-relay:$image" >/dev/null; then echo "pruned npi-relay:$image"; fi
	fi
done
EOF
}

check_public() {
	local body
	body=$(curl -fsS --max-time 10 "$PUBLIC_URL/healthz")
	[ "$body" = ok ] || { echo "public healthz returned: $body" >&2; exit 1; }
	echo "public $PUBLIC_URL/healthz ok"
}

if [ "${1:-}" = rollback ]; then
	remote_activate rollback -
	check_public
	exit 0
fi
[ $# -eq 0 ] || { echo "usage: $0 [rollback]" >&2; exit 2; }

tag=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain -- .)" ]; then
	tag="$tag-dirty.$(date -u +%Y%m%d%H%M%S)"
fi
echo "building npi-relay:$tag"
docker buildx build --progress=quiet --platform linux/amd64 -t "npi-relay:$tag" --load . >/dev/null
docker save "npi-relay:$tag" | gzip | ssh "$SSH_HOST" 'gunzip | docker load' >/dev/null
docker image rm "npi-relay:$tag" >/dev/null

scp -q compose.yaml backup.sh "$SSH_HOST:/tmp/"
ssh "$SSH_HOST" "sudo -n bash -s" <<'EOF'
set -euo pipefail
install -d -m 755 /opt/npi-relay
install -m 644 /tmp/compose.yaml /opt/npi-relay/compose.yaml
install -m 755 /tmp/backup.sh /opt/npi-relay/backup.sh
rm -f /tmp/compose.yaml /tmp/backup.sh
printf '%s\n' 'PATH=/usr/sbin:/usr/bin:/sbin:/bin' '17 3 * * * root /opt/npi-relay/backup.sh 2>&1 | logger -t npi-relay-backup' > /etc/cron.d/npi-relay-backup
chmod 644 /etc/cron.d/npi-relay-backup
EOF

remote_activate deploy "$tag"
check_public
