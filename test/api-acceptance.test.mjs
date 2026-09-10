import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { content, pin, utf8Tokenizer, MemoryHarness, BudgetLedger } from '../dist/index.js';
const error = (code) => (e) => e.code === code;
const opts = { tokens: 30000, budget: { maxContextTokens: 30000 } };
const mock = (respond, extra = {}) => ({
  id: 'deterministic-test',
  tokenizer: utf8Tokenizer,
  contextWindow: 100000,
  networkCallsPerCall: 0,
  respond,
  ...extra,
});

test('A05/A06 schema-independent directions, three-way relations and repeated roles', async () => {
  const { memory: m, host, binding } = fixture();
  const a = await m.write('資料A');
  const b = await m.write('補足B');
  const c = await m.write('理由C');
  const relation = await m.write({
    text: '任意の関係',
    links: [
      { role: '資料', target: a.ref },
      { role: '補足', target: b.ref },
      { role: '理由', target: c.ref },
      { role: '資料', target: a.ref },
    ],
  });
  const detail = await m.inspect(relation.ref, { depth: 0 });
  assert.deepEqual(
    detail.atom.links.map((l) => l.role),
    ['資料', '補足', '理由', '資料'],
  );
  assert.equal(detail.atom.links[0].ref, detail.atom.links[3].ref);
  assert.ok((await m.inspect(a.ref)).items.some((i) => i.ref === relation.ref));
  const left = await m.write({ text: 'route', links: { from: a.ref, to: b.ref } });
  const right = await m.write({ text: 'route', links: { from: b.ref, to: a.ref } });
  assert.notDeepEqual(left.links, right.links);
  await host.engine.kernel.write(
    {
      idempotencyKey: 'migration-unknown',
      guards: [],
      revisions: [
        {
          atomId: 'z-custom',
          revisionId: 'custom-1',
          expectedHead: null,
          content: content('unseen-format', '未知形式の認証', 'p', {
            slots: [{ role: '説明', mode: 'refer', target: pin('z-custom', 'custom-1') }],
          }),
        },
      ],
    },
    binding.auth,
  );
  assert.ok((await m.search('未知形式')).items.length);
  assert.ok((await m.inspect(host.reference(pin('z-custom', 'custom-1'), binding))).items.length);
});

test('A07/A09 rank the whole allowed scope before limit; non-tied ranks ignore IDs', async () => {
  async function ranking(reverse) {
    const { host, binding, memory: m } = fixture();
    for (let i = 0; i < 60; i++) await m.write('無関係な天気');
    await host.engine.kernel.write(
      {
        idempotencyKey: 'seed',
        guards: [],
        revisions: [
          {
            atomId: reverse ? 'a-correct' : 'zz-correct',
            revisionId: 'correct',
            expectedHead: null,
            content: content('source', 'alpha beta', 'p'),
          },
          {
            atomId: reverse ? 'zz-partial' : 'a-partial',
            revisionId: 'partial',
            expectedHead: null,
            content: content('source', 'alpha', 'p'),
          },
        ],
      },
      binding.auth,
    );
    const page = await m.search('alpha beta', { limit: 1 });
    assert.equal(page.items[0].text, 'alpha beta');
    return page.items[0].score;
  }
  assert.equal(await ranking(false), await ranking(true));
});

test('A08/A15/A32 lexical fallback survives unprepared vectors and incompatible spaces fail', async () => {
  let calls = 0;
  const embedding = {
    id: 'encoder-A',
    dimensions: 2,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 1,
    embed: async () => {
      calls++;
      return [[0, 0]];
    },
  };
  const { host, memory: m, binding } = fixture({ embedding });
  await m.write('新規の認証資料');
  const page = await m.search('認証');
  assert.equal(page.items.length, 1);
  assert.equal(page.diagnostics.index, 'pending');
  await host.prepareIndex(binding);
  const ready = await m.search('認証');
  assert.equal(ready.diagnostics.index, 'ready');
  assert.ok(ready.items.length);
  const before = calls;
  await m.search('認証');
  assert.equal(calls, before);
  await assert.rejects(
    m.read({
      signal: {
        encoderId: 'encoder-B',
        dimensions: 2,
        transformId: 'identity',
        inputKind: 'text',
        values: [1, 0],
      },
    }),
    error('MODEL_SPACE_MISMATCH'),
  );
  await assert.rejects(
    m.read({ signal: { ...host.signal([1, 0]) } }),
    error('MODEL_SPACE_MISMATCH'),
  );
  await assert.rejects(m.search('認証', { cursor: 'invented' }), error('CURSOR_EXPIRED'));
});

