#!/bin/bash
# Run as root in the NEW dedicated unprivileged Incus container, after setup-host.sh.
# Never run in the Hermes container or on the Incus host.
set -euo pipefail
[ "$(hostname)" = npi ] && [ -S /run/npi-quota.sock ] || { echo 'Refusing installation outside the prepared npi container' >&2; exit 1; }
install -d -m700 /var/lib/npi-auth/agent /var/lib/npi-auth/config /var/lib/npi-gateway /etc/npi-models
install -d /var/lib/npi-gateway/bots
mountpoint -q /var/lib/npi-gateway/bots || { echo 'Missing host-managed project-quota storage' >&2; exit 1; }
cat > /etc/systemd/system/bots.slice <<'EOF'
[Unit]
Description=NPi Bot aggregate memory budget
[Slice]
MemoryMax=4G
MemorySwapMax=0
EOF
printf '%s\n' '{"cgroup-parent":"bots.slice","dns":["172.30.0.1"]}' > /etc/docker/daemon.json
systemctl daemon-reload
systemctl restart docker
/opt/npi/network.sh
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unbound
install -m644 /opt/npi/unbound.conf /etc/unbound/unbound.conf
install -d /etc/systemd/system/unbound.service.d
printf '[Unit]\nAfter=npi-network.service\nRequires=npi-network.service\n' > /etc/systemd/system/unbound.service.d/npi-network.conf
python3 - <<'PY'
import json, os, pathlib, subprocess
root = pathlib.Path('/var/lib/npi-auth')
common = {'HOME':str(root), 'XDG_CONFIG_HOME':str(root/'config'), 'PI_CODING_AGENT_DIR':str(root/'agent'), 'PATH':'/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}
model = {'id':'deepseek-flash','name':'DeepSeek Flash','reasoning':True,'input':['text'],'contextWindow':1048576,'maxTokens':8192}
(root/'agent/models.yml').write_text(json.dumps({'providers':{'deepseek':{'baseUrl':'https://api.deepseek.com/v1','api':'openai-completions','models':[model]}}}))
pathlib.Path('/etc/npi-models/template.json').write_text(json.dumps({'baseUrl':'http://172.30.0.1:4000','providers':[{'id':'deepseek','api':'openai-completions','models':[model]}]}))
clients=root/'clients.json'
if not clients.exists(): clients.write_text('{}')
os.chmod(clients,0o600)
(root/'agent/config.yml').write_text('models:\n  default: deepseek/deepseek-flash\nproviders:\n  cacheWarming:\n    enabled: false\n')
broker_token = subprocess.check_output(['/opt/npi/npi','auth-broker','token'],env=common,text=True).strip()
pathlib.Path('/etc/npi-auth.env').write_text('\n'.join(f'{k}={v}' for k,v in common.items())+'\nOMP_AUTH_BROKER_URL=http://127.0.0.1:8765\nOMP_AUTH_BROKER_TOKEN='+broker_token+'\n')
os.chmod('/etc/npi-auth.env',0o600)
pathlib.Path('/etc/npi-gateway.env').write_text('HOME=/var/lib/npi-gateway\nPI_CODING_AGENT_DIR=/var/lib/npi-gateway/agent\nNPI_GATEWAY_DIR=/var/lib/npi-gateway\nNPI_GATEWAY_BIND=127.0.0.1:8651\nNPI_GATEWAY_MODEL_CONFIG_DIR=/etc/npi-models\nNPI_GATEWAY_MODEL_CLIENTS_FILE=/var/lib/npi-auth/clients.json\nNPI_GATEWAY_QUOTA_ROOT=/var/lib/npi-gateway/bots\nNPI_GATEWAY_QUOTA_COMMAND=/usr/local/bin/npi-quota\nNPI_GATEWAY_IMAGE=npi-worker:withbot\nPATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n')
os.chmod('/etc/npi-gateway.env',0o600)
units = {
'npi-network': '''[Unit]
Description=NPi Bot bridge network isolation
After=docker.service
Requires=docker.service
Before=npi-auth-gateway.service npi-gateway.service
[Service]
Type=oneshot
ExecStart=/opt/npi/network.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
''',
'npi-auth-broker': '''[Unit]
Description=NPi trusted model credential broker
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/npi-auth.env
ExecStart=/opt/npi/npi auth-broker serve --bind=127.0.0.1:8765
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
''',
'npi-auth-gateway': '''[Unit]
Description=NPi scoped model proxy
After=npi-auth-broker.service npi-network.service
Requires=npi-auth-broker.service npi-network.service
[Service]
EnvironmentFile=/etc/npi-auth.env
ExecStart=/opt/npi/npi auth-gateway serve --bind=172.30.0.1:4000 --clients=/var/lib/npi-auth/clients.json
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
''',
'npi-gateway': '''[Unit]
Description=NPi Bot Gateway
After=npi-auth-gateway.service docker.service npi-network.service unbound.service
Requires=npi-auth-gateway.service docker.service npi-network.service unbound.service
RequiresMountsFor=/var/lib/npi-gateway/bots
[Service]
EnvironmentFile=/etc/npi-gateway.env
ExecStart=/opt/npi/npi gateway serve
Restart=on-failure
TimeoutStopSec=20
UMask=0077
[Install]
WantedBy=multi-user.target
'''
}
for name, unit in units.items(): pathlib.Path('/etc/systemd/system/'+name+'.service').write_text(unit)
PY
systemctl daemon-reload
systemctl enable --now npi-network
systemctl enable unbound
systemctl restart unbound
docker build --tag npi-worker:withbot /opt/npi
systemctl daemon-reload
systemctl enable --now npi-network npi-auth-broker npi-auth-gateway npi-gateway
systemctl is-active npi-auth-broker npi-auth-gateway npi-gateway
