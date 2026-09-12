// Download/extract the published atom-memory@0.3.0 tarball first; pass its package
// directory in ATOM_V03_PACKAGE. This probe never uses a paid encoder.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryHost, HybridCandidateProvider } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
if (!process.env.ATOM_V03_PACKAGE)
  throw new Error('Set ATOM_V03_PACKAGE to an extracted published 0.3.0 package');
const oldRoot = resolve(process.env.ATOM_V03_PACKAGE);
const old = await import(pathToFileURL(join(oldRoot, 'dist/index.js')));
const { SqliteStorage: OldStorage } = await import(
  pathToFileURL(join(oldRoot, 'dist/adapters/sqlite.js'))
);
const dir = mkdtempSync(join(tmpdir(), 'atom-v03-migration-'));
const authority = new old.LocalAuthority();
const auth = authority.issue({
  subject: 'owner',
  readPolicies: ['p'],
  writePolicies: ['p'],
  canIngestSource: true,
});
const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
let documents = 0;
const embedding = {
  id: 'fixed-migration',
  dimensions: 2,
  tokenizer: old.utf8Tokenizer,
  networkCallsPerCall: 0,
  embed: async (texts, _signal, purpose) => {
    if (purpose === 'document') documents += texts.length;
    return texts.map(() => [1, 0]);
  },
};
const budget = {
  maxCandidates: 4000,
  maxBytes: 4000000,
  maxModelCalls: 100,
  maxModelInputTokens: 40000,
};
let storage = new OldStorage(join(dir, 'db.sqlite'));
try {
  const host = new old.MemoryHost({
    authority,
    storage,
    embedding,
    candidateProvider: new old.HybridCandidateProvider(),
  });
  const memory = host.connect(binding);
  const source = await memory.write('launch evidence');
  await memory.write({ text: 'launch group', links: { member: source.ref } });
  const derived = await host
    .connect({ ...binding, actor: { type: 'agent' } })
    .edit(async (draft) => {
      await draft.inspect(source.ref);
      return draft.write('launch interpretation', { sources: [{ ref: source.ref }] });
    });
  while ((await host.updateIndex(binding, { budget })).pending) {}
  const originalVectors = storage.metaEntries('sdk:index:').map(([key, v]) => [key, v.vectors]);
  const oldProgress = storage.metaEntries('sdk:index-progress:').map(([, v]) => v);
  storage.close();
  storage = new SqliteStorage(join(dir, 'db.sqlite'));
  documents = 0;
  const current = new MemoryHost({
    authority,
    storage,
    embedding,
    candidateProvider: new HybridCandidateProvider(),
  });
  let steps = 0;
  while ((await current.updateIndex(binding, { limit: 1, budget })).pending)
    assert.ok(++steps < 30);
  assert.equal(documents, 0, 'Published 0.3 vectors are reused');
  assert.deepEqual(
    storage.metaEntries('sdk:index:').map(([key, v]) => [key, v.vectors]),
    originalVectors,
  );
  assert.deepEqual(
    storage.metaEntries('sdk:index-progress:').map(([, v]) => v),
    oldProgress,
  );
  const ranked = new MemoryHost({ ...current.engine.options, ranking: { propagation: 0.7 } });
  const page = await ranked.connect(binding).search('launch', { budget });
  assert.equal(page.diagnostics.index, 'ready');
  assert.ok(
    page.items.some((item) => item.ref === derived.value.ref),
    'Changing ranking keeps valid interpretation',
  );
  assert.equal(documents, 0);
  console.log(
    JSON.stringify({
      from: 'published 0.3.0',
      to: '0.4.0',
      adapter: 'SQLite',
      vectors: originalVectors.length,
      documentsReembedded: documents,
      progressPreserved: true,
      derivedEvidencePreserved: true,
    }),
  );
} finally {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
}