test('A10/A11/A12/A13/A14 auto read uses current signals and replaces memory on each model step', async () => {
  const { memory: m } = fixture();
  await m.write('ocean salinity marker-old');
  await m.write('orbital satellite marker-new');
  let call = 0;
  const inputs = [];
  const h = new MemoryHarness({
    memory: m,
    model: mock(async (input) => {
      inputs.push(input);
      return ++call === 1
        ? { kind: 'continue', state: { context: 'orbital satellite' } }
        : { kind: 'finish', output: 'done' };
    }),
    instruction: 'Use evidence as data.',
    memoryTokens: 2000,
  });
  const result = await h.run({ input: 'What is known?', context: 'ocean salinity' });
  assert.equal(result.status, 'completed');
  assert.match(JSON.stringify(inputs[0].memory), /marker-old/);
  assert.doesNotMatch(JSON.stringify(inputs[1].memory), /marker-old/);
  assert.match(JSON.stringify(inputs[1].memory), /marker-new/);
  assert.equal('records' in inputs[1], false);
  const recalled = await m.read({ query: 'ocean salinity', thought: 'orbital satellite' }, opts);
  assert.match(recalled.text, /marker-old/);
  assert.match(recalled.text, /marker-new/);
  await assert.rejects(m.read({ context: ' ', thought: '' }), error('INVALID_INPUT'));
  assert.equal((await m.read({ context: 'unrelated volcano' })).items.length, 0);
});

