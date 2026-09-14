import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as current from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

// Generates only temporary data using the actual published package. No user DB is opened.
const root = process.env.ATOM_V07_PACKAGE;
if (!root) throw Error('Set ATOM_V07_PACKAGE to an extracted published atom-memory 0.7.0 package');
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.7.0');
const old = await import(pathToFileURL(resolve(root, 'dist/index.js')));
const { SqliteStorage: OldSqlite } = await import(
  pathToFileURL(resolve(root, 'dist/adapters/sqlite.js'))
);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const reports = [];
for (const adapter of ['memory', 'sqlite']) {
  const dir = mkdtempSync(join(tmpdir(), 'atom-v08-migration-'));
  let storage =
    adapter === 'sqlite' ? new OldSqlite(join(dir, 'legacy.sqlite')) : new old.MemoryStorage();
  const authority = new old.LocalAuthority();
  const auth = authority.issue({
    subject: 'migration',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const agent = { ...binding, actor: { type: 'agent' } };
  let documentCalls = 0;
  const embedding = {
    id: 'v08-migration-own-body',
    dimensions: 2,
    tokenizer: current.utf8Tokenizer,
    networkCallsPerCall: 0,
    async embed(texts, _signal, purpose) {
      if (purpose === 'document') documentCalls += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
  const budget = {
    maxCandidates: 20000,
    maxBytes: 32000000,
    maxAtoms: 200,
    maxPackingWork: 16000000,
  };
  const real = Date.now;
  const now = real();
  Date.now = () => now;
  try {
    let host = new old.MemoryHost({ authority, storage, embedding });
    let memory = host.connect(binding);
    const A = await memory.write('needle old source');
    const P = await memory.write({ text: 'needle legacy relation', links: { arbitrary: A.ref } });
    const D = await host
      .connect(agent)
      .write('needle old derivation', { sources: [{ ref: A.ref }] });
    await host.prepareIndex(binding, { budget });
    for (let i = 0; i < 10; i++) {
      const result = await host.updateIndex(binding, { budget });
      if (!result.pending) break;
    }
    host.recordUse([A.ref, D.ref], binding, { eventId: 'old-request' });
    const cursor = (await memory.search('needle', { limit: 1, budget })).cursor;
    const revisions = storage.history(undefined, 100);
    const indexes = storage.metaEntries('sdk:index:');
    const use = storage.metaEntries('sdk:use:state:');
    const scores = await memory.search('needle', { budget });
    const oldCalls = documentCalls;
    const target = storage.metaGet(`sdk:ref:${A.ref}`).target;
    if (adapter === 'sqlite') {
      storage.close();
      storage = new SqliteStorage(join(dir, 'legacy.sqlite'));
    } else {
      const metadata = storage.metaEntries('');
      storage.close();
      storage = new current.MemoryStorage();
      // Adapter migration preserves records; capability-bound refs are revalidated by the same trusted authority.
      for (const [key, value] of metadata) storage.metaSet(key, value);
      storage.append(revisions);
    }
    host = new current.MemoryHost({ authority, storage, embedding });
    memory = host.connect(binding);
    assert.deepEqual(storage.history(undefined, 100), revisions);
    assert.deepEqual(storage.metaEntries('sdk:index:'), indexes);
    assert.deepEqual(storage.metaEntries('sdk:use:state:'), use);
    assert.equal((await memory.inspect(A.ref, { limit: 0, budget })).atom.text, A.text);
    await assert.rejects(memory.search('needle', { cursor, limit: 1, budget }), {
      code: 'CURSOR_EXPIRED',
    });
    const migrated = await memory.search('needle', { budget });
    const oldScores = new Map(scores.items.map((i) => [i.ref, i.score]));
    const error = migrated.items.reduce((n, i) => n + Math.abs(i.score - oldScores.get(i.ref)), 0);
    assert.ok(error <= 2e-6);
    await host.prepareIndex(binding, { budget });
    assert.equal(documentCalls, oldCalls);
    assert.equal(host.recordUse([A.ref, D.ref], binding, { eventId: 'old-request' }).repeated, 2);
    const input = host.observe({ sources: [{ ref: A.ref }], payloadDigest: digest(A.text) }, agent);
    const newDerived = (
      await host.connect(agent).write({
        changes: [
          {
            id: 'derived',
            op: 'create',
            content: { text: 'needle new derivation', links: [] },
            sources: [],
            input,
          },
        ],
      })
    ).changes.derived;
    const independent = (
      await memory.write({
        changes: [
          {
            id: 'source',
            op: 'create',
            content: { text: 'independent new source', links: { related: A.ref } },
            sources: [],
          },
        ],
      })
    ).changes.source;
    const plan = host.purge(target.atomId, { dryRun: true });
    assert.equal(plan.complete, true);
    assert.equal(plan.legacyDependencies, true);
    assert.equal(plan.affectedAtomIds.length, 4);
    if (adapter === 'sqlite') {
      // Persist a stopped purge and resume through a newly opened v0.8 host.
      assert.equal(host.purge(target.atomId, { maxWork: 0 }).complete, false);
      storage.close();
      storage = new SqliteStorage(join(dir, 'legacy.sqlite'));
      host = new current.MemoryHost({ authority, storage, embedding });
      memory = host.connect(binding);
      await assert.rejects(memory.inspect(A.ref), { code: 'ACCESS_DENIED' });
    }
    const erased = host.purge(target.atomId);
    assert.equal(erased.complete, true);
    assert.equal(erased.erasedAtomIds.length, 4);
    for (const v of [A, P, D, newDerived])
      await assert.rejects(memory.inspect(v.ref), { code: 'ACCESS_DENIED' });
    assert.equal(
      (await memory.inspect(independent.ref, { budget, limit: 0 })).atom.text,
      independent.text,
    );
    assert.equal(storage.metaEntries('sdk:use:state:').length, 0);
    if (adapter === 'sqlite') storage.compact();
    reports.push({
      adapter,
      oldPackage: '0.7.0',
      preservedRevisions: revisions.length,
      preservedUse: true,
      reencodedDocuments: documentCalls - oldCalls,
      activationL1Error: error,
      oldCursorExpired: true,
      legacyCascade: true,
      newIndependentSurvives: true,
      erased: erased.erasedAtomIds.length,
      reconnect: adapter === 'sqlite',
      temporaryDataOnly: true,
    });
  } finally {
    Date.now = real;
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({ scenario: 'V08-40', node: process.version, reports, realLLM: false }, null, 2),
);
