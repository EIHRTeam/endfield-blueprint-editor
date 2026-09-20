/** Build-shape regression suite: the deployment gates must hold on every build. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { report } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const child = spawn(process.execPath, [path.join(ROOT, 'scripts/verify_dist.mjs')], {
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

const code = await new Promise(resolve => child.on('close', resolve));
const checks = {
  passed: stdout
    .split('\n')
    .filter(line => line.startsWith('✓'))
    .map(line => line.slice(2)),
  failed: code === 0 ? [] : stderr.split('\n').filter(Boolean),
};

if (code === 0 && !checks.passed.length) checks.failed.push('verify_dist reported success but produced no checks');
report('bundle-shape', checks);
