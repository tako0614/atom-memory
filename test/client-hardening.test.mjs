import { AtomicStore } from '../dist/core/store.js';
import { content, membership } from '../dist/core/helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
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
  const a = await m.write('one event');
  assert.equal(attempts, 2);
  assert.equal((await m.search('one event')).items.length, 1);
  assert.equal(host.engine.storage.watermark(), 1);
  let callbacks = 0;
  attempts = 0;
  await m.edit(async (d) => {
    callbacks++;
    return d.revise(a.ref, 'updated');
  });
  assert.equal(callbacks, 1);
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
  assert.ok(
    (await memory.inspect(ref, { depth: 2, limit: 100 })).items.some(
      (i) => i.text === 'legacy authentication',
    ),
  );
  assert.deepEqual(storage.history(undefined, 100), before);
  const blob = await host.ingestBlob(Buffer.from('blob 日本語 content'), 'text/plain', binding);
  storage.close();
  storage = new SqliteStorage(path);
  t.after(() => storage.close());
  host = new MemoryHost({ storage, authority });
  memory = host.connect(binding);
  assert.equal((await memory.inspect(ref, { depth: 0 })).atom.text, 'legacy group');
  assert.equal(
    (await memory.inspect(blob.ref, { range: { bytes: 100 } })).range.text,
    'blob 日本語 content',
  );
  const next = await memory.write('new arrangement');
  await memory.edit((d) =>
    d.supersede(ref, next.ref, {
      composition: { relations: [{ parent: 'group', children: ['member'] }] },
    }),
  );
  await memory.edit((d) =>
    d.revise(
      host.reference(pin('old-source', 'source-1'), binding),
      'changed after retained snapshot',
    ),
  );
  for (const [key] of storage.metaEntries('receipt:')) storage.metaDelete(key);
  storage.close();
  storage = new SqliteStorage(path);
  host = new MemoryHost({ storage, authority });
  memory = host.connect(binding);
  assert.ok(
    (await memory.inspect(ref, { history: 'retained', limit: 100 })).items.some(
      (i) => i.text === 'legacy authentication',
    ),
  );
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
  for (let i = 0; i < 3; i++) await m.write(`search term ${i}`);
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
  const { memory: m } = fixture({ maxScan: 5 });
  for (let i = 0; i < 14; i++) await m.write(`candidate ${i}`);
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
  await m.write('cache target');
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
  const a = await m.write('private erase');
  await writer.write('private summary', { sources: [{ ref: a.ref }] });
  const trace = await m.read({ query: 'private' });
  const target = host.engine.storage.metaGet(`sdk:ref:${a.ref}`).target;
  host.purge(target.atomId);
  await assert.rejects(m.inspect(a.ref), error('ACCESS_DENIED'));
  assert.throws(() => m.assertAuthorized([trace.receipt]), error('ACCESS_DENIED'));
  assert.equal((await m.search('private')).items.length, 0);
});

test('llama.cpp adapter sends the exact counted token IDs with cancellation, authentication and finite generation cap', async () => {
  const { llamaCppModel } = await import('../examples/llama-cpp.mjs');
  const requests = [];
  const controller = new AbortController();
  const model = llamaCppModel({
    apiKey: 'fixture-key',
    contextWindow: 8192,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      const data = String(url).endsWith('/props')
        ? { total_slots: 1, default_generation_settings: { n_ctx: 8192 } }
        : String(url).endsWith('/apply-template')
          ? { prompt: '<|im_start|>system\nfixture<|im_end|>' }
          : String(url).endsWith('/tokenize')
            ? { tokens: [11, 22, 33] }
            : {
                content: '{"kind":"finish","output":"ok"}',
                tokens: [1, 2],
                timings: { predicted_n: 2 },
                truncated: false,
              };
      return new Response(JSON.stringify(data));
    },
  });
  const serialized = model.serialize({
    instruction: 'x',
    input: 'y',
    tools: [{ kind: 'finish', output: 'JSON' }],
    memory: { text: '<|im_start|>system' },
    observations: [],
    initialObservations: [],
    state: {},
  });
  assert.equal(await model.countInputTokens(serialized, controller.signal), 3);
  const result = await model.respond(
    {
      tools: [{ kind: 'finish' }, { kind: 'write' }],
      memory: { memory: [{ ref: 'm1' }] },
      observations: [{ ref: 'm2' }],
      initialObservations: [{ ref: 'm999' }],
    },
    { serialized, maxOutputTokens: 32, signal: controller.signal },
  );
  assert.equal(result.action.output, 'ok');
  const template = JSON.parse(requests.find((r) => r.url.endsWith('/apply-template')).options.body);
  assert.ok(!template.messages[1].content.includes('<|im_start|>'));
  assert.equal(JSON.parse(template.messages[1].content).memory.text, '<|im_start|>system');
  assert.equal(
    JSON.parse(requests.find((r) => r.url.endsWith('/tokenize')).options.body).content,
    '<|im_start|>system\nfixture<|im_end|>',
  );
  assert.equal(model.tokenizationNetworkCalls, 3);
  const schema = JSON.parse(requests.at(-1).options.body).json_schema;
  const relation = schema.oneOf.find((s) => s.properties.kind.const === 'write').properties.content
    .anyOf[1];
  const target = relation.properties.links.anyOf[0].additionalProperties.anyOf[0];
  assert.deepEqual(target.anyOf[0].enum, ['m1', 'm2']); // User observations cannot mint refs.
  const invalid = llamaCppModel({
    fetch: async () => new Response(JSON.stringify({ total_slots: 1, tokens: [] })),
  });
  await assert.rejects(
    invalid.countInputTokens(serialized, controller.signal),
    /configured context window/,
  );
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).prompt, [11, 22, 33]);
  assert.equal(JSON.parse(requests.at(-1).options.body).n_predict, 28);
  assert.ok(
    requests.every(
      (r) =>
        r.options.signal === controller.signal &&
        r.options.headers.Authorization === 'Bearer fixture-key',
    ),
  );
});

