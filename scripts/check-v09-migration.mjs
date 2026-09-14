// v0.8 data -> v0.9 API. Temporary stores only; no user DB and no provider calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
const root = process.env.ATOM_V08_PACKAGE;
if (!root) throw Error('Set ATOM_V08_PACKAGE to an extracted atom-memory 0.8.0 package');
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.8.0');
const old = await import(pathToFileURL(resolve(root, 'dist/index.js')));
const { SqliteStorage: OldSqlite } = await import(
  pathToFileURL(resolve(root, 'dist/adapters/sqlite.js'))
);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const reports = [];
for (const adapter of ['memory', 'sqlite']) {
  const directory = mkdtempSync(join(tmpdir(), 'atom-v09-migration-'));
  const path = join(directory, 'memory.sqlite');
  let storage = adapter === 'sqlite' ? new OldSqlite(path) : new old.MemoryStorage();
  const authority = new old.LocalAuthority();
  const auth = authority.issue({
    subject: 'migration',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const agent = { ...binding, actor: { type: 'agent' } };
  try {
    let host = new old.MemoryHost({ authority, storage });
    let memory = host.connect(binding);
    const source = await memory.write('needle original source');
    const sibling = await memory.write({
      text: 'ordinary sibling',
      links: { related: source.ref },
    });
    const input = host.observe(
      { sources: [{ ref: source.ref }], payloadDigest: digest(source.text) },
      agent,
    );
    const derived = await host.connect(agent).write('needle derived claim', { input });
    host.recordUse([source.ref], binding, { eventId: 'before-migration' });
    const cursor = (await memory.search('needle', { limit: 1 })).cursor;
    assert.ok(cursor);
    const revisions = storage.history(undefined, 100);
    const use = storage.metaEntries('sdk:use:state:');
    const sourceTarget = storage.metaGet(`sdk:ref:${source.ref}`).target;
    if (adapter === 'sqlite') {
      storage.close();
      storage = new SqliteStorage(path);
    } else {
      const metadata = storage.metaEntries('');
      storage.close();
      storage = new current.MemoryStorage();
      for (const [key, value] of metadata) storage.metaSet(key, value);
      storage.append(revisions);
    }
    host = new current.MemoryHost({ authority, storage });
    memory = host.connect(binding);
    assert.deepEqual(storage.history(undefined, 100), revisions);
    await assert.rejects(memory.search('needle', { cursor, limit: 1 }), { code: 'CURSOR_EXPIRED' });
    assert.deepEqual(storage.metaEntries('sdk:use:state:'), use);
    assert.equal((await memory.inspect(source.ref, { limit: 0 })).atom.text, source.text);
    assert.equal(
      (await memory.inspect(source.ref, { direction: 'incoming' })).neighbors[0].atom.text,
      sibling.text,
    );
    assert.equal(
      host.recordUse([source.ref], binding, { eventId: 'before-migration' }).repeated,
      1,
    );
    const plan = {
      changes: [
        {
          id: 'left',
          op: 'create',
          content: { text: 'new left', links: { related: { local: 'right' } } },
          sources: [],
        },
        {
          id: 'right',
          op: 'create',
          content: { text: 'new right', links: { related: { local: 'left' } } },
          sources: [],
        },
      ],
    };
    const written = await memory.write(plan, { idempotencyKey: 'after-migration' });
    if (adapter === 'sqlite') {
      storage.close();
      storage = new SqliteStorage(path);
      host = new current.MemoryHost({ authority, storage });
      memory = host.connect(binding);
    }
    const replay = await memory.write(plan, { idempotencyKey: 'after-migration' });
    assert.equal(replay.operationId, written.operationId);
    assert.equal(replay.repeated, true);
    assert.equal((await memory.inspect(replay.changes.left.ref)).neighbors.length, 1);
    await memory.write({
      changes: [
        {
          id: 'source',
          op: 'revise',
          target: source.ref,
          content: { text: 'needle corrected source', links: [] },
          sources: [],
        },
      ],
    });
    const afterRevision = await host.connect(agent).search('needle');
    assert.ok(afterRevision.stale.includes(derived.ref));
    assert.ok(!afterRevision.items.some((item) => item.ref === derived.ref));
    const purged = host.purge(sourceTarget.atomId);
    assert.equal(purged.complete, true);
    assert.equal(purged.erasedAtomIds.length, 2);
    await assert.rejects(memory.inspect(derived.ref), { code: 'ACCESS_DENIED' });
    assert.equal((await memory.inspect(sibling.ref, { limit: 0 })).atom.text, sibling.text);
    reports.push({
      adapter,
      preservedRevisions: revisions.length,
      preservedUse: true,
      oldObservedRefs: true,
      oldCursorExpired: true,
      incomingDiscovery: true,
      localCycle: true,
      replayAfterReconnect: adapter === 'sqlite',
      oldGenerationInvalidation: true,
      ordinarySiblingSurvivesPurge: true,
    });
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    { from: '0.8.0', to: '0.9.0', node: process.version, reports, realLLM: false },
    null,
    2,
  ),
);
