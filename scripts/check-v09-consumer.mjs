import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const tarball = process.argv[2];
if (!tarball) throw Error('Pass the local npm pack tarball path');
if (!process.env.ATOM_V08_PACKAGE)
  throw Error('Set ATOM_V08_PACKAGE for the consumer migration gate');
const directory = mkdtempSync(join(tmpdir(), 'atom-v09-consumer-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw Error(`${command}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)]);
  mkdirSync(join(directory, 'test'));
  for (const file of ['fixtures.mjs', 'v08.test.mjs', 'v08-package.test.mjs', 'v09.test.mjs']) {
    const text = readFileSync(join(root, 'test', file), 'utf8')
      .replaceAll("'../dist/index.js'", "'atom-memory'")
      .replaceAll("'../dist/adapters/sqlite.js'", "'atom-memory/sqlite'")
      .replaceAll(
        "'../dist/client/observation.js'",
        "'../node_modules/atom-memory/dist/client/observation.js'",
      );
    writeFileSync(join(directory, 'test', file), text);
  }
  writeFileSync(
    join(directory, 'consumer.ts'),
    `
import { MemoryHost, type InputToken, type AtomLink, type MemoryChange, type ReceiptManifest, type PurgeResult } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
// @ts-expect-error InputToken is a host-issued brand
const forged: InputToken = 'manual';
function target(link: AtomLink) { return link.unavailable ? undefined : link.ref; }
function dispatch(host: MemoryHost, change: MemoryChange, manifest: ReceiptManifest, result: PurgeResult) {
  const token: InputToken | undefined = change.input;
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
    '--test-reporter=tap',
    'test/v08.test.mjs',
    'test/v08-package.test.mjs',
    'test/v09.test.mjs',
  ]);
  writeFileSync(join(root, 'validation/v09-consumer.log'), output);
  writeFileSync(
    join(directory, 'migration.mjs'),
    readFileSync(join(root, 'scripts/check-v09-migration.mjs'), 'utf8')
      .replaceAll("'../dist/index.js'", "'atom-memory'")
      .replaceAll("'../dist/adapters/sqlite.js'", "'atom-memory/sqlite'"),
  );
  const migration = JSON.parse(run(process.execPath, ['migration.mjs']));
  writeFileSync(
    join(root, 'validation/migration-v0.9.0-consumer.json'),
    JSON.stringify(migration, null, 2) + '\n',
  );
  for (const example of ['basic.mjs', 'writer.mjs', 'history-writer.mjs'])
    run(process.execPath, [join(directory, 'node_modules/atom-memory/examples', example)]);
  console.log(
    JSON.stringify({
      tarball: resolve(tarball),
      node: process.version,
      testExecutions: Number(output.match(/# tests (\d+)/)?.[1]),
      failures: Number(output.match(/# fail (\d+)/)?.[1]),
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
