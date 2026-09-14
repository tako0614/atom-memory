import { AtomicStore } from '../dist/core/store.js';
import { content, membership } from '../dist/core/helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, create, revise, retire } from './fixtures.mjs';
import {
  MemoryHost,
  LocalAuthority,
  pin,
  logical,
  RetryableCommitError,
  utf8Tokenizer,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
const error = (code) => (e) => e.code === code;

test('A03/A34 a lost commit acknowledgment retries the exact operation without replaying edits', async () => {
  const { host, memory: m } = fixture();
  const write = host.engine.kernel.write.bind(host.engine.kernel);
  let attempts = 0;
  host.engine.kernel.write = async (...args) => {
    const result = await write(...args);
    if (++attempts === 1) throw new RetryableCommitError('acknowledgment lost');
    return result;
  };
  const a = await create(m, 'one event');
  assert.equal(attempts, 2);
  assert.equal((await m.search('one event')).items.length, 1);
  assert.equal(host.engine.storage.watermark(), 1);
  attempts = 0;
  await revise(m, a.ref, 'updated');
  assert.equal(attempts, 2);
  assert.equal(host.engine.storage.watermark(), 2);
});

test('A35 legacy SQLite data and memberships keep exact IDs/revisions/origins across client adoption and reopen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-memory-v02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'data.sqlite');
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'owner',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  let storage = new SqliteStorage(path);
  const kernel = new AtomicStore({ storage, authority });
  await kernel.write(
    {
      idempotencyKey: 'old-fixture',
      guards: [],
      revisions: [
        {
          atomId: 'old-source',
          revisionId: 'source-1',
          expectedHead: null,
          content: content('source', 'legacy authentication', 'p'),
        },
        {
          atomId: 'old-parent',
          revisionId: 'parent-1',
          expectedHead: null,
          content: content('collection', 'legacy group', 'p'),
        },
        {
          atomId: 'old-membership',
          revisionId: 'membership-1',
          expectedHead: null,
          content: membership('old-parent', 'old-source', 'p'),
        },
      ],
    },
    auth,
  );
  const before = storage.history(undefined, 100);
  let host = new MemoryHost({ storage, authority });
  let memory = host.connect(binding);
  const ref = host.reference(pin('old-parent', 'parent-1'), binding);
  assert.ok((await memory.search('authentication')).items.length);
  const legacyGraph = await memory.inspect(ref, { limit: 100 });
  const relation = legacyGraph.neighbors.find((neighbor) =>
    neighbor.via.some((via) => via.direction === 'incoming' && via.role === 'group'),
  );
  assert.ok(relation, 'the inbound legacy membership relation remains inspectable');
  const member = relation.atom.links.find((link) => link.role === 'member');
  assert.equal((await memory.inspect(member.ref)).atom.text, 'legacy authentication');
  assert.deepEqual(storage.history(undefined, 100), before);
  const blobWrite = await host.ingestBlob(
    Buffer.from('blob 日本語 content'),
    'text/plain',
    binding,
  );
  const blob = Object.values(blobWrite.changes)[0];
  storage.close();
  storage = new SqliteStorage(path);
  t.after(() => storage.close());
  host = new MemoryHost({ storage, authority });
  memory = host.connect(binding);
  assert.equal((await memory.inspect(ref, {})).atom.text, 'legacy group');
  assert.equal(
    (await memory.inspect(blob.ref, { range: { bytes: 100 } })).range.text,
    'blob 日本語 content',
  );
  await revise(memory, ref, 'new arrangement');
  storage.close();
  storage = new SqliteStorage(path);
  host = new MemoryHost({ storage, authority });
  memory = host.connect(binding);
  assert.equal((await memory.inspect(ref, {})).atom.text, 'legacy group');
  assert.equal((await memory.inspect(ref, { version: 'latest' })).atom.text, 'new arrangement');
});

test('A08/A32 index preparation advances and index changes expire search cursors', async () => {
  const embedding = {
    id: 'vector',
    dimensions: 2,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    embed: async () => [[0, 0]],
  };
  const { host, memory: m, binding } = fixture({ embedding });
  for (let i = 0; i < 3; i++) await create(m, `search term ${i}`);
  const old = await m.search('search term', { limit: 1 });
  let page = await host.prepareIndex(binding, { limit: 1 });
  let indexed = page.indexed;
  let steps = 0;
  while (page.cursor) {
    assert.ok(steps++ < 10);
    page = await host.prepareIndex(binding, { limit: 1, cursor: page.cursor });
    indexed += page.indexed;
  }
  assert.equal(indexed, 3);
  assert.equal((await m.search('search term')).diagnostics.index, 'ready');
  await assert.rejects(m.search('search term', { cursor: old.cursor }), error('CURSOR_EXPIRED'));
});

test('A07/A20/A32 bounded ranking freezes its candidates before paginating without reranking', async () => {
  const { memory: m } = fixture({ retrieval: { maxScan: 5 } });
  for (let i = 0; i < 14; i++) await create(m, `candidate ${i}`);
  let page = await m.search('candidate', { limit: 2 });
  const seen = new Set(page.items.map((i) => i.ref));
  let steps = 0;
  while (page.cursor) {
    assert.ok(steps++ < 20);
    page = await m.search('candidate', { limit: 2, cursor: page.cursor });
    page.items.forEach((i) => seen.add(i.ref));
  }
  assert.equal(seen.size, 5);
  assert.equal(page.diagnostics.approximate, true);
  let read = await m.read({ query: 'candidate' }, { limit: 2, tokens: 4000 });
  const readSeen = new Set(read.refs);
  steps = 0;
  while (read.cursor) {
    assert.ok(steps++ < 30);
    read = await m.read({ query: 'candidate' }, { limit: 2, tokens: 4000, cursor: read.cursor });
    read.refs.forEach((r) => readSeen.add(r));
  }
  assert.equal(readSeen.size, 5);
});

