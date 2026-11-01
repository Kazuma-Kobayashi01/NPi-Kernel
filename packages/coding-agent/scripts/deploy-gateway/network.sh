#!/bin/sh
# Run only inside the dedicated NPi Incus controller, before the gateway starts.
set -eu
if ! docker network inspect npi-bots >/dev/null 2>&1; then
    docker network create --driver bridge --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
        --opt com.docker.network.bridge.name=npi-bots \
        --opt com.docker.network.bridge.enable_icc=false \
        --label io.npi.gateway.firewall=managed npi-bots
fi
# Dedicated chains: do not alter the existing host or Hermes firewall.
iptables -N NPI-BOTS-INPUT 2>/dev/null || true
iptables -N NPI-BOTS-FORWARD 2>/dev/null || true
iptables -F NPI-BOTS-INPUT
iptables -F NPI-BOTS-FORWARD
iptables -A NPI-BOTS-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A NPI-BOTS-INPUT -d 172.30.0.1 -p tcp --dport 4000 -j ACCEPT
for protocol in udp tcp; do
    iptables -A NPI-BOTS-INPUT -d 172.30.0.1 -p "$protocol" --dport 53 -j ACCEPT
done
iptables -A NPI-BOTS-INPUT -j REJECT
iptables -A NPI-BOTS-FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
    iptables -A NPI-BOTS-FORWARD -d "$network" -j REJECT
done
iptables -A NPI-BOTS-FORWARD -j RETURN
iptables -C INPUT -s 172.30.0.0/24 -j NPI-BOTS-INPUT 2>/dev/null || iptables -I INPUT 1 -s 172.30.0.0/24 -j NPI-BOTS-INPUT
iptables -C DOCKER-USER -s 172.30.0.0/24 -j NPI-BOTS-FORWARD 2>/dev/null || iptables -I DOCKER-USER 1 -s 172.30.0.0/24 -j NPI-BOTS-FORWARD
# No IPv6 path is provisioned for the worker bridge.
ip6tables -C FORWARD -i npi-bots -j REJECT 2>/dev/null || ip6tables -I FORWARD 1 -i npi-bots -j REJECT
ip6tables -C INPUT -i npi-bots -j REJECT 2>/dev/null || ip6tables -I INPUT 1 -i npi-bots -j REJECT
