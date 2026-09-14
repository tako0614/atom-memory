import { LexicalCandidateProvider } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryStorage, utf8Tokenizer } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture, create, revise, retire } from './fixtures.mjs';

const readOptions = { tokens: 30000, limit: 100, depth: 0 };
for (const adapter of ['memory', 'sqlite']) {
  function setup(t, options = {}) {
    const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    t.after(() => storage.close());
    return fixture({ storage, ...options });
  }
  test(`${adapter}: R2 overlapping quotations share the actual context evidence text`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const source = await create(m, 'AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await create(extractor, 'AAAABBBB', {
      sources: [{ ref: source.ref, start: 0, end: 8 }],
    });
    const b = await create(extractor, 'BBBBCCCC', {
      sources: [{ ref: source.ref, start: 4, end: 12 }],
    });
    const result = await m.read({ query: 'BBBB' }, readOptions);
    assert.equal((result.text.match(/BBBB/g) ?? []).length, 1, result.text);
    assert.ok(result.refs.includes(a.ref));
    assert.ok(result.refs.includes(b.ref));
    assert.equal((await m.inspect(a.ref)).atom.text, 'AAAABBBB');
    assert.equal((await m.inspect(b.ref)).atom.text, 'BBBBCCCC');
    assert.equal(result.tokenCount, utf8Tokenizer.count(result.text));
  });
  test(`${adapter}: R2 containment keeps each Atom and recall packs shared evidence once`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const source = await create(m, 'AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const whole = await create(extractor, source.text, { sources: [{ ref: source.ref }] });
    const inside = await create(extractor, 'BBBB', {
      sources: [{ ref: source.ref, start: 4, end: 8 }],
    });
    const result = await m.read({ query: 'BBBB' }, readOptions);
    const context = JSON.parse(result.text);
    assert.deepEqual(context.memory.find((v) => v.ref === inside.ref).quote, {
      ref: source.ref,
      start: 4,
      end: 8,
      unit: 'utf8',
    });
    assert.ok(context.memory.some((v) => v.ref === whole.ref));
    assert.equal(context.evidence[0].ranges[0].text, source.text);
    assert.equal((result.text.match(/BBBB/g) ?? []).length, 1);
    assert.ok(context.memory.every((v) => !('text' in v)));
  });
  test(`${adapter}: R2 Japanese disjoint ranges expose omissions and preserve repeated source positions`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const left = '認証は許可しない。';
    const omitted = 'ここは省略する長い背景説明です。';
    const right = '認証は管理者に確認。';
    const source = await create(m, left + omitted + right);
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await create(extractor, left, {
      sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(left) }],
    });
    const overlap = await create(extractor, left.slice(0, -1), {
      sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(left.slice(0, -1)) }],
    });
    const start = Buffer.byteLength(left + omitted);
    const other = await create(extractor, right, {
      sources: [{ ref: source.ref, start, end: start + Buffer.byteLength(right) }],
    });
    await create(m, {
      text: 'range_fixture',
      links: { when: [a.ref, overlap.ref, other.ref].map((ref) => ({ ref, required: true })) },
    });
    const result = await m.read({ query: 'range_fixture' }, { ...readOptions, depth: 0, limit: 4 });
    const ranges = JSON.parse(result.text).evidence[0].ranges;
    assert.deepEqual(
      ranges.map((r) => r.text),
      [left, right],
    );
    assert.deepEqual(ranges[1].omittedBefore, { start: Buffer.byteLength(left), end: start });
    assert.equal((result.text.match(/認証/g) ?? []).length, 2);
    assert.doesNotMatch(result.text, /�/);
    assert.equal((await m.inspect(a.ref)).atom.text, left);
  });
  test(`${adapter}: R2 equal text from distinct sources and revisions stays distinct`, async (t) => {
    const { memory: m, host, binding, authority } = setup(t);
    const auth = authority.issue({
      subject: 'other-speaker',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const other = host.connect({ ...binding, auth });
    const first = await create(m, 'AAAABBBBCCCC');
    const second = await create(other, 'AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const input = host.observe(
      {
        sources: [{ ref: first.ref }],
        basis: 'historical',
        payloadDigest: createHash('sha256').update(first.text).digest('hex'),
      },
      { ...binding, actor: { type: 'agent', generatedOrigin: 'extraction' } },
    );
    await create(extractor, first.text, { input, sources: [{ ref: first.ref }] });
    await revise(m, first.ref, 'AAAABBBBCCCC revised version');
    const result = await m.read({ query: 'BBBB' }, readOptions);
    const contexts = JSON.parse(result.text);
    assert.equal((result.text.match(/BBBB/g) ?? []).length, 3);
    assert.equal(new Set(result.sources.map((s) => s.ref)).size, 3);
    assert.ok(contexts.memory.some((v) => v.provenance.producer === 'other-speaker'));
    assert.equal((await other.inspect(second.ref)).atom.text, second.text);
  });
  test(`${adapter}: R2 summaries with the same origins are not treated as verbatim equivalents`, async (t) => {
    const { memory: m, writer } = setup(t);
    const source = await create(m, '認証には条件がある。');
    const a = await create(writer, '認証は管理者が承認した場合だけ許可。', {
      sources: [{ ref: source.ref }],
    });
    const b = await create(writer, '認証は検証環境でだけ許可。', {
      sources: [{ ref: source.ref }],
    });
    const result = JSON.parse((await m.read({ query: '認証' }, readOptions)).text);
    for (const v of [a, b]) {
      assert.equal(result.memory.find((x) => x.ref === v.ref).text, v.text);
      assert.ok(!result.memory.find((x) => x.ref === v.ref).quote);
    }
  });
  test(`${adapter}: R2 required conditions are included in the final text or the complete claim is omitted`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const condition = await create(m, 'ただし管理者が承認した場合だけ。'.repeat(30));
    const source = await create(m, '認証を許可する。ただし管理者が承認した場合だけ。');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const claimText = '認証を許可する。';
    const claim = await create(
      extractor,
      { text: claimText, links: { 条件: { ref: condition.ref, required: true } } },
      {
        sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(claimText) }],
      },
    );
    await create(extractor, claimText, {
      sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(claimText) }],
    });
    for (const tokens of [500, 1000, 15000]) {
      const result = await m.read({ query: '認証' }, { ...readOptions, tokens });
      assert.ok(result.tokenCount <= tokens);
      assert.equal(result.tokenCount, utf8Tokenizer.count(result.text));
      if (result.refs.includes(claim.ref)) assert.ok(result.text.includes(condition.text));
    }
    assert.equal((await m.inspect(claim.ref)).atom.text, claimText);
  });
}