test('A31 vector cache is partitioned by authorization and cancellation reaches the embedding call', async () => {
  let calls = 0;
  let abortSeen = false;
  const embedding = {
    id: 'partitioned',
    dimensions: 2,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 1,
    embed: async () => {
      calls++;
      return [[0, 0]];
    },
  };
  const { host, binding, memory: m, authority } = fixture({ embedding });
  await create(m, 'cache target');
  await m.search('cache target');
  await m.search('cache target');
  assert.equal(calls, 1);
  const auth = authority.issue({ subject: 'other', readPolicies: ['p'], writePolicies: ['p'] });
  await host.connect({ ...binding, auth, actor: { type: 'agent' } }).search('cache target');
  assert.equal(calls, 2);
  const controller = new AbortController();
  embedding.embed = async (_texts, signal) =>
    new Promise(() => {
      signal.addEventListener('abort', () => {
        abortSeen = true;
      });
      controller.abort();
    });
  await assert.rejects(
    m.search('different query', { signal: controller.signal }),
    error('ABORTED'),
  );
  assert.ok(abortSeen);
});

test('A31 purge invalidates issued refs, summaries and cached representation routes', async () => {
  const { host, memory: m, writer, binding } = fixture();
  const a = await create(m, 'private erase');
  await create(writer, 'private summary', { sources: [{ ref: a.ref }] });
  const trace = await m.read({ query: 'private' });
  const target = host.engine.storage.metaGet(`sdk:ref:${a.ref}`).target;
  host.purge(target.atomId);
  await assert.rejects(m.inspect(a.ref), error('ACCESS_DENIED'));
  assert.throws(() => m.assertAuthorized([trace.receipt]), error('STATE_INVALIDATED')); // v0.8 erases the stored trace itself.
  assert.equal((await m.search('private')).items.length, 0);
});

test('A19 stale required generated conditions cannot enter as unvalidated companions', async () => {
  const { memory: m, writer } = fixture();
  const source = await create(m, 'approval is granted');
  const condition = await create(writer, 'approval granted', { sources: [{ ref: source.ref }] });
  const claim = await create(m, {
    text: 'permission allowed',
    links: { condition: { ref: condition.ref, required: true } },
  });
  await revise(m, source.ref, 'approval is denied');
  const recalled = await m.read({ query: 'permission allowed' }, { tokens: 10000 });
  assert.ok(!recalled.items.some((i) => i.ref === claim.ref));
  assert.doesNotMatch(recalled.text, /approval granted/);
});

test('historical analysis of old generated inputs preserves provenance without demanding current heads', async () => {
  const { memory: m, writer, host, binding } = fixture();
  const a = await create(m, 'historical original');
  const generated = await create(writer, 'historical explanation', { sources: [{ ref: a.ref }] });
  await revise(m, a.ref, 'current source');
  const observed = await writer.inspect(generated.ref);
  const historicalInput = host.observe(
    {
      presentations: [{ receipt: observed.receipt }],
      basis: 'historical',
      payloadDigest: createHash('sha256')
        .update('historical analysis of that explanation')
        .digest('hex'),
    },
    { ...binding, actor: { type: 'agent' } },
  );
  const analysis = await create(writer, 'historical analysis of that explanation', {
    input: historicalInput,
  });
  const read = await m.read({ query: 'historical analysis' }, { tokens: 10000 });
  assert.ok(read.items.some((i) => i.ref === analysis.ref));
});

test('retiring generated Atoms preserves links and citations while host controls provenance', async () => {
  const { memory: m, writer } = fixture();
  const a = await create(m, 'retirement source');
  const summary = await create(
    writer,
    { text: 'retirement summary', links: { 資料: a.ref } },
    { sources: [{ ref: a.ref }] },
  );
  const result = await retire(m, summary.ref);
  const detail = await m.inspect(result.value.ref);
  assert.equal(detail.atom.state, 'retired');
  assert.equal(detail.atom.links[0].ref, a.ref);
  assert.equal(detail.atom.sources[0].ref, a.ref);
  assert.equal((await m.inspect(summary.ref)).atom.state, 'active');
});

test('a host with multiple read policies can write an independent input without relabelling search scope', async () => {
  const { host, authority, binding } = fixture();
  const auth = authority.issue({
    subject: 'multi',
    readPolicies: ['p', 'q'],
    writePolicies: ['p', 'q'],
    canIngestSource: true,
  });
  const memory = host.connect({ ...binding, auth });
  const a = await create(memory, 'ordinary input');
  assert.equal((await memory.inspect(a.ref)).atom.text, 'ordinary input');
});

test('range-dependent edits require the adapter query-guard capability before publishing', async () => {
  const { host, memory, writer, binding } = fixture();
  await create(memory, 'guarded source');
  const observed = await writer.search('guarded');
  const input = host.observe(
    {
      watches: [observed.receipt],
      payloadDigest: createHash('sha256').update('guarded explanation').digest('hex'),
    },
    { ...binding, actor: { type: 'agent' } },
  );
  host.engine.storage.capabilities = { snapshot: true, atomicBatch: true, queryGuards: false };
  await assert.rejects(
    create(writer, 'guarded explanation', { input }),
    error('GUARD_VALIDATION_UNAVAILABLE'),
  );
  assert.equal((await memory.search('explanation')).items.length, 0);
});
