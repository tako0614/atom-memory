import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the final, unchanged public-API assertions against the actual old package.
const root = resolve(import.meta.dirname, '..');
const old = process.env.ATOM_V07_PACKAGE;
if (!old || JSON.parse(readFileSync(join(old, 'package.json'), 'utf8')).version !== '0.7.0')
  throw Error('Set ATOM_V07_PACKAGE to the extracted 0.7.0 package');
const directory = mkdtempSync(join(tmpdir(), 'atom-v08-baseline-'));
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const install = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(old)],
    { cwd: directory, encoding: 'utf8', timeout: 60000 },
  );
  if (install.status !== 0) throw Error(install.stderr);
  mkdirSync(join(directory, 'test'));
  for (const file of ['fixtures.mjs', 'v08.test.mjs', 'v08-package.test.mjs'])
    writeFileSync(
      join(directory, 'test', file),
      readFileSync(join(root, 'test', file), 'utf8')
        .replaceAll("'../dist/index.js'", "'atom-memory'")
        .replaceAll("'../dist/adapters/sqlite.js'", "'atom-memory/sqlite'"),
    );
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'test/v08.test.mjs', 'test/v08-package.test.mjs'],
    { cwd: directory, encoding: 'utf8', timeout: 60000 },
  );
  writeFileSync(join(root, 'validation/v08-v07-current-tests.log'), result.stdout + result.stderr);
  const tests = Number(result.stdout.match(/# tests (\d+)/)?.[1]);
  const failed = Number(result.stdout.match(/# fail (\d+)/)?.[1]);
  if (result.status !== 1 || tests !== 84 || !(failed > 0))
    throw Error('Expected completed red assertions against v0.7');
  console.log(
    JSON.stringify({
      package: '0.7.0',
      node: process.version,
      tests,
      failed,
      passed: Number(result.stdout.match(/# pass (\d+)/)?.[1]),
      expectedFailure: true,
      realLLM: false,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
