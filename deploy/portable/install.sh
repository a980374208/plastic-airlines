#!/usr/bin/env bash
# Ubuntu 22.04/24.04; run from the extracted package: sudo bash deploy/portable/install.sh
set -Eeuo pipefail
umask 027

usage() {
  cat <<'USAGE'
用法: sudo bash deploy/portable/install.sh [--update] [--confirm-end-rooms]
  无选项                  首次安装，不覆盖现有部署。
  --update                更新本部署包安装的服务；保留环境配置和旧版本备份。
  --confirm-end-rooms      明确允许更新时结束内存中的所有房间。
  --help                  显示帮助。
环境变量: NODE_VERSION=v22.23.3（默认）；可指定完整 v22.x.y 或 v24.x.y 版本。
安装目录: /opt/sky-ludo/current；独立 Node: /opt/sky-ludo/runtime。
环境配置: /etc/sky-ludo/sky-ludo.env；服务名: sky-ludo。
USAGE
}
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
update=0
confirm=0
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    --confirm-end-rooms) confirm=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $arg" ;;
  esac
done
(( confirm == 0 || update == 1 )) || die '--confirm-end-rooms 仅与 --update 一起使用。'
(( EUID == 0 )) || die '请使用 sudo 执行。'
[[ -r /etc/os-release ]] || die '无法识别操作系统。'
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == ubuntu && ( "$VERSION_ID" == 22.04 || "$VERSION_ID" == 24.04 ) ]] || die '仅支持 Ubuntu 22.04/24.04。'
[[ -d /run/systemd/system ]] || die '需要使用 systemd 的服务器环境。'
for tool in curl xz tar sha256sum awk install cp mv ss python3 flock systemctl useradd find getent; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少 $tool；先安装 ca-certificates curl xz-utils tar coreutils iproute2 python3 util-linux。"
done
exec 9>/run/lock/sky-ludo-deploy.lock
flock -n 9 || die '另一项飞行棋安装或 HTTPS 配置正在执行，请稍后再试。'

app_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
app_root=/opt/sky-ludo
unit=/etc/systemd/system/sky-ludo.service
env_file=/etc/sky-ludo/sky-ludo.env
marker="$app_root/portable-install"
node_version="${NODE_VERSION:-v22.23.3}"
[[ "$node_version" =~ ^v(22|24)\.[0-9]+\.[0-9]+$ ]] || die 'NODE_VERSION 必须是完整的 v22.x.y 或 v24.x.y 版本。'
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) die '仅支持 x86_64 和 aarch64。' ;;
esac
for file in server.mjs engine.mjs board.mjs package.json deploy/portable/sky-ludo.service; do
  [[ -f "$app_source/$file" && ! -L "$app_source/$file" ]] || die "部署包缺少普通文件: $file"
done
[[ -d "$app_source/public" && ! -L "$app_source/public" ]] || die '部署包缺少 public 目录。'
[[ -z "$(find "$app_source/public" -type l -print -quit)" ]] || die 'public 中不能包含符号链接。'
for path in "$app_root" "$app_root/current" "$app_root/runtime" "$marker" /etc/sky-ludo "$env_file" "$unit"; do
  [[ ! -L "$path" ]] || die "拒绝覆盖符号链接: $path"
done
if (( update )); then
  [[ -f "$marker" && "$(cat "$marker")" == sky-ludo-portable-v1 ]] || die '此安装器只更新由本部署包安装的服务，不自动接管旧部署。'
  [[ -d "$app_root/current" && -x "$app_root/runtime/bin/node" && -f "$unit" && -f "$env_file" ]] || die '现有安装不完整，请先检查，不进行覆盖。'
  for file in server.mjs engine.mjs board.mjs package.json public; do
    [[ ! -L "$app_root/current/$file" ]] || die "现有应用包含符号链接，拒绝覆盖: $file"
  done
  [[ ! -d "$app_root/current/public" || -z "$(find "$app_root/current/public" -type l -print -quit)" ]] || die '现有 public 中存在符号链接，拒绝覆盖。'
else
  [[ ! -e "$marker" && ! -e "$app_root/current" && ! -e "$app_root/runtime" && ! -e "$unit" && ! -e "$env_file" ]] || die '已有部署，请使用 --update；非本部署包安装的服务需先手动迁移。'
  [[ "$(systemctl show sky-ludo.service -p LoadState --value)" == not-found ]] || die '已有同名 sky-ludo 服务，拒绝覆盖。'
fi

