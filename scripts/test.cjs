const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function run(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tests', name)], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject);
    child.on('close', code => {
      if (code) return reject(Error(`${name} failed (${code})\n${output}\n${errors}`));
      try { resolve({suite: name, ...JSON.parse(output)}); } catch { reject(Error(`${name}: invalid report\n${output}`)); }
    });
  });
}
(async () => {
  await fs.mkdir(path.join(root, 'reports/test-artifacts'), {recursive: true});
  const names = (await fs.readdir(path.join(root, 'tests'))).filter(n => n.endsWith('.test.cjs')).sort();
  const results = [];
  for (let i = 0; i < names.length; i += 3) {
    const batch = await Promise.allSettled(names.slice(i, i + 3).map(run));
    for (const r of batch) {
      if (r.status === 'rejected') throw r.reason;
      results.push(r.value); console.log(`${r.value.suite}: ${r.value.passed} passed`);
    }
  }
  const report = {passed: results.reduce((sum, r) => sum + r.passed, 0), suites: results};
  await fs.writeFile(path.join(root, 'reports/test-results.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed} checks passed`);
})().catch(error => {console.error(error); process.exitCode = 1;});
