# npi-relay

Relay for NPi Remote Connect (`npi remote start --relay <url>`). It routes encrypted
binary frames between one host and its paired phones, pipes pairing handshakes, and
sends FCM wake-ups when a phone does not acknowledge a push hint. It never sees
plaintext: payloads are end-to-end encrypted, and it stores only SHA-256 hashes of
host and device tokens. Protocol: [`docs/plan-android-remote-connect.md`](../docs/plan-android-remote-connect.md) §4 and §6.2.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /ws/host?hostId=` | `Bearer <relayHostToken>` (trust on first use; mismatch closes with 4401) | Host tunnel |
| `GET /ws/client?hostId=&deviceId=` | `Bearer <deviceToken>` (hash synced by the host) | Phone tunnel |
| `GET /ws/pair?role=host&hostId=&pairingId=&exp=` | host bearer | Offer a pairing (max 10 min) |
| `GET /ws/pair?role=device&pairingId=` | none | Join a pairing (one device) |
| `POST /api/devices/fcm-token` | device bearer, body `{hostId, deviceId, fcmToken}` | Register FCM token (`""` clears) |
| `GET /healthz` | none | Liveness |

Close codes: `4000` replaced by a newer connection, `4401` unauthorized/revoked, `4409` pairing conflict, `4410` pairing expired, `1008` protocol violation, `1013` slow consumer.

## Configuration

| Variable | Default | |
|---|---|---|
| `RELAY_LISTEN` | `:8787` | |
| `RELAY_DB` | `/data/relay.db` | SQLite (WAL) |
| `RELAY_FCM_CREDENTIALS` | unset (push off) | Firebase service-account JSON path |
| `RELAY_MAX_HOSTS` | `16` | Hosts that may register |
| `RELAY_PUSH_ACK_TIMEOUT` | `2s` | Wait for `relay.ack` before pushing |

## Build and test

Everything runs in Docker; no local Go toolchain is needed.

```sh
docker run --rm -v "$PWD":/src -w /src golang:1.27 go test -race ./...
```

## Deploy, roll back, back up

```sh
./deploy.sh            # build linux/amd64 npi-relay:<git sha>[-dirty.<time>], ship over ssh, start, health-check
./deploy.sh rollback   # restart the previously deployed image (run again to go forward)
```

`deploy.sh` targets `RELAY_SSH_HOST` (default `labserver-relay`) and checks `RELAY_PUBLIC_URL/healthz`
(default `https://35.213.93.187/relay`). The deploy user needs passwordless `sudo`. On the server it
installs `/opt/npi-relay/{compose.yaml,backup.sh}`, records the running tag in `/opt/npi-relay/.env`
and the previous one in `.previous-tag`, keeps only those two images, and rolls back by itself when the
new container is not healthy within 60s.

Backups: `/etc/cron.d/npi-relay-backup` runs `backup.sh` daily at 03:17 (server time), writing
`/var/backups/npi-relay/relay-<UTC>.db.gz` (root-only, last 14 kept, integrity-checked; log tag
`npi-relay-backup`). Restore: `docker compose stop`, `gunzip -c <backup> >` the volume's `relay.db`
(owner `65532:65532`), delete its `-wal`/`-shm`, `docker compose start`. The database holds only token
hashes and FCM tokens; a lost database means hosts re-register on their next connect, but phones need
`relay.devices` from their host before they can connect again.

First-time setup on a new server: add `nginx-relay.conf` to the HTTPS server block, then point hosts and
phones at `wss://<server>/relay`.
