#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 sudo bash deploy/install.sh 执行。" >&2
  exit 1
fi
if [[ ! -f /etc/os-release ]]; then
  echo "此脚本仅支持 Ubuntu。" >&2
  exit 1
fi
source /etc/os-release
if [[ "${ID}" != ubuntu ]]; then
  echo "此脚本仅支持 Ubuntu。" >&2
  exit 1
fi

app_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_version=v22.23.3
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo "仅支持 x86_64 和 aarch64 服务器。" >&2; exit 1 ;;
esac
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
if [[ ! -x /opt/sky-ludo/runtime/bin/node ]] || [[ "$(/opt/sky-ludo/runtime/bin/node --version)" != "${node_version}" ]]; then
  for tool in curl xz sha256sum; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "缺少 ${tool}，请先安装 curl、xz-utils、coreutils。" >&2
      exit 1
    fi
  done
  install -d -o root -g root -m 0755 /opt/sky-ludo/downloads /opt/sky-ludo/runtime
  curl --fail --silent --show-error --location "https://nodejs.org/dist/${node_version}/${node_archive}" -o "/opt/sky-ludo/downloads/${node_archive}"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o /opt/sky-ludo/downloads/SHASUMS256.txt
  (
    cd /opt/sky-ludo/downloads
    checksum_line="$(awk -v file="${node_archive}" '$2 == file { print }' SHASUMS256.txt)"
    if [[ -z "${checksum_line}" ]]; then echo "未找到 Node 下载文件的校验值。" >&2; exit 1; fi
    printf '%s\n' "${checksum_line}" | sha256sum --check --strict -
  )
  tar -xJf "/opt/sky-ludo/downloads/${node_archive}" -C /opt/sky-ludo/runtime --strip-components=1
fi
if [[ "$(/opt/sky-ludo/runtime/bin/node --version)" != "${node_version}" ]]; then
  echo "Node 运行时版本校验失败。" >&2
  exit 1
fi

if ! id sky-ludo >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /opt/sky-ludo --shell /usr/sbin/nologin sky-ludo
fi
install -d -o root -g sky-ludo -m 0750 /opt/sky-ludo /opt/sky-ludo/current
if [[ "${app_source}" != /opt/sky-ludo/current ]]; then
  install -o root -g sky-ludo -m 0640 "${app_source}/server.mjs" "${app_source}/engine.mjs" "${app_source}/board.mjs" "${app_source}/package.json" /opt/sky-ludo/current/
  install -d -o root -g sky-ludo -m 0750 /opt/sky-ludo/current/public
  cp -a "${app_source}/public/." /opt/sky-ludo/current/public/
fi
chown root:sky-ludo /opt/sky-ludo/current/server.mjs /opt/sky-ludo/current/engine.mjs /opt/sky-ludo/current/board.mjs /opt/sky-ludo/current/package.json
chmod 0640 /opt/sky-ludo/current/server.mjs /opt/sky-ludo/current/engine.mjs /opt/sky-ludo/current/board.mjs /opt/sky-ludo/current/package.json
chown -R root:sky-ludo /opt/sky-ludo/current/public
find /opt/sky-ludo/current/public -type d -exec chmod 0750 {} +
find /opt/sky-ludo/current/public -type f -exec chmod 0640 {} +
install -o root -g root -m 0644 "${app_source}/deploy/sky-ludo.service" /etc/systemd/system/sky-ludo.service
systemctl daemon-reload
systemctl enable --now sky-ludo
systemctl restart sky-ludo

if command -v ufw >/dev/null 2>&1 && ufw status | head -n 1 | grep -q '^Status: active'; then
  ufw allow 8080/tcp comment 'Sky Ludo'
fi
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/health
printf '\n飞行棋已安装到 /opt/sky-ludo/current，监听 8080 端口。\n'