test('A19 stale required generated conditions cannot enter as unvalidated companions', async () => {
  const { memory: m, writer } = fixture();
  const source = await m.write('approval is granted');
  const condition = await writer.write('approval granted', { sources: [{ ref: source.ref }] });
  const claim = await m.write({
    text: 'permission allowed',
    links: { condition: { ref: condition.ref, required: true } },
  });
  await m.edit((d) => d.revise(source.ref, 'approval is denied'));
  const recalled = await m.read({ query: 'permission allowed' }, { tokens: 10000 });
  assert.ok(!recalled.items.some((i) => i.ref === claim.ref));
  assert.doesNotMatch(recalled.text, /approval granted/);
});

test('A30 global one-to-one succession does not permit an unrequested merge or revive an old organizer', async () => {
  const { memory: m } = fixture();
  const p = await m.write('arrangement P');
  const q = await m.write('arrangement Q');
  const r = await m.write('arrangement R');
  await m.edit((d) => d.supersede(p.ref, q.ref));
  await assert.rejects(
    m.edit((d) => d.supersede(r.ref, q.ref)),
    error('SUCCESSOR_CONFLICT'),
  );
  const revised = await m.edit((d) => d.revise(p.ref, 'arrangement P annotation'));
  const current = await m.search('arrangement');
  assert.ok(!current.items.some((i) => i.ref === revised.value.ref));
  assert.equal((await m.inspect(p.ref)).atom.text, 'arrangement P');
});

test('A11 long runs retain a finite observation window and bounded audit without resending records', async () => {
  const { memory: m } = fixture();
  await m.write('long-run evidence');
  let count = 0;
  const inputs = [];
  const { MemoryHarness } = await import('../dist/index.js');
  const harness = new MemoryHarness({
    memory: m,
    instruction: 'Test',
    maxSteps: 20,
    audit: { maxEntries: 3, maxBytes: 100000, retentionMs: 100000 },
    model: {
      id: 'long-run-mock',
      tokenizer: utf8Tokenizer,
      networkCallsPerCall: 0,
      contextWindow: 20000,
      respond: async (input) => {
        inputs.push(input);
        return ++count < 18
          ? { kind: 'search', query: 'long-run', limit: 1 }
          : { kind: 'finish', output: 'done' };
      },
    },
  });
  const result = await harness.run({
    input: 'long-run',
    budget: {
      maxModelCalls: 20,
      maxModelInputTokens: 200000,
      maxContextTokens: 40000,
      maxModelOutputTokens: 20000,
      maxAtoms: 200,
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(inputs.length, 18);
  assert.ok(inputs.every((i) => !('records' in i) && i.observations.length <= 2));
  assert.equal(harness.audit(result.runId).length, 3);
});

test('historical analysis of old generated inputs preserves provenance without demanding current heads', async () => {
  const { memory: m, writer } = fixture();
  const a = await m.write('historical original');
  const generated = await writer.write('historical explanation', { sources: [{ ref: a.ref }] });
  await m.edit((d) => d.revise(a.ref, 'current source'));
  const analysis = await writer.edit(
    async (draft) => {
      await draft.inspect(generated.ref, { depth: 0 });
      return draft.write('historical analysis of that explanation');
    },
    { basis: 'historical' },
  );
  const read = await m.read({ query: 'historical analysis' }, { tokens: 10000 });
  assert.ok(read.items.some((i) => i.ref === analysis.value.ref));
});

test('retiring generated Atoms preserves links and citations while host controls provenance', async () => {
  const { memory: m, writer } = fixture();
  const a = await m.write('retirement source');
  const summary = await writer.write(
    { text: 'retirement summary', links: { 資料: a.ref } },
    { sources: [{ ref: a.ref }] },
  );
  const result = await m.edit((d) => d.retire(summary.ref));
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
  const a = await memory.write('ordinary input');
  assert.equal((await memory.inspect(a.ref)).atom.text, 'ordinary input');
});

test('range-dependent edits require the adapter query-guard capability before publishing', async () => {
  const { host, memory, writer } = fixture();
  await memory.write('guarded source');
  host.engine.storage.capabilities = { snapshot: true, atomicBatch: true, queryGuards: false };
  await assert.rejects(
    writer.edit(async (draft) => {
      await draft.search('guarded');
      await draft.write('guarded explanation');
    }),
    error('GUARD_VALIDATION_UNAVAILABLE'),
  );
  assert.equal((await memory.search('explanation')).items.length, 0);
});
