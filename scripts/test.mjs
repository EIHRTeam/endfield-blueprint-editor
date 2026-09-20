#!/usr/bin/env node
/**
 * Test runner.
 *
 * Each suite runs as its own process and prints a JSON summary. The browser suite is the only slow
 * one (it bakes the sprite set once through Pyodide), so suites run sequentially to keep the machine
 * from contending for CPU during that bake.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TESTS = path.join(ROOT, 'tests');

function run(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(TESTS, name)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code) return reject(Error(`${name} failed (${code})\n${stdout}\n${stderr}`));
      const line = stdout.split('\n').find(entry => entry.trim().startsWith('{'));
      if (!line) return reject(Error(`${name}: no report\n${stdout}`));
      resolve(JSON.parse(line));
    });
  });
}

await mkdir(path.join(ROOT, 'reports/test-artifacts'), { recursive: true });

const names = (await readdir(TESTS)).filter(name => name.endsWith('.test.mjs')).sort();
const results = [];
for (const name of names) {
  const result = await run(name);
  results.push(result);
  console.log(`${result.suite}: ${result.passed} passed${result.failed ? `, ${result.failed} failed` : ''}`);
}

const totals = {
  passed: results.reduce((sum, result) => sum + result.passed, 0),
  failed: results.reduce((sum, result) => sum + result.failed, 0),
  suites: results,
};
await writeFile(path.join(ROOT, 'reports/test-results.json'), `${JSON.stringify(totals, null, 2)}\n`);

if (totals.failed) {
  process.exitCode = 1;
} else {
  console.log(`${totals.passed} checks passed`);
}
