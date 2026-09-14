import { content } from '../dist/core/helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, create, revise, retire } from './fixtures.mjs';
import { pin, utf8Tokenizer, BudgetLedger } from '../dist/index.js';
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
  const a = await create(m, '資料A');
  const b = await create(m, '補足B');
  const c = await create(m, '理由C');
  const relation = await create(m, {
    text: '任意の関係',
    links: [
      { role: '資料', target: a.ref },
      { role: '補足', target: b.ref },
      { role: '理由', target: c.ref },
      { role: '資料', target: a.ref },
    ],
  });
  const detail = await m.inspect(relation.ref, {});
  assert.deepEqual(
    detail.atom.links.map((l) => l.role),
    ['資料', '補足', '理由', '資料'],
  );
  assert.equal(detail.atom.links[0].ref, detail.atom.links[3].ref);
  assert.ok((await m.inspect(a.ref)).neighbors.some((i) => i.atom.ref === relation.ref));
  const left = await create(m, { text: 'route', links: { from: a.ref, to: b.ref } });
  const right = await create(m, { text: 'route', links: { from: b.ref, to: a.ref } });
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
  assert.ok(
    (await m.inspect(host.reference(pin('z-custom', 'custom-1'), binding))).neighbors.length,
  );
});

test('A07/A09 rank the whole allowed scope before limit; non-tied ranks ignore IDs', async () => {
  async function ranking(reverse) {
    const { host, binding, memory: m } = fixture();
    for (let i = 0; i < 60; i++) await create(m, '無関係な天気');
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
  await create(m, '新規の認証資料');
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

test('A17/A18 source union is used in actual packing without merging different derived prose', async () => {
  const { host, binding, memory: m, writer } = fixture();
  const source = await create(m, '条件つきの認証を許可する。');
  const extractor = host.connect({
    ...binding,
    actor: { type: 'agent', generatedOrigin: 'extraction' },
  });
  await create(extractor, source.text, { sources: [{ ref: source.ref }] });
  await create(extractor, source.text, { sources: [{ ref: source.ref }] });
  const packed = await m.read({ query: '認証' }, opts);
  // Distinct quotation Atoms keep their identities; only serialized evidence is shared.
  assert.equal(packed.items.filter((i) => i.text === source.text).length, 2); // one exact quote class plus source; equal U uses less metadata.
  assert.equal((await m.search('認証', opts)).items.length, 3, 'stored identities remain distinct');
  assert.equal((packed.text.match(/条件つきの認証を許可する。/g) ?? []).length, 1);
  assert.equal(packed.sources.length, 1);
  await create(writer, '認証は承認を得た場合だけ許可する', { sources: [{ ref: source.ref }] });
  await create(writer, '認証はテスト環境に限って許可する', { sources: [{ ref: source.ref }] });
  const distinct = await m.read({ query: '認証' }, opts);
  assert.match(distinct.text, /承認を得た場合/);
  assert.match(distinct.text, /テスト環境に限って/);
  assert.equal(distinct.sources.length, 1);
  const other = await create(m, source.text);
  const two = await m.read({ query: '認証' }, opts);
  assert.ok(two.sources.some((s) => s.ref === other.ref));
  assert.equal(two.sources.length, 2);
});

test('A19 required conditions are actual text or the entire claim is omitted', async () => {
  const { memory: m } = fixture();
  const condition = await create(m, 'ただし管理者が承認した場合だけ。');
  const claim = await create(m, {
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
  const a = await create(m, 'cycleA');
  const b = await create(m, { text: 'cycleB', links: { next: a.ref } });
  const revised = await revise(m, a.ref, { text: 'cycleA', links: { next: b.ref } });
  for (let i = 0; i < 35; i++) await create(m, { text: `edge ${i}`, links: { 資料: a.ref } });
  let page = await m.inspect(revised.value.ref, { limit: 3 });
  const refs = new Set(page.neighbors.map((i) => i.atom.ref));
  let pages = 1;
  while (page.cursor) {
    assert.ok(pages++ < 100);
    page = await m.inspect(revised.value.ref, { limit: 3, cursor: page.cursor });
    page.neighbors.forEach((i) => refs.add(i.atom.ref));
  }
  assert.equal(refs.size, 36);
});

test('A22 stale CAS rolls back every declarative change', async () => {
  const { memory: m } = fixture();
  const a = await create(m, 'initial');
  await revise(m, a.ref, 'winning');
  await assert.rejects(
    m.write({
      changes: [
        {
          id: 'aborted-create',
          op: 'create',
          content: { text: 'should abort', links: [] },
          sources: [],
        },
        {
          id: 'stale-revise',
          op: 'revise',
          target: a.ref,
          content: { text: 'losing', links: [] },
          sources: [],
        },
      ],
    }),
    error('REVISION_CONFLICT'),
  );
  assert.equal((await m.search('should abort')).items.length, 0);
  assert.equal((await m.inspect(a.ref, { version: 'latest' })).atom.text, 'winning');
});

test('A24 source edits exclude stale summaries and report them for explicit refresh', async () => {
  const { memory: m, writer, host, binding } = fixture();
  const a = await create(m, 'auth old requirement');
  const presentation = await writer.search('auth');
  const input = host.observe(
    { presentations: [{ receipt: presentation.receipt }], payloadDigest: 'b'.repeat(64) },
    { ...binding, actor: { type: 'agent' } },
  );
  const generated = await create(writer, 'auth old summary', {
    sources: [{ ref: a.ref }],
    input,
  });
  assert.match((await m.read({ query: 'auth' }, opts)).text, /auth old summary/);
  await revise(m, a.ref, 'auth corrected requirement');
  const read = await m.read({ query: 'auth' }, opts);
  assert.doesNotMatch(read.text, /auth old summary/);
  assert.match(read.text, /auth corrected requirement/);
  assert.equal(read.diagnostics.derived, 'pending');
  assert.ok(read.stale.includes(generated.ref));
  const before = host.engine.storage.watermark();
  await m.read({ query: 'auth' }, opts);
  assert.equal(host.engine.storage.watermark(), before);
  assert.equal((await m.inspect(generated.ref, {})).atom.text, 'auth old summary');
});

test('A25 UTF-8 blob ranges read real bytes and resume without cutting characters', async () => {
  const { host, binding, memory: m } = fixture();
  const text = '日本語の原文です。'.repeat(100);
  const b = (await host.ingestBlob(Buffer.from(text), 'text/plain', binding)).changes.source;
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

test('A24 a new arbitrary relation invalidates a prior range-dependent explanation', async () => {
  const { memory: m, writer, host, binding } = fixture();
  const p = await create(m, 'catalog group');
  const inspected = await writer.inspect(p.ref);
  const input = host.observe(
    { presentations: [{ receipt: inspected.receipt }], payloadDigest: 'c'.repeat(64) },
    { ...binding, actor: { type: 'agent' } },
  );
  const summary = await create(writer, 'catalog has no member', { input });
  assert.match((await m.read({ query: 'catalog' }, opts)).text, /catalog has no member/);
  await create(m, { text: 'new membership', links: { 資料: p.ref } });
  const read = await m.read({ query: 'catalog' }, opts);
  assert.doesNotMatch(read.text, /catalog has no member/);
  assert.equal(read.diagnostics.derived, 'pending');
  assert.equal((await m.inspect(summary.ref, {})).atom.text, 'catalog has no member');
});

test('A22 inserted relations after observation fail current range validation', async () => {
  const { memory: m, writer, host, binding } = fixture();
  const p = await create(m, 'root');
  const inspected = await writer.inspect(p.ref);
  const input = host.observe(
    { presentations: [{ receipt: inspected.receipt }], payloadDigest: 'd'.repeat(64) },
    { ...binding, actor: { type: 'agent' } },
  );
  await create(m, { text: 'inserted', links: { 対象: p.ref } });
  await assert.rejects(create(writer, 'absence summary', { input }), error('REVISION_CONFLICT'));
  assert.equal((await m.search('absence')).items.length, 0);
});
