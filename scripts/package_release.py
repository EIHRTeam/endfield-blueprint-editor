"""Build a portable ZIP and optionally a source ZIP from the Git file list."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STAMP = (2026, 1, 1, 0, 0, 0)


def write_zip(target, entries):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content, compresslevel=9)


def source_entries(prefix):
    repo = Path(subprocess.check_output(
        ['git', '-C', str(ROOT), 'rev-parse', '--show-toplevel'], text=True,
    ).strip()).resolve()
    if repo != ROOT:
        raise SystemExit('Initialize Git in this project and stage the source files first.')
    names = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z']).decode('utf-8').split('\0')
    entries = {}
    excluded = {'dist', 'release', 'reports', 'research', 'node_modules', '.venv', '.git'}
    for name in filter(None, names):
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or set(Path(name).parts) & excluded or (ROOT / name).is_symlink():
            raise SystemExit(f'Unexpected source archive entry: {name}')
        entries[prefix + name] = path.read_bytes()
    if prefix + 'src/editor_app.js' not in entries:
        raise SystemExit('Source files have not been staged. Run git add . first.')
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-build', action='store_true', help='Package the existing verified HTML')
    parser.add_argument('--source', action='store_true', help='Also package files tracked/staged in this project')
    args = parser.parse_args()
    subprocess.run([sys.executable, str(ROOT / 'scripts/verify_inputs.py')], check=True)
    if not args.no_build:
        subprocess.run([sys.executable, str(ROOT / 'scripts/build.py')], check=True)
    html = ROOT / 'dist/blueprint_editor.html'
    if not html.is_file():
        raise SystemExit('Build first: python scripts/build.py')
    version = json.loads((ROOT / 'package.json').read_text('utf-8'))['version']
    if not re.fullmatch(r'[0-9A-Za-z][0-9A-Za-z.+-]*', version):
        raise SystemExit('Invalid package version')
    name = f'endfield-blueprint-editor-{version}'
    out = ROOT / 'release'
    out.mkdir(exist_ok=True)
    prefix = name + '/'
    entries = {
        prefix + 'blueprint_editor.html': html.read_bytes(),
        prefix + 'README.txt': (
            '终末地蓝图编辑器\n\n'
            '解压后用 Chrome / Edge 打开 blueprint_editor.html，即可离线使用。\n'
            '无需 Python、Node.js、游戏安装或其他目录。\n'
            '布局请使用“保存 JSON”备份；浏览器草稿不会随文件迁移。\n'
            '“蓝图预览”可编辑右侧详情，设备清单自动生成，支持完整 PNG 导出。\n'
            '本工具不模拟生产规则，JSON 不是游戏分享码。\n\n'
            '素材与字体说明见 THIRD_PARTY_NOTICES.md，字体许可见 assets/fonts/LICENSE-update.txt。\n'
            '功能边界见 docs/display-audit.md，缺图明细见 docs/missing-icons.md。\n'
        ).encode('utf-8'),
    }
    for path in ['THIRD_PARTY_NOTICES.md', 'assets/fonts/LICENSE-update.txt',
                 'docs/display-audit.md', 'docs/missing-icons.md']:
        entries[prefix + path] = (ROOT / path).read_bytes()
    if (ROOT / 'LICENSE').is_file():
        entries[prefix + 'LICENSE'] = (ROOT / 'LICENSE').read_bytes()
    packages = [out / f'{name}-portable.zip']
    write_zip(packages[0], entries)
    if args.source:
        source = out / f'{name}-source.zip'
        write_zip(source, source_entries(name + '-source/'))
        packages.append(source)
    lines = []
    for path in packages:
        lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}')
        print(f'{path.name}: {path.stat().st_size / 1024 ** 2:.2f} MiB')
    (out / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Ready: {out}')


if __name__ == '__main__':
    main()
