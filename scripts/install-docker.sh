#!/usr/bin/env bash
# Install Docker Engine + Compose plugin on Ubuntu (incl. WSL2).
# Usage:  sudo bash scripts/install-docker.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "이 스크립트는 root로 실행해야 합니다:  sudo bash scripts/install-docker.sh" >&2
  exit 1
fi

# the non-root user who should be added to the docker group
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || echo "$USER")}"

echo "==> Ubuntu $(. /etc/os-release && echo "$VERSION_ID") / user=$TARGET_USER"

if command -v docker >/dev/null 2>&1; then
  echo "==> docker 이미 설치됨: $(docker --version)"
else
  echo "==> 사전 패키지 설치"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg

  echo "==> Docker 공식 GPG 키 등록"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  echo "==> apt 저장소 추가"
  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  echo "==> Docker Engine + Compose 설치"
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# WSL: ensure systemd is enabled so the docker service can run.
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "==> WSL 감지됨"
  if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
    echo "    /etc/wsl.conf 에 systemd=true 추가 (적용하려면 'wsl --shutdown' 후 재시작 필요)"
    { echo "[boot]"; echo "systemd=true"; } >> /etc/wsl.conf
  fi
fi

echo "==> docker 서비스 활성화"
if command -v systemctl >/dev/null 2>&1 && [[ "$(ps -p 1 -o comm=)" == "systemd" ]]; then
  systemctl enable --now docker || echo "    (systemctl 실패 — 'sudo service docker start' 로 시도하세요)"
else
  service docker start || echo "    (service 실패 — WSL에서 systemd 활성화 후 재시도)"
fi

echo "==> '$TARGET_USER' 를 docker 그룹에 추가 (sudo 없이 docker 사용)"
usermod -aG docker "$TARGET_USER" || true

echo
echo "✅ 완료. 그룹 적용을 위해 셸을 새로 열거나 다음 중 하나를 하세요:"
echo "   - WSL:  'wsl --shutdown' (PowerShell) 후 터미널 재시작"
echo "   - 또는: 'newgrp docker' 로 현재 셸에 즉시 적용"
echo
echo "확인:  docker run --rm hello-world"
