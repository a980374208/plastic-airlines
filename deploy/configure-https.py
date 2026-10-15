#!/usr/bin/env python3
"""Stage and switch this host's game/3x-ui reverse proxy without exposing secrets."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request

STATE = Path('/opt/sky-ludo/https-20261008')
APP = Path('/opt/sky-ludo/current/server.mjs')
DB = Path('/etc/x-ui/x-ui.db')
SITE = Path('/etc/nginx/sites-available/sky-ludo')
LINK = Path('/etc/nginx/sites-enabled/sky-ludo')
DROPIN = Path('/etc/systemd/system/sky-ludo.service.d/60-https.conf')
TLS = Path('/etc/nginx/sky-ludo-tls')
OLD_SHA = '4263ebe043277cb7c86a774fb396f621854b7761cfefa32603467b75d28f6142'
NEW_SHA = '226e97bf42eb1291a4da17ab2568e2c7d4dc32af95baa534d3b746aaabc88f85'
SETTINGS = ('subPort', 'subListen', 'subURI')
INPUTS = SETTINGS + ('webPort', 'webListen', 'webDomain', 'webBasePath', 'webCertFile',
                    'webKeyFile', 'subDomain', 'subPath', 'subEnable', 'subCertFile',
                    'subKeyFile', 'subJsonEnable', 'subJsonPath', 'subJsonURI')
ACME_HOME = Path('/etc/sky-ludo/acme')


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # nginx diagnostics can include the panel/subscription path.
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); inspect on host')
    return result.stdout


def write(filename, text, mode=0o600):
    filename.parent.mkdir(parents=True, exist_ok=True)
    tmp = filename.with_name(filename.name + '.next')
    tmp.write_text(text)
    tmp.chmod(mode)
    tmp.replace(filename)


def settings():
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as conn:
        return dict(conn.execute('SELECT key, value FROM settings'))


def health():
    with urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3) as response:
        data = json.load(response)
    if data.get('ok') is not True or not isinstance(data.get('rooms'), int):
        raise RuntimeError('Invalid game health response')
    return data


def sha(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def proxy(port, tls=False, panel=False):
    lines = [f'proxy_pass {"https" if tls else "http"}://127.0.0.1:{port};',
             'proxy_http_version 1.1;', 'proxy_set_header Host $http_host;',
             'proxy_set_header X-Real-IP $remote_addr;',
             'proxy_set_header X-Forwarded-For $remote_addr;',
             'proxy_set_header X-Forwarded-Proto $scheme;',
             'proxy_buffering off;', 'proxy_cache off;', 'proxy_read_timeout 3600s;']
    if panel:
        lines += ['proxy_set_header Upgrade $http_upgrade;',
                  'proxy_set_header Connection $sky_ludo_upgrade;']
    else:
        lines += ['proxy_set_header Connection "";']
    if tls:
        lines += ['proxy_ssl_server_name on;', 'proxy_ssl_name jbba.top;',
                  'proxy_ssl_verify on;', 'proxy_ssl_verify_depth 3;',
                  'proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;']
    return '\n'.join('        ' + line for line in lines)


def config(current):
    subpath = current.get('subPath', '')
    webpath = current.get('webBasePath', '')
    if not re.fullmatch(r'/[A-Za-z0-9_/-]+/', subpath) or not webpath.startswith('/'):
        raise RuntimeError('Unexpected route path; manual review needed')
    if webpath.startswith(subpath) or subpath.startswith(webpath):
        raise RuntimeError('Panel/subscription routes overlap')
    if current.get('subJsonEnable') == 'true':
        raise RuntimeError('Enabled JSON subscription needs additional routing review')
    if current.get('subDomain') or current.get('webDomain'):
        raise RuntimeError('Backend domain constraints need additional review')
    port = int(current['webPort'])
    shared = f'''    ssl_certificate {TLS}/fullchain.pem;
    ssl_certificate_key {TLS}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SkyLudoTLS:10m;
    access_log off;
    error_log /dev/null crit;
'''
    subscribe = f'''    location ^~ {subpath} {{
{proxy(8445, tls=True)}
    }}
'''
    return f'''# Generated on the host; private routes must not be copied into public logs.
map $http_upgrade $sky_ludo_upgrade {{ default upgrade; '' close; }}
server {{
    listen 80;
    listen [::]:80;
    server_name jbba.top turn.jbba.top;
    access_log off;
    error_log /dev/null crit;
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/sky-ludo-acme; }}
    location / {{ return 308 https://$host$request_uri; }}
}}
server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name jbba.top;
{shared}{subscribe}    location / {{
        client_max_body_size 16k;
{proxy(8080)}
    }}
}}
server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name turn.jbba.top;
    client_max_body_size 20m;
{shared}{subscribe}    location / {{
{proxy(port, tls=True, panel=True)}
    }}
}}
'''


def prepare():
    if STATE.exists():
        raise RuntimeError('Migration state already exists; reuse/review it')
    if sha(APP) != OLD_SHA or sha(STATE.with_name('https-server.mjs')) != NEW_SHA:
        raise RuntimeError('Game source fingerprint changed')
    current = settings()
    if current.get('subPort') != '443' or current.get('subEnable') != 'true':
        raise RuntimeError('Subscription settings changed')
    if SITE.exists() or LINK.exists() or DROPIN.exists():
        raise RuntimeError('Existing migration configuration needs review')
    STATE.mkdir(mode=0o700)
    shutil.copy2(APP, STATE / 'server.previous.mjs')
    write(STATE / 'settings.previous.json', json.dumps({k: current.get(k) for k in SETTINGS}))
    write(STATE / 'inputs.previous.json', json.dumps({k: current.get(k) for k in INPUTS}))
    write(STATE / 'unit.previous.sha256', hashlib.sha256(run('systemctl', 'cat', 'sky-ludo').encode()).hexdigest())
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as source:
        with sqlite3.connect(STATE / 'x-ui.backup.db') as target:
            source.backup(target)
    (STATE / 'x-ui.backup.db').chmod(0o600)
    write(STATE / 'nginx.final.conf', config(current))
    write(SITE, '''server {
    listen 80;
    listen [::]:80;
    server_name jbba.top turn.jbba.top;
    access_log off;
    error_log /dev/null crit;
    location ^~ /.well-known/acme-challenge/ { root /var/www/sky-ludo-acme; }
    location / { return 503; }
}
''')
    Path('/var/www/sky-ludo-acme').mkdir(parents=True, exist_ok=True)
    Path('/var/www/sky-ludo-acme').chmod(0o755)
    TLS.mkdir(mode=0o700, parents=True, exist_ok=True)
    LINK.symlink_to(SITE)
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    print('PREPARED: certificate challenge enabled; game and 3x-ui unchanged')


def issue():
    if not STATE.exists():
        raise RuntimeError('Prepare the webroot first')
    for host in ('jbba.top', 'turn.jbba.top'):
        resolved = False
        for endpoint in ('https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'):
            request = urllib.request.Request(endpoint + '?name=' + host + '&type=A',
                                             headers={'Accept': 'application/dns-json'})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    answer = json.load(response)
                resolved = answer.get('Status') == 0 and any(
                    row.get('data') == '38.47.112.116' for row in answer.get('Answer', []))
                if resolved:
                    break
            except (OSError, ValueError):
                continue
        if not resolved:
            raise RuntimeError(host + ' DNS does not resolve to this host yet')
    ACME_HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    ACME_HOME.chmod(0o700)

    def acme(*args):
        result = subprocess.run(['/root/.acme.sh/acme.sh', '--config-home', str(ACME_HOME), *args],
                                capture_output=True, text=True, umask=0o022)
        write(STATE / 'acme-operation.log', result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('Certificate operation failed; private diagnostics saved on host')

    acme('--issue', '--server', 'letsencrypt', '-d', 'jbba.top', '-d', 'turn.jbba.top',
         '--webroot', '/var/www/sky-ludo-acme', '--keylength', 'ec-256')
    acme('--install-cert', '-d', 'jbba.top', '--ecc', '--fullchain-file', str(TLS / 'fullchain.pem'),
         '--key-file', str(TLS / 'privkey.pem'), '--reloadcmd', '/usr/sbin/nginx -t && /bin/systemctl reload nginx')
    (TLS / 'privkey.pem').chmod(0o600)
    (TLS / 'fullchain.pem').chmod(0o644)
    write(Path('/etc/systemd/system/sky-ludo-acme.service'), '''[Unit]
Description=Renew Sky Ludo HTTPS certificates
After=network-online.target nginx.service
Wants=network-online.target
[Service]
Type=oneshot
UMask=0022
ExecStart=/root/.acme.sh/acme.sh --cron --config-home /etc/sky-ludo/acme
''', 0o644)
    write(Path('/etc/systemd/system/sky-ludo-acme.timer'), '''[Unit]
Description=Daily Sky Ludo certificate renewal
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
''', 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'sky-ludo-acme.timer')
    print('CERTIFICATE_READY: both domains covered; isolated daily renewal enabled')


def update_settings(values):
    with sqlite3.connect(DB) as conn:
        for key, value in values.items():
            if value is None:
                conn.execute('DELETE FROM settings WHERE key = ?', (key,))
            else:
                # x-ui's key column has no UNIQUE constraint. REPLACE would append.
                result = conn.execute('UPDATE settings SET value = ? WHERE key = ?', (value, key))
                if result.rowcount == 0:
                    conn.execute('INSERT INTO settings(key,value) VALUES (?,?)', (key, value))


def rollback():
    # Restore changed keys only; do not overwrite unrelated or live inbound data.
    run('systemctl', 'stop', 'nginx')
    update_settings(json.loads((STATE / 'settings.previous.json').read_text()))
    shutil.copy2(STATE / 'server.previous.mjs', APP)
    DROPIN.unlink(missing_ok=True)
    LINK.unlink(missing_ok=True)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'x-ui')
    run('systemctl', 'restart', 'sky-ludo')
    run('systemctl', 'start', 'nginx')
    (STATE / 'activated').unlink(missing_ok=True)
    print('ROLLED_BACK: original subscription port and game service restored')


def activate_proxy():
    """Switch the public domains while leaving every existing game in memory."""
    if (STATE / 'proxy-activated').exists() or (STATE / 'activated').exists():
        raise RuntimeError('Public proxy is already active')
    current = settings()
    previous = json.loads((STATE / 'inputs.previous.json').read_text())
    if any(current.get(k) != v for k, v in previous.items()) or sha(APP) != OLD_SHA:
        raise RuntimeError('Inputs changed since preparation')
    game_pid = run('systemctl', 'show', 'sky-ludo', '--property=MainPID', '--value').strip()
    before = SITE.read_text()
    write(STATE / 'nginx.before-proxy.conf', before)
    try:
        write(SITE, (STATE / 'nginx.final.conf').read_text())
        run('nginx', '-t')
    finally:
        write(SITE, before)
    if ':8445 ' in run('ss', '-ltn'):
        raise RuntimeError('Target subscription port is occupied')
    try:
        update_settings({'subPort': '8445', 'subListen': '127.0.0.1',
                         'subURI': 'https://turn.jbba.top' + current['subPath']})
        run('systemctl', 'restart', 'x-ui')
        for attempt in range(15):
            try:
                with socket.create_connection(('127.0.0.1', 8445), timeout=1):
                    pass
                break
            except OSError:
                if attempt == 14:
                    raise RuntimeError('Subscription backend did not become ready')
                time.sleep(1)
        write(SITE, (STATE / 'nginx.final.conf').read_text())
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        run('systemctl', 'is-active', 'sky-ludo', 'x-ui', 'nginx')
        if run('systemctl', 'show', 'sky-ludo', '--property=MainPID', '--value').strip() != game_pid:
            raise RuntimeError('Game process changed unexpectedly during proxy switch')
        health()
        write(STATE / 'proxy-activated', str(time.time()))
        print('PROXY_ACTIVE: HTTPS domains switched; game process and rooms preserved')
    except Exception:
        # This rollback must not call rollback(), which restarts the game.
        run('systemctl', 'stop', 'nginx')
        update_settings(json.loads((STATE / 'settings.previous.json').read_text()))
        write(SITE, before)
        run('systemctl', 'restart', 'x-ui')
        run('systemctl', 'start', 'nginx')
        print('PROXY_ROLLED_BACK: game process was not restarted')
        raise


def activate():
    if (STATE / 'activated').exists():
        raise RuntimeError('Migration is already active')
    confirm_end_rooms = sys.argv[2:] == ['--confirm-end-rooms']
    if health()['rooms'] and not confirm_end_rooms:
        raise RuntimeError('Game rooms remain; activation deferred to preserve live games')
    current = settings()
    previous = json.loads((STATE / 'inputs.previous.json').read_text())
    unit_sha = hashlib.sha256(run('systemctl', 'cat', 'sky-ludo').encode()).hexdigest()
    if (any(current.get(k) != v for k, v in previous.items()) or sha(APP) != OLD_SHA
            or sha(STATE.with_name('https-server.mjs')) != NEW_SHA
            or unit_sha != (STATE / 'unit.previous.sha256').read_text()):
        raise RuntimeError('Inputs changed since preparation')
    if not TLS.joinpath('fullchain.pem').is_file() or not TLS.joinpath('privkey.pem').is_file():
        raise RuntimeError('Both-domain certificate must be installed first')
    for hostname in ('jbba.top', 'turn.jbba.top'):
        checked = run('openssl', 'x509', '-in', str(TLS / 'fullchain.pem'), '-noout', '-checkhost', hostname)
        if 'does match certificate' not in checked:
            raise RuntimeError('Certificate does not cover ' + hostname)
    # Parse the final TLS/key configuration before touching either backend.
    staged_site = SITE.read_text()
    try:
        write(SITE, (STATE / 'nginx.final.conf').read_text())
        run('nginx', '-t')
    finally:
        write(SITE, staged_site)
    if health()['rooms'] and not confirm_end_rooms:
        raise RuntimeError('Game rooms remain; activation deferred to preserve live games')
    if ':8445 ' in run('ss', '-ltn'):
        raise RuntimeError('Target subscription port is occupied')
    # After the zero-room checks, block new external HTTP traffic and drain
    # queued bodies. Explicitly approved room termination skips the drain.
    rule = ['INPUT', '-p', 'tcp', '--dport', '8080', '!', '-s', '127.0.0.0/8',
            '-m', 'comment', '--comment', 'sky-ludo-https-switch', '-j', 'REJECT',
            '--reject-with', 'tcp-reset']
    run('iptables', '-w', '-I', *rule)
    try:
        if not confirm_end_rooms:
            time.sleep(31)  # server requestTimeout is 30 seconds
            if health()['rooms']:
                raise RuntimeError('New game rooms appeared; activation deferred')
    except Exception:
        run('iptables', '-w', '-D', *rule)
        raise
    try:
        # Rooms are empty, or their termination has been explicitly approved.
        run('systemctl', 'stop', 'sky-ludo')
        shutil.copyfile(STATE.with_name('https-server.mjs'), APP)
        APP.chmod(0o640)
        shutil.chown(APP, user='root', group='sky-ludo')
        write(DROPIN, '[Service]\nEnvironment=HOST=127.0.0.1\nEnvironment=TRUST_LOOPBACK_PROXY=1\n')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'sky-ludo')
        for attempt in range(15):
            try:
                health()
                break
            except Exception:
                if attempt == 14:
                    raise
                time.sleep(1)
        suburi = 'https://turn.jbba.top' + current['subPath']
        update_settings({'subPort': '8445', 'subListen': '127.0.0.1', 'subURI': suburi})
        run('systemctl', 'restart', 'x-ui')
        for attempt in range(15):
            try:
                with socket.create_connection(('127.0.0.1', 8445), timeout=1):
                    pass
                break
            except OSError:
                if attempt == 14:
                    raise RuntimeError('Subscription backend did not become ready')
                time.sleep(1)
        write(SITE, (STATE / 'nginx.final.conf').read_text())
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        run('systemctl', 'is-active', 'sky-ludo', 'x-ui', 'nginx')
        write(STATE / 'activated', str(time.time()))
        print('ACTIVE: game HTTPS, panel HTTPS, compatible old subscription route')
    except Exception:
        rollback()
        raise
    finally:
        run('iptables', '-w', '-D', *rule)


if __name__ == '__main__':
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('Run on the target host as root')
    try:
        {'prepare': prepare, 'issue': issue, 'activate': activate,
         'activate-proxy': activate_proxy, 'rollback': rollback}[sys.argv[1]]()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        raise SystemExit(1)