# Parse only the application's supported endpoint fields, never execute the env file.
read_env() {
  python3 - "$env_file" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
fields = {'HOST': '0.0.0.0', 'PORT': '8080'}
if path.exists():
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key in fields:
            fields[key] = value.strip().strip('"\'')
host, port = fields['HOST'], fields['PORT']
if host not in ('0.0.0.0', '127.0.0.1', '::', '::1'):
    sys.exit('不支持的 HOST；请使用 0.0.0.0、127.0.0.1、:: 或 ::1。')
if not re.fullmatch(r'[0-9]{1,5}', port) or not 1024 <= int(port) <= 65535:
    sys.exit('PORT 必须在 1024–65535 之间。')
print(host, int(port))
PY
}
endpoint="$(read_env)"
read -r app_host app_port <<< "$endpoint"
health_host=127.0.0.1
[[ "$app_host" != ::1 && "$app_host" != :: ]] || health_host='[::1]'
health_url="http://${health_host}:${app_port}/health"
was_active=0
was_enabled=0
systemctl is-active --quiet sky-ludo.service && was_active=1
systemctl is-enabled --quiet sky-ludo.service && was_enabled=1
check_rooms() {
  local payload rooms
  payload="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 "$health_url")" || die '运行中服务的健康检查失败；拒绝停止，先检查日志。'
  rooms="$(python3 -c 'import json,sys; j=json.load(sys.stdin); r=j.get("rooms"); assert j.get("ok") is True and isinstance(r,int) and not isinstance(r,bool) and r>=0; print(r)' <<< "$payload")" || die '健康检查格式异常，拒绝更新。'
  (( rooms == 0 || confirm == 1 )) || die "仍有 $rooms 个房间。待房间清空后更新，或明确使用 --update --confirm-end-rooms。"
  printf '当前房间: %s。更新会停止服务，内存房间无法恢复。\n' "$rooms"
}
if (( was_active )); then
  (( update == 1 )) || die '已有正在运行的同名服务。'
  check_rooms
elif ss -H -ltn "sport = :$app_port" | awk 'END {exit NR == 0 ? 1 : 0}'; then
  die "端口 $app_port 已被占用；不停止其他服务。"
fi

if id sky-ludo >/dev/null 2>&1; then
  [[ "$(id -u sky-ludo)" != 0 ]] || die 'sky-ludo 用户不能是 root。'
  getent group sky-ludo >/dev/null || die '已有 sky-ludo 用户但缺少同名组。'
else
  useradd --system --user-group --home-dir "$app_root" --shell /usr/sbin/nologin sky-ludo
fi
install -d -o root -g sky-ludo -m 0750 "$app_root"
install -d -o root -g root -m 0700 "$app_root/backups"
transaction="$(mktemp -d "$app_root/backups/install-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")"
stage="$transaction/staging"
install -d -o root -g root -m 0700 "$stage"
printf '准备安装；备份/回退目录: %s\n' "$transaction"
runtime_changed=0
if [[ ! -x "$app_root/runtime/bin/node" ]] || [[ "$("$app_root/runtime/bin/node" --version)" != "$node_version" ]]; then
  node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 15 --max-time 600 --retry 2 "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$stage/$node_archive"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 15 --max-time 60 --retry 2 "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  checksum_line="$(awk -v file="$node_archive" '$2 == file {print}' "$stage/SHASUMS256.txt")"
  [[ "$checksum_line" =~ ^[0-9a-f]{64}[[:space:]] ]] || die '没有找到有效的 Node SHA256 值。'
  (cd "$stage"; printf '%s\n' "$checksum_line" | sha256sum --check --strict -)
  install -d -o root -g root -m 0755 "$stage/runtime"
  tar -xJf "$stage/$node_archive" -C "$stage/runtime" --strip-components=1 --no-same-owner
  [[ "$("$stage/runtime/bin/node" --version)" == "$node_version" ]] || die 'Node 运行时版本不匹配。'
  runtime_changed=1
fi
node_bin="$app_root/runtime/bin/node"
(( runtime_changed == 0 )) || node_bin="$stage/runtime/bin/node"
install -d -o root -g sky-ludo -m 0750 "$stage/current"
# Keep target-side unrelated files on updates. Nothing outside the application
# allowlist is copied from the source package.
if (( update )); then cp -a "$app_root/current/." "$stage/current/"; fi
for file in server.mjs engine.mjs board.mjs package.json; do
  install -o root -g sky-ludo -m 0640 "$app_source/$file" "$stage/current/$file"
done
install -d -o root -g sky-ludo -m 0750 "$stage/current/public"
cp -a "$app_source/public/." "$stage/current/public/"
chown -R root:sky-ludo "$stage/current/public"
find "$stage/current/public" -type d -exec chmod 0750 {} +
find "$stage/current/public" -type f -exec chmod 0640 {} +
for file in server.mjs engine.mjs board.mjs; do "$node_bin" --check "$stage/current/$file"; done
[[ ! -f "$unit" ]] || cp -a "$unit" "$transaction/old-service"
[[ ! -f "$env_file" ]] || cp -a "$env_file" "$transaction/old-env"
[[ ! -f "$marker" ]] || cp -a "$marker" "$transaction/old-marker"

