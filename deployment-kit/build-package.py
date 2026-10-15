#!/usr/bin/env python3
"""Build a portable source/deployment kit from an explicit file allowlist."""
from datetime import datetime, timezone
import gzip
import hashlib
import io
from pathlib import Path
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts'
VERSION = '20261009'
PREFIX = 'sky-ludo'
STAMP = int(datetime(2026, 10, 9, tzinfo=timezone.utc).timestamp())
PORTABLE = [
    'deploy/portable/install.sh',
    'deploy/portable/sky-ludo.service',
    'deploy/portable/setup-https.sh',
    'deploy/portable/nginx-http.conf.template',
    'deploy/portable/nginx-https.conf.template',
]
FILES = ['server.mjs', 'engine.mjs', 'board.mjs', 'package.json',
         'test/engine.test.mjs', 'test/server.test.mjs', *PORTABLE]
README = '''# 飞行棋可移植部署包

完整操作步骤见 [部署说明.md](部署说明.md)。

Ubuntu 22.04/24.04，x86_64/ARM64，root/sudo + systemd。
网站只使用 Node.js 内置模块，不需要 npm install 或数据库。

房主可在“房间管理”查看全员接管码，并在对局开始前移出其他成员。

先 sha256sum -c FILES.sha256，再 bash deploy/portable/install.sh。
安装依赖和 HTTPS 命令请按部署说明执行；域名/邮箱必须替换成自己的值。
更新或重启会结束内存房间，HTTPS 操作也需要没有房间或明确允许结束。

test/ 是可选开发验证；生产服务不依赖它。
deploy/portable/ 是其他服务器用的通用脚本，不是旧主机的迁移配置。
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def payloads():
    files = list(FILES)
    for path in sorted((ROOT / 'public').rglob('*')):
        relative = path.relative_to(ROOT)
        if path.is_symlink() or any(part.startswith('.') for part in relative.parts):
            raise ValueError('Unexpected public symlink/hidden entry: ' + relative.as_posix())
        if path.is_file():
            files.append(relative.as_posix())
    result = {}
    for name in sorted(files):
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Required ordinary file missing: ' + name)
        data = path.read_bytes()
        # Shell, unit and template text must remain runnable after Windows upload.
        if name in PORTABLE:
            data = data.replace(b'\r\n', b'\n')
            if data.startswith(b'\xef\xbb\xbf') or b'\r' in data:
                raise ValueError('Unexpected BOM/CR in deployment file: ' + name)
        result[name] = data
    guide = (ROOT / 'deployment-kit/部署操作指南.md').read_text(encoding='utf-8')
    result['部署说明.md'] = guide.replace('\r\n', '\n').encode('utf-8')
    result['README.md'] = README.encode('utf-8')
    result['FILES.sha256'] = ''.join(
        f'{digest(data)}  {name}\n' for name, data in sorted(result.items())
    ).encode('utf-8')
    return result


def permissions(name):
    return 0o755 if name.endswith('.sh') else 0o644


def build_tar(filename, contents):
    directories = {PREFIX}
    for name in contents:
        directory = Path(PREFIX, name).parent
        while directory.as_posix() != '.':
            directories.add(directory.as_posix())
            directory = directory.parent
    with filename.open('wb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
            with tarfile.open(mode='w', fileobj=compressed, format=tarfile.PAX_FORMAT) as archive:
                for directory in sorted(directories):
                    info = tarfile.TarInfo(directory)
                    info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, STAMP
                    archive.addfile(info)
                for name, data in sorted(contents.items()):
                    info = tarfile.TarInfo(f'{PREFIX}/{name}')
                    info.size, info.mode, info.mtime = len(data), permissions(name), STAMP
                    archive.addfile(info, io.BytesIO(data))


def build_zip(filename, contents):
    with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(contents.items()):
            info = zipfile.ZipInfo(f'{PREFIX}/{name}', (2026, 10, 9, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100000 | permissions(name)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)


def verify(filename, expected):
    if filename.suffix == '.zip':
        with zipfile.ZipFile(filename) as archive:
            actual = {name: archive.read(name) for name in archive.namelist()}
    else:
        with tarfile.open(filename, 'r:gz') as archive:
            members = archive.getmembers()
            if any(not member.isfile() and not member.isdir() for member in members):
                raise ValueError('Archive contains a non-regular entry')
            actual = {member.name: archive.extractfile(member).read()
                      for member in members if member.isfile()}
    expected = {f'{PREFIX}/{name}': data for name, data in expected.items()}
    if actual != expected:
        raise ValueError('Archive bytes do not match the explicit payloads')
    for name in actual:
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not name.startswith(PREFIX + '/'):
            raise ValueError('Unsafe archive path: ' + name)
        if name.endswith(('.pem', '.key', '.db')) or '.local' in path.parts or '.git' in path.parts:
            raise ValueError('Unexpected private artifact: ' + name)


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    contents = payloads()
    archives = [OUT / f'sky-ludo-deploy-{VERSION}.tar.gz', OUT / f'sky-ludo-deploy-{VERSION}.zip']
    build_tar(archives[0], contents)
    build_zip(archives[1], contents)
    sums = []
    for archive in archives:
        verify(archive, contents)
        sha = digest(archive.read_bytes())
        sums.append(f'{sha}  {archive.name}\n')
        print(f'PASS {archive.name}: {len(contents)} files, {archive.stat().st_size} bytes, SHA256 {sha}')
    (OUT / 'SHA256SUMS.txt').write_text(''.join(sums), encoding='utf-8', newline='\n')
