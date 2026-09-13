import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

const packageRoot = process.env.ATOM_V06_PACKAGE;
if (!packageRoot)
  throw new Error('Set ATOM_V06_PACKAGE to an extracted or installed published 0.6.0 package');

const oldRoot = resolve(packageRoot);
const oldPackage = JSON.parse(readFileSync(join(oldRoot, 'package.json'), 'utf8'));
const currentPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
assert.equal(oldPackage.name, 'atom-memory');
assert.equal(oldPackage.version, '0.6.0');
assert.equal(currentPackage.name, 'atom-memory');
assert.match(currentPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const old = await import(pathToFileURL(join(oldRoot, 'dist/index.js')));
const { SqliteStorage: OldStorage } = await import(
  pathToFileURL(join(oldRoot, 'dist/adapters/sqlite.js'))
);

const directory = mkdtempSync(join(tmpdir(), 'atom-v06-migration-'));
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
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
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
  const sourceTarget = storage.metaGet(`sdk:ref:${source.ref}`).target;
  host.recordUse([source.ref], binding, { eventId: 'legacy:model:0' });
  now += 2000;
  host.recordUse([source.ref], binding, { eventId: 'legacy:model:1' });
  const resetBinding = {
    ...binding,
    auth: authority.issue({ subject: 'reset-owner', readPolicies: ['p'], writePolicies: ['p'] }),
  };
  const resetRef = host.reference(sourceTarget, resetBinding);
  host.recordUse([resetRef], resetBinding, { eventId: 'legacy:reset-event' });
  host.resetUse(resetBinding);
  const wideBinding = {
    ...binding,
    auth: authority.issue({ subject: 'wide-owner', readPolicies: ['p'], writePolicies: ['p'] }),
  };
  const wideHost = new old.MemoryHost({
    storage,
    authority,
    embedding,
    activation: { halfLifeMs: 400 * 86400000 },
  });
  const wideRef = wideHost.reference(sourceTarget, wideBinding);
  wideHost.recordUse([wideRef], wideBinding, { eventId: 'legacy:wide-event' });
  now += 3000;
  const oldScores = await memory.search('migration_topic', { budget });
  const legacyStates = storage.metaEntries('sdk:use:state:');
  assert.equal(legacyStates.length, 2);
  assert.equal(legacyStates.find(([, value]) => value.subject === 'owner')[1].h > 1, true);
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
  const migratedScores = await memory.search('migration_topic', { budget });
  const priorScores = new Map(oldScores.items.map((item) => [item.ref, item.score]));
  assert.equal(migratedScores.items.length, priorScores.size);
  const scoreError = migratedScores.items.reduce(
    (sum, item) => sum + Math.abs(item.score - priorScores.get(item.ref)),
    0,
  );
  assert.ok(scoreError <= 2e-6, `legacy activation changed at cutover: ${scoreError}`);
  assert.deepEqual(
    storage.metaEntries('sdk:use:state:'),
    legacyStates,
    'reading only decodes legacy state without rewriting',
  );
  assert.equal(
    host.recordUse([resetRef], resetBinding, { eventId: 'legacy:reset-event' }).repeated,
    1,
  );
  assert.ok(
    !storage.metaEntries('sdk:use:state:').some(([, value]) => value.subject === 'reset-owner'),
    'old reset markers never reconstruct erased use history',
  );
  assert.equal(host.recordUse([source.ref], binding, { eventId: 'legacy:model:1' }).repeated, 1);
  assert.deepEqual(
    storage.metaEntries('sdk:use:state:'),
    legacyStates,
    'replay does not update or migrate the aggregate',
  );
  now += 1000;
  assert.equal(host.recordUse([wideRef], wideBinding, { eventId: 'new:wide-event' }).recorded, 1);
  const migratedWide = storage
    .metaEntries('sdk:use:state:')
    .find(([, value]) => value.subject === 'wide-owner')[1];
  assert.equal(
    migratedWide.state.halfLifeMs,
    400 * 86400000,
    'legacy half-life above the new cap is not shortened',
  );
  await host.prepareIndex(binding, { budget });
  assert.deepEqual(
    documents.slice(oldDocuments),
    [],
    'own-body v3 vectors are reused without any document encoding',
  );
  const replayed = await drain(host);
  assert.equal(replayed, 0, 'completed v3 feed checkpoint is preserved');
  assert.equal(documents.length, oldDocuments);
  assert.equal(
    host.recordUse([source.ref, source.ref], binding, { eventId: 'migration:model:0' }).recorded,
    1,
  );
  assert.equal(host.recordUse([source.ref], binding, { eventId: 'migration:model:0' }).repeated, 1);
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
    reusedUnchangedVectors: previous.length,
    reencodedMixedTextVectors: 0,
    v3FeedEventsReplayed: replayed,
    documentEncodesAfterLeafRevision: 1,
    oldInitialDocumentInputBytes: oldInputBytes,
    ownBodyInitialDocumentInputBytes: previous.reduce(
      (sum, revision) => sum + Buffer.byteLength(revision.body.value),
      0,
    ),
    correctedInterpretationRecall: true,
    legacyActivationL1Difference: scoreError,
    legacyStateReadWithoutRewrite: true,
    resetHistoryNotReplayed: true,
    repeatedEventDidNotMigrate: true,
    legacyHalfLifeAboveNewCapPreserved: true,
    paidCalls: 0,
    limits:
      'Fixed encoder fixture; input byte count and call counts are not billed cost or semantic quality.',
  };
  console.log(JSON.stringify(record));
} finally {
  Date.now = realNow;
  storage?.close();
  rmSync(directory, { recursive: true, force: true });
}