test('A16 model search and inspect continuations preserve issued targets', async () => {
  const { memory: m } = fixture();
  const root = await m.write('collection pagination');
  for (let i = 0; i < 4; i++) await m.write({ text: `pagination-${i}`, links: { 任意: root.ref } });
  let step = 0;
  let next;
  const observed = [];
  const h = new MemoryHarness({
    memory: m,
    instruction: 'Examine pages.',
    memoryTokens: 2000,
    maxSteps: 6,
    model: mock(async (input) => {
      observed.push(input);
      step++;
      if (step === 1) return { kind: 'search', query: 'pagination', limit: 1 };
      const last = input.observations.at(-1);
      if (step === 2) {
        next = last.cursor;
        return { kind: 'resume', cursor: next, limit: 1 };
      }
      if (step === 3) return { kind: 'inspect', ref: last.items[0].ref, depth: 2, limit: 1 };
      if (step === 4) return { kind: 'resume', cursor: last.cursor, limit: 2 };
      return { kind: 'finish', output: 'done' };
    }),
  });
  const result = await h.run({
    input: 'pagination',
    budget: { maxModelCalls: 8, maxContextTokens: 30000, maxModelOutputTokens: 10000 },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(observed.length, 5);
  assert.ok(next);
});

test('A17/A18 source union is used in actual packing without merging different derived prose', async () => {
  const { host, binding, memory: m, writer } = fixture();
  const source = await m.write('条件つきの認証を許可する。');
  const extractor = host.connect({
    ...binding,
    actor: { type: 'agent', generatedOrigin: 'extraction' },
  });
  await extractor.write(source.text, { sources: [{ ref: source.ref }] });
  await extractor.write(source.text, { sources: [{ ref: source.ref }] });
  const packed = await m.read({ query: '認証' }, opts);
  // Distinct quotation Atoms keep their identities; only serialized evidence is shared.
  assert.equal(packed.items.filter((i) => i.text === source.text).length, 3);
  assert.equal((packed.text.match(/条件つきの認証を許可する。/g) ?? []).length, 1);
  assert.equal(packed.sources.length, 1);
  await writer.write('認証は承認を得た場合だけ許可する', { sources: [{ ref: source.ref }] });
  await writer.write('認証はテスト環境に限って許可する', { sources: [{ ref: source.ref }] });
  const distinct = await m.read({ query: '認証' }, opts);
  assert.match(distinct.text, /承認を得た場合/);
  assert.match(distinct.text, /テスト環境に限って/);
  assert.equal(distinct.sources.length, 1);
  const other = await m.write(source.text);
  const two = await m.read({ query: '認証' }, opts);
  assert.ok(two.sources.some((s) => s.ref === other.ref));
  assert.equal(two.sources.length, 2);
});

test('A19 required conditions are actual text or the entire claim is omitted', async () => {
  const { memory: m } = fixture();
  const condition = await m.write('ただし管理者が承認した場合だけ。');
  const claim = await m.write({
    text: '認証を許可する',
    links: { 条件: { ref: condition.ref, required: true } },
  });
  const full = await m.read({ query: '認証' }, opts);
  assert.match(full.text, /管理者が承認/);
  assert.ok(full.items.some((i) => i.ref === claim.ref));
  const small = await m.read({ query: '認証' }, { tokens: 100 });
  assert.ok(!small.items.some((i) => i.ref === claim.ref));
  assert.equal(small.text, '');
  assert.ok(small.diagnostics.minimumTokens > 100);
  const larger = await m.read({ query: '認証' }, { ...opts, cursor: small.cursor });
  assert.match(larger.text, /管理者が承認/);
});

test('A20 cyclic, high-degree relations are bounded and all remaining edges can resume', async () => {
  const { memory: m } = fixture();
  const a = await m.write('cycleA');
  const b = await m.write({ text: 'cycleB', links: { next: a.ref } });
  const revised = await m.edit((d) => d.revise(a.ref, { text: 'cycleA', links: { next: b.ref } }));
  for (let i = 0; i < 35; i++) await m.write({ text: `edge ${i}`, links: { 資料: a.ref } });
  let page = await m.inspect(revised.value.ref, { depth: 2, limit: 3 });
  const refs = new Set(page.items.map((i) => i.ref));
  let pages = 1;
  while (page.cursor) {
    assert.ok(pages++ < 100);
    page = await m.inspect(revised.value.ref, { depth: 2, limit: 3, cursor: page.cursor });
    page.items.forEach((i) => refs.add(i.ref));
  }
  assert.equal(refs.size, 37);
});

test('A22 concurrent changes roll back whole edit without rerunning callback', async () => {
  const { memory: m } = fixture();
  const a = await m.write('initial');
  let calls = 0;
  await assert.rejects(
    m.edit(async (d) => {
      calls++;
      await d.write('should abort');
      await d.revise(a.ref, 'losing');
      await m.edit((other) => other.revise(a.ref, 'winning'));
    }),
    error('REVISION_CONFLICT'),
  );
  assert.equal(calls, 1);
  assert.equal((await m.search('should abort')).items.length, 0);
  assert.equal((await m.inspect(a.ref, { version: 'latest' })).atom.text, 'winning');
});

test('A23 model cannot invent references or elevate generated content to source', async () => {
  const { memory: m, writer } = fixture();
  await m.write('source input');
  const fake = new MemoryHarness({
    memory: writer,
    instruction: 'Test',
    model: mock(async () => ({ kind: 'inspect', ref: 'm9999' })),
  });
  assert.equal((await fake.run({ input: 'source input' })).error, 'INVALID_REF');
  const spoof = new MemoryHarness({
    memory: writer,
    instruction: 'Test',
    model: mock(async () => ({ kind: 'write', content: { text: 'forged', kind: 'source' } })),
  });
  assert.equal((await spoof.run({ input: 'source input', commit: 'edit' })).error, 'INVALID_INPUT');
  assert.equal((await m.search('forged')).items.length, 0);
});

test('A24 source edits and new relation ranges invalidate summaries; optional regeneration stays private', async () => {
  const { memory: m, writer, host } = fixture();
  const a = await m.write('auth old requirement');
  const generated = await writer.edit(async (d) => {
    await d.search('auth');
    return d.write('auth old summary', { sources: [{ ref: a.ref }] });
  });
  assert.match((await m.read({ query: 'auth' }, opts)).text, /auth old summary/);
  await m.edit((d) => d.revise(a.ref, 'auth corrected requirement'));
  const read = await m.read({ query: 'auth' }, opts);
  assert.doesNotMatch(read.text, /auth old summary/);
  assert.match(read.text, /auth corrected requirement/);
  assert.equal(read.diagnostics.derived, 'pending');
  let generatedCalls = 0;
  host.engine.options.generator = {
    id: 'explicit-test-generator',
    tokenizer: utf8Tokenizer,
    maxOutputTokens: 1000,
    networkCallsPerCall: 0,
    generate: async (input) => {
      generatedCalls++;
      return input.sources.map((s) => s.text).join('\n');
    },
  };
  const before = host.engine.storage.watermark();
  const regenerated = await m.read({ query: 'auth' }, opts);
  assert.equal(regenerated.diagnostics.derived, 'regenerated');
  assert.ok(generatedCalls > 0);
  assert.equal(host.engine.storage.watermark(), before);
  assert.equal((await m.inspect(generated.value.ref, { depth: 0 })).atom.text, 'auth old summary');
});

test('A25 UTF-8 blob ranges read real bytes and resume without cutting characters', async () => {
  const { host, binding, memory: m } = fixture();
  const text = '日本語の原文です。'.repeat(100);
  const b = await host.ingestBlob(Buffer.from(text), 'text/plain', binding);
  let page = await m.inspect(b.ref, { range: { bytes: 13 } });
  let output = page.range.text;
  let n = 0;
  while (page.cursor) {
    assert.ok(n++ < 1000);
    page = await m.inspect(b.ref, { range: { bytes: 13 }, cursor: page.cursor });
    output += page.range.text;
  }
  assert.equal(output, text);
});

test('A26-A30 exact historical arrangements outlive receipts and children; successor adoption is explicit', async () => {
  const { memory: m, host } = fixture();
  const p = await m.write('parent old arrangement');
  const child = await m.write('child old');
  const link = await m.write({ text: 'belongs', links: { 資料: p.ref, 補足: child.ref } });
  const q = await m.write('parent new arrangement');
  assert.ok((await m.search('parent')).items.some((i) => i.ref === p.ref));
  await m.write({ text: 'replace old with new', links: { previous: p.ref, successor: q.ref } });
  assert.ok((await m.search('parent')).items.some((i) => i.ref === p.ref));
  await m.edit((d) =>
    d.supersede(p.ref, q.ref, {
      composition: { relations: [{ parent: '資料', children: ['補足'] }] },
    }),
  );
  const current = await m.search('parent');
  assert.ok(current.items.some((i) => i.ref === q.ref));
  assert.ok(!current.items.some((i) => i.ref === p.ref));
  await m.edit(async (d) => {
    await d.revise(child.ref, 'child corrected');
    await d.retire(link.ref);
  });
  for (const [key] of host.engine.storage.metaEntries('receipt:'))
    host.engine.storage.metaDelete(key);
  const old = await m.inspect(p.ref, { history: 'retained', limit: 100 });
  assert.ok(old.history);
  assert.ok(old.items.some((i) => i.text === 'child old'));
  assert.ok(old.items.some((i) => i.text === 'belongs'));
  assert.equal(old.atom.ref, p.ref);
  await assert.rejects(
    m.edit((d) => d.supersede(p.ref, q.ref)),
    error('SUCCESSOR_CONFLICT'),
  );
});

test('A30 successor cycles and multiple choices roll back, incomplete capture cannot adopt', async () => {
  const { memory: m } = fixture();
  const p = await m.write('P');
  const q = await m.write('Q');
  const r = await m.write('R');
  await assert.rejects(
    m.edit(async (d) => {
      await d.supersede(p.ref, q.ref);
      await d.supersede(p.ref, r.ref);
    }),
    error('SUCCESSOR_CONFLICT'),
  );
  await assert.rejects(
    m.edit(async (d) => {
      await d.supersede(p.ref, q.ref);
      await d.supersede(q.ref, p.ref);
    }),
    error('SUCCESSOR_CYCLE'),
  );
  const small = fixture({ historyMaxAtoms: 1 });
  // Exercise a backend with snapshot reads but without a durable retention contract.
  small.host.engine.storage.retainSnapshot = undefined;
  const a = await small.memory.write('A');
  const b = await small.memory.write('B');
  await small.memory.write({ text: 'relation', links: { a: a.ref } });
  await assert.rejects(
    small.memory.edit((d) =>
      d.supersede(a.ref, b.ref, {
        composition: { relations: [{ parent: 'a', children: ['member'] }] },
      }),
    ),
    error('HISTORY_INCOMPLETE'),
  );
  assert.equal((await small.memory.inspect(a.ref, { successor: true })).atom.ref, a.ref);
});

test('A31/A32 permission revocation invalidates refs, pages, cached retrieval and working state', async () => {
  const { memory: m, authority, auth } = fixture();
  const a = await m.write('private fact');
  await m.write('private second');
  const page = await m.search('private', { limit: 1 });
  let calls = 0;
  const h = new MemoryHarness({
    memory: m,
    instruction: 'Test',
    model: mock(async () => {
      calls++;
      authority.revoke(auth);
      return { kind: 'continue', state: { context: 'private fact' } };
    }),
  });
  const result = await h.run({ input: 'private' });
  assert.equal(result.error, 'ACCESS_DENIED');
  assert.equal(calls, 1);
  await assert.rejects(m.inspect(a.ref), error('ACCESS_DENIED'));
  await assert.rejects(m.search('private', { cursor: page.cursor }), error('ACCESS_DENIED'));
  assert.throws(() => h.audit(result.runId), error('ACCESS_DENIED'));
});

test('A33/A34 full serialized input and all calls use one shared run budget', async () => {
  const { memory: m } = fixture();
  await m.write('budget evidence');
  let calls = 0;
  const tiny = new MemoryHarness({
    memory: m,
    instruction: 'x'.repeat(5000),
    model: mock(
      async () => {
        calls++;
        return { kind: 'finish', output: 'x' };
      },
      { contextWindow: 1000 },
    ),
  });
  assert.equal((await tiny.run({ input: 'budget' })).error, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(calls, 0);
  const bounded = new MemoryHarness({
    memory: m,
    instruction: 'Test',
    model: mock(async () => {
      calls++;
      return { kind: 'search', query: 'budget' };
    }),
    memoryTokens: 1000,
    maxSteps: 20,
  });
  const r = await bounded.run({
    input: 'budget',
    budget: { maxModelCalls: 2, maxModelOutputTokens: 5000, maxContextTokens: 10000 },
  });
  assert.equal(r.status, 'budget-exhausted');
  assert.equal(r.usage.maxModelCalls, 2);
  assert.equal(calls, 2);
  const controller = new AbortController();
  const aborted = new MemoryHarness({
    memory: m,
    instruction: 'Test',
    model: mock(
      async (_input, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'finish', output: 'cancelled' }));
          controller.abort();
        }),
    ),
  });
  assert.equal(
    (await aborted.run({ input: 'budget', signal: controller.signal })).error,
    'ABORTED',
  );
});

