import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const temporary = resolve(root, '.doc-examples');
mkdirSync(temporary, { recursive: true });
const examples = [];
let index = 0;
try {
  for (const doc of ['docs/guide.md', 'docs/runtime.md']) {
    const markdown = readFileSync(resolve(root, doc), 'utf8');
    for (const match of markdown.matchAll(/```ts runnable\n([\s\S]*?)\n```/g)) {
      const path = resolve(temporary, `snippet-${++index}.ts`);
      writeFileSync(path, match[1]);
      examples.push(path);
    }
    for (const match of markdown.matchAll(/^<<< (.+\.mjs)$/gm)) {
      const path = resolve(dirname(resolve(root, doc)), match[1]);
      const dest = resolve(temporary, basename(path));
      writeFileSync(
        dest,
        readFileSync(path, 'utf8').replaceAll("'../dist/index.js'", "'atom-memory'"),
      );
      examples.push(dest);
    }
  }
  if (examples.length < 4)
    throw Error('Expected the guide, runtime and Writer documentation examples');
  const result = spawnSync(
    resolve(root, 'node_modules/.bin/tsc'),
    [
      '--ignoreConfig',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'es2022',
      '--skipLibCheck',
      '--allowJs',
      '--checkJs',
      '--strict',
      'false',
      '--types',
      'node',
      '--rootDir',
      temporary,
      '--outDir',
      resolve(temporary, 'out'),
      ...examples,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  for (const source of examples) {
    const file = resolve(temporary, 'out', basename(source).replace(/\.ts$/, '.js'));
    const run = spawnSync(process.execPath, [file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: process.env,
    });
    if (run.status !== 0) throw Error(`${source}: ${run.stdout}${run.stderr}`);
  }
  console.log(`Documentation: extracted, typechecked and executed ${examples.length} examples.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
