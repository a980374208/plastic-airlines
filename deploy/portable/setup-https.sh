#!/usr/bin/env bash
# Ubuntu 22.04/24.04; run after deploy/portable/install.sh.
set -Eeuo pipefail
umask 022

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/portable/setup-https.sh --domain DOMAIN --email EMAIL [--confirm-end-rooms]

Use your real public domain and email address. Before running:
  - Point the domain's DNS A/AAAA records at this server.
  - Allow inbound TCP 80 and 443 in the server/cloud firewall.
  - Install the game with deploy/portable/install.sh first.
This script refuses ports occupied by software other than Nginx, existing
same-name sites, and nonempty game rooms unless --confirm-end-rooms is given.
Successful HTTPS setup restarts sky-ludo, clearing all in-memory rooms.
USAGE
}

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
domain=''
email=''
confirm_end_rooms=0
while (($#)); do
  case "$1" in
    --domain) (($# >= 2)) || fail '--domain 缺少值'; domain="$2"; shift 2 ;;
    --email) (($# >= 2)) || fail '--email 缺少值'; email="$2"; shift 2 ;;
    --confirm-end-rooms) confirm_end_rooms=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done
[[ $EUID -eq 0 ]] || fail '请使用 sudo bash 执行此脚本。'
[[ -r /etc/os-release ]] || fail '仅支持 Ubuntu 22.04/24.04。'
# This file is provided by the OS, not by the deployment archive.
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} =~ ^(22\.04|24\.04)$ ]] || fail '仅支持 Ubuntu 22.04/24.04。'
domain="${domain,,}"
[[ ${#domain} -le 253 && $domain =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]+)$ ]] || fail '请填写不含协议、路径或端口的真实域名。'
IFS='.' read -r -a domain_labels <<<"$domain"
for label in "${domain_labels[@]}"; do
  ((${#label} <= 63)) || fail '域名标签不能超过 63 个字符。'
done
case "$domain" in
  example.com|*.example.com|example.net|*.example.net|example.org|*.example.org|*.invalid|*.test|*.example|*.localhost|*.local|localhost|yourdomain.*|your-domain.*)
    fail '示例/本地域名不能申请公网证书；请换成你自己的真实域名。' ;;
esac
[[ $email =~ ^[A-Za-z0-9.!%_+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || fail '请填写真实的证书通知邮箱。'
case "${email,,}" in *@example.com|*@example.net|*@example.org) fail '请将示例邮箱替换为真实邮箱。' ;; esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file=/etc/sky-ludo/sky-ludo.env
node_bin=/opt/sky-ludo/runtime/bin/node
[[ -f /opt/sky-ludo/portable-install && -f $env_file && -x $node_bin ]] || fail '请先使用同目录 install.sh 安装游戏。'
[[ -f $script_dir/nginx-http.conf.template && -f $script_dir/nginx-https.conf.template ]] || fail '缺少同目录 Nginx 模板文件。'
for tool in curl ss flock sha256sum awk sed; do
  command -v "$tool" >/dev/null || fail "缺少 $tool，请先安装游戏安装器要求的系统依赖。"
done
exec 9>/run/lock/sky-ludo-deploy.lock
flock -n 9 || fail '另一个游戏安装/更新/HTTPS 操作正在执行。'
systemctl is-active --quiet sky-ludo || fail 'sky-ludo 服务未启动，请先修复游戏服务。'
app_host="$(awk -F= '/^HOST=/ { value=substr($0,6) } END { print value }' "$env_file")"
[[ $app_host == 0.0.0.0 || $app_host == 127.0.0.1 ]] || fail 'HTTPS 助手只支持 HOST=0.0.0.0 或 127.0.0.1。请等待房间清空后调整 sky-ludo.env 的 HOST 并重启游戏，再执行本脚本。'
app_port="$(awk -F= '/^PORT=[0-9]+$/ { value=$2 } END { print value }' "$env_file")"
[[ $app_port =~ ^[0-9]+$ && ${#app_port} -le 5 ]] || fail 'sky-ludo.env 中 PORT 必须为十进制整数。'
app_port=$((10#$app_port))
((app_port >= 1024 && app_port <= 65535)) || fail '后端 PORT 必须为 1024 到 65535。'

check_rooms() {
  local rooms
  rooms="$(curl --noproxy '*' --fail --silent --show-error --max-time 5 "http://127.0.0.1:$app_port/health" |
    "$node_bin" --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; const h=JSON.parse(s); if(h.ok!==true || !Number.isSafeInteger(h.rooms) || h.rooms<0) process.exit(1); console.log(h.rooms);')" || fail '游戏健康检查失败，停止 HTTPS 切换。'
  if ((rooms > 0 && confirm_end_rooms != 1)); then
    fail "当前有 $rooms 个房间。请等待房间清空；若明确允许中断，添加 --confirm-end-rooms。"
  fi
}

wait_for_health() {
  local attempt health_json
  for attempt in {1..10}; do
    if systemctl is-active --quiet sky-ludo &&
      health_json="$(curl --noproxy '*' --fail --silent --show-error --max-time 2 "http://127.0.0.1:$app_port/health")"; then
      if printf '%s' "$health_json" | "$node_bin" --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; try { if(JSON.parse(s).ok!==true) process.exit(1); } catch { process.exit(1); }'; then
        return 0
      fi
    fi
    ((attempt == 10)) || sleep 1
  done
  return 1
}

state_file=/etc/sky-ludo/https-domain
if [[ -e $state_file || -L $state_file ]]; then
  [[ $(cat "$state_file") == "$domain" ]] || fail '此实例已配置另一域名；请人工审查后迁移。'
  printf '此实例已为 %s 配置 HTTPS；不重复覆盖配置。\n' "$domain"
  nginx -t
  systemctl is-active --quiet nginx
  systemctl is-enabled --quiet sky-ludo-acme-renew.timer
  systemctl is-active --quiet sky-ludo-acme-renew.timer
  curl --noproxy '*' --fail --silent --show-error --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health"
  printf '\n证书由 sky-ludo-acme-renew.timer 自动续期。\n'
  exit 0
fi
check_rooms

# Do not stop or migrate 3x-ui/Xray/Apache/Caddy or any other port owner.
while IFS= read -r listener; do
  [[ -z $listener ]] && continue
  process_names="$(printf '%s\n' "$listener" | grep -oE '"[^"]+"' | sort -u || true)"
  [[ $process_names == '"nginx"' ]] || fail '80 或 443 已被非 Nginx 进程占用。请自行安排端口/反代，本脚本不会修改这些服务。'
done < <(ss -H -ltnp '( sport = :80 or sport = :443 )')

site_file="/etc/nginx/sites-available/sky-ludo-$domain.conf"
site_link="/etc/nginx/sites-enabled/sky-ludo-$domain.conf"
for existing in "$site_file" "$site_link" /etc/systemd/system/sky-ludo-acme-renew.service /etc/systemd/system/sky-ludo-acme-renew.timer; do
  [[ ! -e $existing && ! -L $existing ]] || fail "已有配置 $existing，停止以避免覆盖；请人工审查。"
done

# Only install Nginx when absent; do not upgrade an existing web server.
if ! command -v nginx >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx ca-certificates openssl
fi
command -v openssl >/dev/null || fail '缺少 openssl；请执行 apt-get install openssl 后重试。'
nginx -t
[[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]] || fail '本脚本需要 Ubuntu Nginx 的 sites-available/sites-enabled 目录。'
nginx_dump="$(nginx -T 2>/dev/null)"
if printf '%s\n' "$nginx_dump" | awk -v domain="$domain" '
  /^[[:space:]]*server_name[[:space:]]/ {
    for (i=2; i<=NF; i++) { item=$i; sub(/;.*/, "", item); if (tolower(item)==domain) found=1 }
  } END { exit !found }'; then
  fail '现有 Nginx 站点已声明此域名；请先人工审查，脚本不会替换它。'
fi
unset nginx_dump
[[ $(systemctl show nginx -p User --value) == '' || $(systemctl show nginx -p User --value) == root ]] || fail 'Nginx 主进程必须以 root 加载证书；请人工适配自定义服务。'

acme_home=/opt/sky-ludo/acme-runtime
acme_config=/etc/sky-ludo/acme
acme_certs=/etc/sky-ludo/acme/certs
webroot=/var/lib/sky-ludo/acme-webroot
cert_dir="/etc/sky-ludo/tls/$domain"
if [[ -e $acme_home || -L $acme_home || -e $acme_config || -L $acme_config ]]; then
  [[ ! -L $acme_home && ! -L $acme_config && -f $acme_home/sky-ludo-owned && -f $acme_config/sky-ludo-owned && $(cat "$acme_home/sky-ludo-owned") == portable-https-v1 && $(cat "$acme_config/sky-ludo-owned") == portable-https-v1 ]] || fail 'ACME 专用目录已存在但不是本脚本创建，停止以避免覆盖。'
fi
if [[ -e $cert_dir || -L $cert_dir ]]; then
  [[ -d $cert_dir && ! -L $cert_dir && -f $cert_dir/sky-ludo-owned && $(cat "$cert_dir/sky-ludo-owned") == "portable-https-v1:$domain" ]] || fail '同域名证书目标目录已存在且不是本脚本创建；请先人工审查，脚本不会覆盖它。'
fi

work_dir="$(mktemp -d /tmp/sky-ludo-https.XXXXXX)"
http_installed=0
env_changed=0
timer_created=0
success=0
cleanup() {
  local result=$?
  local rollback_ok=1
  # Keep attempting every rollback step even if one fails.
  set +e
  if ((success == 0)); then
    printf 'HTTPS 未完成；开始恢复原游戏环境及 HTTP 代理。\n' >&2
    if ((env_changed)); then
      if install -o root -g sky-ludo -m 0640 "$work_dir/sky-ludo.env.before" "$env_file"; then
        if systemctl restart sky-ludo; then
          wait_for_health || rollback_ok=0
        else
          rollback_ok=0
        fi
      else
        rollback_ok=0
      fi
    fi
    if ((timer_created)); then
      systemctl disable --now sky-ludo-acme-renew.timer >/dev/null 2>&1 || true
      rm -f -- /etc/systemd/system/sky-ludo-acme-renew.service /etc/systemd/system/sky-ludo-acme-renew.timer
      systemctl daemon-reload || true
    fi
    if ((http_installed)); then
      install -o root -g root -m 0644 "$work_dir/http.conf" "$site_file" || rollback_ok=0
      if nginx -t; then systemctl reload nginx || rollback_ok=0; else rollback_ok=0; fi
      printf '本次建立的 HTTP 站点保留在 %s。\n' "$site_file" >&2
      printf '重试前请确认这两个文件确为本次新建，然后仅移除它们：\n  sudo rm -- %s %s\n  sudo nginx -t && sudo systemctl reload nginx\n' "$site_link" "$site_file" >&2
      printf '保留 ACME 目录及本脚本带标记的证书目录，重新执行原命令即可复用。\n' >&2
    else
      rm -f -- "$site_link" "$site_file"
      if nginx -t && systemctl is-active --quiet nginx; then systemctl reload nginx || true; fi
    fi
    # Certificate account/source material is preserved, never recursively removed.
    rm -f -- "$state_file"
    printf 'ACME 资料保留在 %s；可查看错误后人工重试。\n' "$acme_config" >&2
    if ((rollback_ok == 0)); then
      printf '部分自动恢复步骤失败，请立即检查 systemctl status sky-ludo nginx 与 nginx -t。\n' >&2
    fi
  fi
  rm -f -- "$work_dir/http.conf" "$work_dir/https.conf" "$work_dir/sky-ludo.env.before" "$work_dir/sky-ludo.env.after" "$work_dir/acme.sh"
  rmdir -- "$work_dir" 2>/dev/null || true
  return "$result"
}
trap cleanup EXIT

render() {
  sed -e "s|@@DOMAIN@@|$domain|g" -e "s|@@PORT@@|$app_port|g" -e "s|@@WEBROOT@@|$webroot|g" -e "s|@@CERT_DIR@@|$cert_dir|g" "$1" > "$2"
  ! grep -q '@@[A-Z_]*@@' "$2" || fail 'Nginx 模板中存在未替换占位符。'
}
render "$script_dir/nginx-http.conf.template" "$work_dir/http.conf"
render "$script_dir/nginx-https.conf.template" "$work_dir/https.conf"
cp -- "$env_file" "$work_dir/sky-ludo.env.before"
chmod 0600 "$work_dir/sky-ludo.env.before"
install -d -o root -g root -m 0755 /var/lib/sky-ludo "$webroot" "$webroot/.well-known" "$webroot/.well-known/acme-challenge"
install -o root -g root -m 0644 "$work_dir/http.conf" "$site_file"
ln -s -- "$site_file" "$site_link"
nginx -t
systemctl enable --now nginx
systemctl reload nginx
http_installed=1
if command -v ufw >/dev/null && ufw status | head -n 1 | grep -q '^Status: active'; then
  ufw allow 80/tcp comment 'Sky Ludo HTTPS verification'
  ufw allow 443/tcp comment 'Sky Ludo HTTPS'
fi
curl --noproxy '*' --fail --silent --show-error --max-time 10 --resolve "$domain:80:127.0.0.1" "http://$domain/health" >/dev/null

# Pin the upstream HTTP-01 client; no profile, global cron, or other ACME account is changed.
acme_version=3.1.2
acme_sha256=c46b41a61c96f67d424e4b4e476907c964b81d53cf94358a9c1d363a4f99c3a4
curl --fail --silent --show-error --location --max-time 60 "https://raw.githubusercontent.com/acmesh-official/acme.sh/$acme_version/acme.sh" -o "$work_dir/acme.sh"
printf '%s  %s\n' "$acme_sha256" "$work_dir/acme.sh" | sha256sum --check --strict -
install -d -o root -g root -m 0700 "$acme_home" "$acme_config" "$acme_certs"
printf 'portable-https-v1\n' > "$acme_home/sky-ludo-owned"
printf 'portable-https-v1\n' > "$acme_config/sky-ludo-owned"
install -o root -g root -m 0700 "$work_dir/acme.sh" "$acme_home/acme.sh"
acme=("$acme_home/acme.sh" --home "$acme_home" --config-home "$acme_config" --cert-home "$acme_certs" --server letsencrypt)
"${acme[@]}" --register-account --accountemail "$email"
issue_status=0
"${acme[@]}" --issue --domain "$domain" --webroot "$webroot" --keylength ec-256 || issue_status=$?
# acme.sh returns 2 when an already-valid certificate needs no renewal.
((issue_status == 0 || issue_status == 2)) || fail '证书申请失败；请检查 DNS、80 端口与 ACME 输出。'
install -d -o root -g root -m 0700 /etc/sky-ludo/tls "$cert_dir"
printf 'portable-https-v1:%s\n' "$domain" > "$cert_dir/sky-ludo-owned"
chmod 0600 "$cert_dir/sky-ludo-owned"
"${acme[@]}" --install-cert --domain "$domain" --ecc --key-file "$cert_dir/privkey.pem" --fullchain-file "$cert_dir/fullchain.pem" --reloadcmd 'nginx -t && systemctl reload nginx'
chmod 0600 "$cert_dir/privkey.pem"
chmod 0644 "$cert_dir/fullchain.pem"
certificate_match="$(openssl x509 -in "$cert_dir/fullchain.pem" -noout -checkhost "$domain")"
[[ $certificate_match == "Hostname $domain does match certificate" ]] || fail '证书不覆盖指定域名，停止切换。'

# Recheck immediately before the only game restart, since issuance may take time.
check_rooms
awk '!/^HOST=/ && !/^TRUST_LOOPBACK_PROXY=/ { print } END { print "HOST=127.0.0.1"; print "TRUST_LOOPBACK_PROXY=1" }' "$env_file" > "$work_dir/sky-ludo.env.after"
env_changed=1
install -o root -g sky-ludo -m 0640 "$work_dir/sky-ludo.env.after" "$env_file"
systemctl restart sky-ludo
wait_for_health || fail 'HTTPS 切换后游戏未通过健康检查。'
install -o root -g root -m 0644 "$work_dir/https.conf" "$site_file"
nginx -t
systemctl reload nginx
curl --noproxy '*' --fail --silent --show-error --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null

timer_created=1
cat > /etc/systemd/system/sky-ludo-acme-renew.service <<EOF
[Unit]
Description=Renew only the Sky Ludo HTTPS certificate
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$acme_home/acme.sh --cron --home $acme_home --config-home $acme_config --cert-home $acme_certs --server letsencrypt
UMask=0022
EOF
cat > /etc/systemd/system/sky-ludo-acme-renew.timer <<'EOF'
[Unit]
Description=Daily Sky Ludo certificate renewal check

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sky-ludo-acme-renew.timer
printf '%s\n' "$domain" > "$state_file"
chmod 0644 "$state_file"
success=1
printf '\nHTTPS 已配置：https://%s\n' "$domain"
printf '后端仅监听 127.0.0.1:%s，证书续期由 sky-ludo-acme-renew.timer 管理。\n' "$app_port"
printf '请再从外网打开网站，验证创建/加入房间和多人联机。\n'
