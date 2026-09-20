#!/usr/bin/env node
/**
 * Packages the built site as a distributable ZIP.
 *
 * The site is a multi-chunk ES module application that fetches its data and loads a WebAssembly
 * Python runtime, so it cannot be opened from a `file://` URL: the archive ships the whole `dist/`
 * tree plus a short README explaining how to serve it locally.
 *
 * `--source` additionally snapshots the tracked sources from Git, excluding every generated tree.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');
/** Fixed timestamp so repeated packaging of the same inputs is byte-identical. */
const STAMP = new Date('2026-01-01T00:00:00Z');

const EXCLUDED = new Set(['dist', 'release', 'reports', 'research', 'node_modules', 'vendor', '.git', '.github']);

/** Minimal ZIP writer: stored/deflated entries with deterministic metadata. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function writeZip(entries) {
  const { time, day } = dosTime(STAMP);
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(content, { level: 9 });
    const useDeflate = deflated.length < content.length;
    const body = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

async function walk(absolute, relative, out) {
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(path.join(absolute, entry.name), next, out);
    else if (entry.isFile()) out.set(next, await readFile(path.join(absolute, entry.name)));
  }
  return out;
}

function gitFiles() {
  const result = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('无法读取 Git 文件列表；请先在本项目初始化 Git 并暂存源码。');
  return result.stdout.split('\0').filter(Boolean);
}

async function sourceEntries(prefix) {
  const repo = spawnSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  if (path.resolve(repo) !== ROOT) throw Error('请在项目根目录初始化 Git 后再打包源码快照。');

  const entries = new Map();
  for (const name of gitFiles()) {
    const parts = name.split('/');
    if (parts.some(part => EXCLUDED.has(part))) continue;
    const absolute = path.join(ROOT, name);
    if (!existsSync(absolute)) continue;
    const info = await stat(absolute);
    if (!info.isFile()) continue;
    entries.set(prefix + name, await readFile(absolute));
  }
  return entries;
}

const noBuild = process.argv.includes('--no-build');
const withSource = process.argv.includes('--source');

if (!noBuild) {
  const build = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) throw Error('构建失败，未生成发布包。');
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  throw Error('缺少 dist/index.html；请先运行 pnpm build。');
}

const version = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw Error(`版本号不合法：${version}`);

await mkdir(RELEASE, { recursive: true });
const name = `endfield-blueprint-editor-${version}`;

const entries = await walk(DIST, `${name}/`, new Map());
entries.set(
  `${name}/README.txt`,
  Buffer.from(
    '终末地蓝图编辑器\n\n' +
      '本目录是完整站点，需要用一个本地 HTTP 服务打开，不能直接双击 index.html。\n' +
      '原因是应用以多 chunk ES module 分发，并在浏览器内用 WebAssembly 版的 Pyodide + Pillow\n' +
      '实时合成素材；file:// 协议下模块加载与数据 fetch 都会被浏览器拒绝。\n\n' +
      '在本目录执行任意一种方式，然后访问提示的地址：\n' +
      '  python -m http.server 8769\n' +
      '  npx serve -l 8769\n\n' +
      '首次打开需要在本机合成素材，请保持页面打开；之后会走本机缓存，再次打开很快。\n' +
      '布局请使用「保存 JSON」备份；浏览器草稿不会随文件迁移。\n' +
      '本工具不模拟生产规则，JSON 不是游戏分享码。\n\n' +
      '素材与字体说明见 THIRD_PARTY_NOTICES.md，字体许可见 assets/fonts/LICENSE-update.txt。\n',
    'utf8',
  ),
);

for (const extra of [
  'THIRD_PARTY_NOTICES.md',
  'assets/fonts/LICENSE-update.txt',
  'docs/display-audit.md',
  'docs/missing-icons.md',
]) {
  if (existsSync(path.join(ROOT, extra))) entries.set(`${name}/${extra}`, await readFile(path.join(ROOT, extra)));
}
if (existsSync(path.join(ROOT, 'LICENSE'))) entries.set(`${name}/LICENSE`, await readFile(path.join(ROOT, 'LICENSE')));

const packages = [path.join(RELEASE, `${name}-site.zip`)];
await writeFile(packages[0], writeZip(entries));

if (withSource) {
  const source = path.join(RELEASE, `${name}-source.zip`);
  await writeFile(source, writeZip(await sourceEntries(`${name}-source/`)));
  packages.push(source);
}

const lines = [];
for (const file of packages) {
  const bytes = await readFile(file);
  lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(file)}`);
  console.log(`${path.basename(file)}: ${(bytes.length / 1024 ** 2).toFixed(2)} MiB`);
}
await writeFile(path.join(RELEASE, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`Ready: ${RELEASE}`);