test('A24 a new arbitrary relation invalidates a prior range-dependent explanation', async () => {
  const { memory: m, writer } = fixture();
  const p = await m.write('catalog group');
  const summary = await writer.edit(async (d) => {
    await d.inspect(p.ref, { depth: 1 });
    return d.write('catalog has no member');
  });
  assert.match((await m.read({ query: 'catalog' }, opts)).text, /catalog has no member/);
  await m.write({ text: 'new membership', links: { 資料: p.ref } });
  const read = await m.read({ query: 'catalog' }, opts);
  assert.doesNotMatch(read.text, /catalog has no member/);
  assert.equal(read.diagnostics.derived, 'pending');
  assert.equal(
    (await m.inspect(summary.value.ref, { depth: 0 })).atom.text,
    'catalog has no member',
  );
});

test('A22 inserted relations during a draft fail current range validation', async () => {
  const { memory: m, writer } = fixture();
  const p = await m.write('root');
  let runs = 0;
  await assert.rejects(
    writer.edit(async (d) => {
      runs++;
      await d.inspect(p.ref);
      await d.write('absence summary');
      await m.write({ text: 'inserted', links: { 対象: p.ref } });
    }),
    error('REVISION_CONFLICT'),
  );
  assert.equal(runs, 1);
  assert.equal((await m.search('absence')).items.length, 0);
});

test('A36 complete source, Writer, question, correction, reread and old arrangement example', async () => {
  const { writerScenario } = await import('../examples/writer.mjs');
  const result = await writerScenario();
  assert.equal(result.writerRun.status, 'completed');
  assert.match(result.reread.text, /利用できない/);
  assert.ok(result.history.items.some((i) => i.text === result.source.text));
});
