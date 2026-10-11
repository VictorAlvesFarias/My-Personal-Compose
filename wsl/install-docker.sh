#!/usr/bin/env bash
# Installs Docker Engine from Docker's apt repository in this WSL distro and configures it.
# Run as root (setup-docker.ps1 does it). Safe to run again: it only redoes what is missing.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release

if ! command -v docker >/dev/null 2>&1; then
    echo "==> Docker apt repository"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl >/dev/null
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
    echo "==> Installing Docker Engine"
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi

# Every WSL 2 distro shares one network stack, WSL-Vpn's Ubuntu included:
# - ip-forward-no-drop keeps the FORWARD policy as it is (Docker would set it to DROP, breaking the
#   Windows tunnel that WSL-Vpn routes through Linux);
# - the networks come from 100.64.0.0/10 (carrier-grade NAT space), unlikely to clash with company
#   routes in 10.0.0.0/8 or 172.16.0.0/12 or with the home LAN.
echo "==> /etc/docker/daemon.json"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "ip-forward-no-drop": true,
  "bip": "100.89.0.1/24",
  "default-address-pools": [{ "base": "100.90.0.0/16", "size": 24 }],
  "log-driver": "local"
}
JSON
dockerd --validate --config-file /etc/docker/daemon.json

systemctl enable --quiet docker.service containerd.service
systemctl restart docker.service
docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version