activation_started=0
app_swapped=0
runtime_swapped=0
rollback() {
  local code=$?
  trap - ERR INT TERM
  set +e
  printf '安装失败（退出码 %s）；回退备份: %s\n' "$code" "$transaction" >&2
  if (( activation_started )); then
    systemctl stop sky-ludo.service
    if (( was_enabled == 0 )); then systemctl disable sky-ludo.service; fi
    if (( app_swapped )); then mv "$app_root/current" "$transaction/failed-current"; fi
    [[ ! -d "$transaction/old-current" ]] || mv "$transaction/old-current" "$app_root/current"
    if (( runtime_swapped )); then mv "$app_root/runtime" "$transaction/failed-runtime"; fi
    [[ ! -d "$transaction/old-runtime" ]] || mv "$transaction/old-runtime" "$app_root/runtime"
    if [[ -f "$transaction/old-service" ]]; then cp -a "$transaction/old-service" "$unit"; else rm -f "$unit"; fi
    if [[ -f "$transaction/old-env" ]]; then cp -a "$transaction/old-env" "$env_file"; else rm -f "$env_file"; fi
    if [[ -f "$transaction/old-marker" ]]; then cp -a "$transaction/old-marker" "$marker"; else rm -f "$marker"; fi
    systemctl daemon-reload
    if (( was_enabled )); then systemctl enable sky-ludo.service; fi
    if (( was_active )); then
      systemctl start sky-ludo.service
      if curl --noproxy '*' --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 1 --connect-timeout 2 --max-time 3 "$health_url"; then
        printf '\n旧服务已恢复；先前内存房间不能恢复。\n' >&2
      else
        printf '\n旧服务恢复检查未通过；请检查 systemctl status sky-ludo 和 journalctl -u sky-ludo。\n' >&2
      fi
    fi
  fi
  exit "$code"
}
trap rollback ERR
trap 'false' INT TERM
# Recheck at the last possible point before stopping. A live app has no maintenance
# mode: a simultaneous last-millisecond join cannot be excluded entirely.
if (( was_active )); then check_rooms; fi
activation_started=1
if (( was_active )); then systemctl stop sky-ludo.service; fi
if ss -H -ltn "sport = :$app_port" | awk 'END {exit NR == 0 ? 1 : 0}'; then
  printf '停止服务后端口仍被占用，开始回退。\n' >&2
  false
fi
[[ ! -d "$app_root/current" ]] || mv "$app_root/current" "$transaction/old-current"
mv "$stage/current" "$app_root/current"
app_swapped=1
if (( runtime_changed )); then
  [[ ! -d "$app_root/runtime" ]] || mv "$app_root/runtime" "$transaction/old-runtime"
  mv "$stage/runtime" "$app_root/runtime"
  runtime_swapped=1
fi
install -d -o root -g sky-ludo -m 0750 /etc/sky-ludo
if [[ ! -f "$env_file" ]]; then
  printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=8080\nTRUST_LOOPBACK_PROXY=0\n' > "$env_file"
  chown root:sky-ludo "$env_file"
  chmod 0640 "$env_file"
fi
install -o root -g root -m 0644 "$app_source/deploy/portable/sky-ludo.service" "$unit"
printf 'sky-ludo-portable-v1\n' > "$marker"
chown root:root "$marker"
chmod 0640 "$marker"
systemctl daemon-reload
systemctl enable sky-ludo.service
# Exactly one start. A failed health check invokes rollback, never a blind restart.
systemctl start sky-ludo.service
ready=0
for attempt in {1..15}; do
  if systemctl is-active --quiet sky-ludo.service && curl --noproxy '*' --fail --silent --connect-timeout 2 --max-time 3 "$health_url" | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") is True'; then ready=1; break; fi
  sleep 1
done
(( ready == 1 )) || { printf '新服务健康检查失败。\n' >&2; false; }
trap - ERR INT TERM
printf '\n安装成功：Node %s；服务 sky-ludo；端口 %s。\n' "$node_version" "$app_port"
if [[ "$app_host" == 0.0.0.0 || "$app_host" == :: ]]; then
  printf '首次访问：http://服务器公网IP:%s/（请自行检查云安全组和主机防火墙）。\n' "$app_port"
else
  printf '服务仅监听本机，请通过已配置的 HTTPS 代理访问。\n'
fi
printf '环境配置：%s\n备份目录：%s\n' "$env_file" "$transaction"
printf '查看状态：sudo systemctl status sky-ludo --no-pager\n查看日志：sudo journalctl -u sky-ludo -n 100 --no-pager\n'
printf '重启：sudo systemctl restart sky-ludo（重启会清空房间，操作前先检查 /health）。\n'
