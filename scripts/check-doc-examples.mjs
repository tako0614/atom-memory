import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '..');
const temporary = resolve(root, '.doc-examples');
mkdirSync(temporary, { recursive: true });
// Keep example databases out of the worktree and respect the host's TMPDIR.
const dataDirectory = mkdtempSync(resolve(tmpdir(), 'atom-memory-examples-'));
const programs = new Set();
const expectedOutputs = new Map();
let index = 0;
try {
  const documents = readdirSync(resolve(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${name}`);
  for (const doc of [...documents, 'README.md']) {
    const markdown = readFileSync(resolve(root, doc), 'utf8');
    // A tutorial can explain each step separately while keeping one executable session.
    const session = [...markdown.matchAll(/```ts session\n([\s\S]*?)\n```/g)];
    if (session.length) {
      const path = resolve(temporary, `${basename(doc, '.md')}-session.ts`);
      writeFileSync(path, session.map((match) => match[1]).join('\n\n'));
      programs.add(path);
    }
    for (const match of markdown.matchAll(/```ts runnable\n([\s\S]*?)\n```/g)) {
      const path = resolve(temporary, `snippet-${++index}.ts`);
      writeFileSync(path, match[1]);
      programs.add(path);
    }
    for (const match of markdown.matchAll(/^<<< (.+\.mjs)$/gm)) {
      const path = resolve(dirname(resolve(root, doc)), match[1]);
      const dest = resolve(temporary, basename(path));
      writeFileSync(
        dest,
        readFileSync(path, 'utf8').replaceAll("'../dist/index.js'", "'atom-memory'"),
      );
      programs.add(dest);
    }
    for (const match of markdown.matchAll(/```text output:([\w.-]+)\n([\s\S]*?)\n```/g)) {
      const expected = match[2].trim();
      if (expectedOutputs.has(match[1]) && expectedOutputs.get(match[1]) !== expected)
        throw Error(`Conflicting documented output for ${match[1]}`);
      expectedOutputs.set(match[1], expected);
    }
  }
  const examples = [...programs];
  for (const name of expectedOutputs.keys()) {
    if (!examples.some((path) => basename(path) === name))
      throw Error(`Documented output has no executable example: ${name}`);
  }
  if (examples.length < 4)
    throw Error('Expected executable guide, API, runtime and storage examples');
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
      cwd: dataDirectory,
      encoding: 'utf8',
      timeout: 60000,
      env: process.env,
    });
    if (run.status !== 0)
      throw Error(
        `${source}: ${run.error?.message ?? run.signal ?? run.status}\n${run.stdout}${run.stderr}`,
      );
    const expected = expectedOutputs.get(basename(source));
    if (expected !== undefined && run.stdout.trim() !== expected)
      throw Error(
        `${source}: output differs from the documentation\nExpected: ${expected}\nActual: ${run.stdout}`,
      );
  }
  console.log(
    `Documentation: extracted, typechecked and executed ${examples.length} examples; verified ${expectedOutputs.size} documented outputs.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(dataDirectory, { recursive: true, force: true });
}
