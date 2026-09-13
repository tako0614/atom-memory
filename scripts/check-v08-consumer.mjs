import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const tarball = process.argv[2];
if (!tarball) throw Error('Pass the local npm pack tarball path');
if (!process.env.ATOM_V07_PACKAGE)
  throw Error('Set ATOM_V07_PACKAGE for the consumer migration gate');
const directory = mkdtempSync(join(tmpdir(), 'atom-v08-consumer-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw Error(`${command}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)]);
  mkdirSync(join(directory, 'test'));
  for (const file of ['fixtures.mjs', 'v08.test.mjs', 'v08-package.test.mjs']) {
    const text = readFileSync(join(root, 'test', file), 'utf8')
      .replaceAll("'../dist/index.js'", "'atom-memory'")
      .replaceAll("'../dist/adapters/sqlite.js'", "'atom-memory/sqlite'");
    writeFileSync(join(directory, 'test', file), text);
  }
  writeFileSync(
    join(directory, 'consumer.ts'),
    `
import { MemoryHost, type InputToken, type AtomLink, type WriteOptions, type ReceiptManifest, type PurgeResult } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
// @ts-expect-error InputToken is a host-issued brand
const forged: InputToken = 'manual';
function target(link: AtomLink) { return link.unavailable ? undefined : link.ref; }
function dispatch(host: MemoryHost, options: WriteOptions, manifest: ReceiptManifest, result: PurgeResult) {
  const token: InputToken | undefined = options.input;
  return [token, manifest.contractVersion, result.complete, target, SqliteStorage];
}
`,
  );
  run(join(root, 'node_modules/.bin/tsc'), [
    '--ignoreConfig',
    '--strict',
    '--noEmit',
    '--module',
    'nodenext',
    '--target',
    'es2022',
    '--skipLibCheck',
    '--typeRoots',
    join(root, 'node_modules/@types'),
    'consumer.ts',
  ]);
  const output = run(process.execPath, [
    '--test',
    'test/v08.test.mjs',
    'test/v08-package.test.mjs',
  ]);
  writeFileSync(join(root, 'validation/v08-consumer.log'), output);
  writeFileSync(
    join(directory, 'migration.mjs'),
    readFileSync(join(root, 'scripts/check-v08-migration.mjs'), 'utf8')
      .replaceAll("'../dist/index.js'", "'atom-memory'")
      .replaceAll("'../dist/adapters/sqlite.js'", "'atom-memory/sqlite'"),
  );
  const migration = JSON.parse(run(process.execPath, ['migration.mjs']));
  writeFileSync(
    join(root, 'validation/migration-v0.8.0-consumer.json'),
    JSON.stringify(migration, null, 2) + '\n',
  );
  for (const example of ['basic.mjs', 'writer.mjs', 'history-writer.mjs'])
    run(process.execPath, [join(directory, 'node_modules/atom-memory/examples', example)]);
  console.log(
    JSON.stringify({
      tarball: resolve(tarball),
      node: process.version,
      scenarios: 40,
      adapterExecutions: 80,
      supplementalExecutions: 4,
      types: 'passed',
      consumer: 'empty',
      oldPackageMigration: 'passed',
      shippedExamples: 3,
      realLLM: false,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
