import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

const packageRoot = process.env.ATOM_V04_PACKAGE;
if (!packageRoot)
  throw new Error('Set ATOM_V04_PACKAGE to an extracted or installed published 0.4.0 package');

const oldRoot = resolve(packageRoot);
const oldPackage = JSON.parse(readFileSync(join(oldRoot, 'package.json'), 'utf8'));
const currentPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
assert.equal(oldPackage.name, 'atom-memory');
assert.equal(oldPackage.version, '0.4.0');
assert.equal(currentPackage.name, 'atom-memory');
assert.match(currentPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const old = await import(pathToFileURL(join(oldRoot, 'dist/index.js')));
const { SqliteStorage: OldStorage } = await import(
  pathToFileURL(join(oldRoot, 'dist/adapters/sqlite.js'))
);

const directory = mkdtempSync(join(tmpdir(), 'atom-v04-migration-'));
const authority = new old.LocalAuthority();
const auth = authority.issue({
  subject: 'owner',
  readPolicies: ['p'],
  writePolicies: ['p'],
  canIngestSource: true,
});
const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
const documents = [];
const embedding = {
  id: 'migration-body-v1',
  dimensions: 2,
  tokenizer: old.utf8Tokenizer,
  networkCallsPerCall: 0,
  embed: async (texts, _signal, purpose) => {
    if (purpose === 'document') documents.push(...texts);
    return texts.map(() => [1, 0]);
  },
};
const budget = {
  maxCandidates: 10000,
  maxAtoms: 200,
  maxBytes: 16000000,
  maxContextTokens: 40000,
};

async function drain(host) {
  let processed = 0;
  for (let i = 0; i < 100; i++) {
    const result = await host.updateIndex(binding, { limit: 1, budget });
    processed += result.processed;
    if (!result.pending) return processed;
  }
  throw new Error('index did not drain');
}

let storage;
try {
  storage = new OldStorage(join(directory, 'atoms.sqlite'));
  let host = new old.MemoryHost({ storage, authority, embedding });
  let memory = host.connect(binding);
  const source = await memory.write('migration_topic: original rule');
  const parent = await memory.write({
    text: 'migration_topic: collection',
    links: { member: source.ref },
  });
  const organized = await host
    .connect({ ...binding, actor: { type: 'agent' } })
    .edit(async (draft) => {
      await draft.inspect(source.ref, { version: 'latest', depth: 0 });
      return draft.write('migration_topic: interpretation', { sources: [{ ref: source.ref }] });
    });
  await host.prepareIndex(binding, { budget });
  await drain(host);
  const oldInputBytes = documents.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  const previous = storage.history(undefined, 100);
  const oldCursor = (await memory.search('migration_topic', { limit: 1, budget })).cursor;
  assert.ok(oldCursor);
  const oldDocuments = documents.length;
  storage.close();

  storage = new SqliteStorage(join(directory, 'atoms.sqlite'));
  host = new current.MemoryHost({ storage, authority, embedding });
  memory = host.connect(binding);
  const writer = host.connect({ ...binding, actor: { type: 'agent' } });
  assert.deepEqual(
    storage.history(undefined, 100),
    previous,
    'content and lineage are not rewritten',
  );
  assert.equal((await memory.inspect(source.ref, { depth: 0 })).atom.text, source.text);
  await assert.rejects(memory.search('migration_topic', { cursor: oldCursor, limit: 1, budget }), {
    code: 'CURSOR_EXPIRED',
  });
  await host.prepareIndex(binding, { budget });
  assert.deepEqual(
    documents.slice(oldDocuments),
    [parent.text],
    'only the mixed-text parent needs re-encoding',
  );
  const replayed = await drain(host);
  assert.ok(replayed >= previous.length, 'v3 feed does not inherit the completed v2 checkpoint');
  assert.equal(documents.length, oldDocuments + 1);
  const beforeRevision = documents.length;
  const revised = await memory.edit((draft) =>
    draft.revise(source.ref, 'migration_topic: corrected rule'),
  );
  await drain(host);
  assert.deepEqual(
    documents.slice(beforeRevision),
    [revised.value.text],
    'source revision does not re-encode parent',
  );
  const stale = await writer.read({ query: 'migration_topic' }, { tokens: 20000, budget });
  assert.ok(stale.stale.includes(organized.value.ref));
  assert.doesNotMatch(stale.text, /migration_topic: interpretation/);
  await writer.edit((draft) =>
    draft.revise(organized.value.ref, 'migration_topic: corrected interpretation', {
      sources: [{ ref: revised.value.ref }],
    }),
  );
  assert.match(
    (await writer.read({ query: 'migration_topic' }, { tokens: 20000, budget })).text,
    /corrected interpretation/,
  );
  const record = {
    from: `published npm atom-memory ${oldPackage.version}`,
    to: currentPackage.version,
    node: process.version,
    preservedRevisions: previous.length,
    preservedObservedRefs: true,
    expiredOldCursor: true,
    reusedUnchangedVectors: previous.length - 1,
    reencodedMixedTextVectors: 1,
    v3FeedEventsReplayed: replayed,
    documentEncodesAfterLeafRevision: 1,
    oldInitialDocumentInputBytes: oldInputBytes,
    ownBodyInitialDocumentInputBytes: previous.reduce(
      (sum, revision) => sum + Buffer.byteLength(revision.body.value),
      0,
    ),
    correctedInterpretationRecall: true,
    paidCalls: 0,
    limits:
      'Fixed encoder fixture; input byte count and call counts are not billed cost or semantic quality.',
  };
  console.log(JSON.stringify(record));
} finally {
  storage?.close();
  rmSync(directory, { recursive: true, force: true });
}
