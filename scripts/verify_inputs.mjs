#!/usr/bin/env node
/**
 * Verifies the packaged source inputs against `data/input_checksums.json`.
 *
 * The manifest lists every original game asset, table and font chunk by sha256. It is the only thing
 * that proves the deployed artwork is the artwork that was audited, so it is checked independently of
 * the build.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'data/input_checksums.json');

const records = JSON.parse(await readFile(MANIFEST, 'utf8'));
const missing = [];
const changed = [];

for (const [name, expected] of Object.entries(records)) {
  const file = path.resolve(ROOT, name);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    missing.push(name);
    continue;
  }
  const digest = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  if (digest !== expected) changed.push(name);
}

if (missing.length || changed.length) {
  const lines = [];
  if (missing.length) lines.push(`missing (${missing.length}):`, ...missing.map(name => `  ${name}`));
  if (changed.length) lines.push(`modified (${changed.length}):`, ...changed.map(name => `  ${name}`));
  console.error(`Input verification failed.\n${lines.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${Object.keys(records).length} local asset and data inputs`);
}
