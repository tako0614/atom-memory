import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, MemoryHarness, utf8Tokenizer } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';

const readOptions = { tokens: 30000, limit: 100, depth: 0 };
const composition = { relations: [{ parent: '資料', children: ['補足'] }] };
const generator = (calls) => ({
  id: 'record-current-inputs',
  tokenizer: utf8Tokenizer,
  maxOutputTokens: 1000,
  networkCallsPerCall: 0,
  generate: async (input) => {
    calls.push(structuredClone(input));
    return 'Regenerated from the recorded inputs.';
  },
});

for (const adapter of ['memory', 'sqlite']) {
  function setup(t, options = {}) {
    const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    t.after(() => storage.close());
    return fixture({ storage, ...options });
  }
  test(`${adapter}: R1 newly attached member reaches the real regeneration input`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    const a = await m.write('A initial member');
    const b = await m.write('B initial member');
    await m.write({ text: 'P contains A', links: { 資料: p.ref, 補足: a.ref } });
    await m.write({ text: 'P contains B', links: { 資料: p.ref, 補足: b.ref } });
    await writer.edit(async (d) => {
      await d.inspect(p.ref, { depth: 2, version: 'latest', limit: 100 });
      await d.write('summarymarker of P');
    });
    const c = await m.write('C newly attached member');
    await m.write({ text: 'P now contains C', links: { 資料: p.ref, 補足: c.ref } });
    const result = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(result.diagnostics.derived, 'regenerated');
    assert.ok(calls.length);
    const texts = calls.at(-1).sources.map((s) => s.text);
    for (const expected of [a.text, b.text, c.text, 'P now contains C'])
      assert.ok(texts.includes(expected), `Missing generator input: ${expected}`);
  });
  test(`${adapter}: R2 overlapping quotations share the actual context evidence text`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const source = await m.write('AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await extractor.write('AAAABBBB', {
      sources: [{ ref: source.ref, start: 0, end: 8 }],
    });
    const b = await extractor.write('BBBBCCCC', {
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
  test(`${adapter}: R2 containment keeps each Atom and the harness sends shared evidence once`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const source = await m.write('AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const whole = await extractor.write(source.text, { sources: [{ ref: source.ref }] });
    const inside = await extractor.write('BBBB', {
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
    let actual;
    const harness = new MemoryHarness({
      memory: m,
      instruction: 'Answer from evidence.',
      memoryTokens: 10000,
      model: {
        id: 'context-capture',
        tokenizer: utf8Tokenizer,
        contextWindow: 50000,
        networkCallsPerCall: 0,
        respond: async (input) => {
          actual = input.memory;
          return { kind: 'finish', output: 'done' };
        },
      },
    });
    const run = await harness.run({ input: 'BBBB' });
    assert.equal(run.status, 'completed', run.error);
    assert.equal((JSON.stringify(actual).match(/BBBB/g) ?? []).length, 1);
    assert.ok(actual.memory.every((v) => !('text' in v)));
  });
  test(`${adapter}: R2 Japanese disjoint ranges expose omissions and preserve repeated source positions`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const left = '認証は許可しない。';
    const omitted = 'ここは省略する長い背景説明です。';
    const right = '認証は管理者に確認。';
    const source = await m.write(left + omitted + right);
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await extractor.write(left, {
      sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(left) }],
    });
    await extractor.write(left.slice(0, -1), {
      sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(left.slice(0, -1)) }],
    });
    const start = Buffer.byteLength(left + omitted);
    await extractor.write(right, {
      sources: [{ ref: source.ref, start, end: start + Buffer.byteLength(right) }],
    });
    const result = await m.read({ query: '認証' }, { ...readOptions, limit: 3 });
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
    const first = await m.write('AAAABBBBCCCC');
    const second = await other.write('AAAABBBBCCCC');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    await extractor.edit((d) => d.write(first.text, { sources: [{ ref: first.ref }] }), {
      basis: 'historical',
    });
    await m.edit((d) => d.revise(first.ref, 'AAAABBBBCCCC revised version'));
    const result = await m.read({ query: 'BBBB' }, readOptions);
    const contexts = JSON.parse(result.text);
    assert.equal((result.text.match(/BBBB/g) ?? []).length, 3);
    assert.equal(new Set(result.sources.map((s) => s.ref)).size, 3);
    assert.ok(contexts.memory.some((v) => v.provenance.producer === 'other-speaker'));
    assert.equal((await other.inspect(second.ref)).atom.text, second.text);
  });
  test(`${adapter}: R2 summaries with the same origins are not treated as verbatim equivalents`, async (t) => {
    const { memory: m, writer } = setup(t);
    const source = await m.write('認証には条件がある。');
    const a = await writer.write('認証は管理者が承認した場合だけ許可。', {
      sources: [{ ref: source.ref }],
    });
    const b = await writer.write('認証は検証環境でだけ許可。', { sources: [{ ref: source.ref }] });
    const result = JSON.parse((await m.read({ query: '認証' }, readOptions)).text);
    for (const v of [a, b]) {
      assert.equal(result.memory.find((x) => x.ref === v.ref).text, v.text);
      assert.ok(!result.memory.find((x) => x.ref === v.ref).quote);
    }
  });
  test(`${adapter}: R2 required conditions are included in the final text or the complete claim is omitted`, async (t) => {
    const { memory: m, host, binding } = setup(t);
    const condition = await m.write('ただし管理者が承認した場合だけ。'.repeat(30));
    const source = await m.write('認証を許可する。ただし管理者が承認した場合だけ。');
    const extractor = host.connect({
      ...binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const claimText = '認証を許可する。';
    const claim = await extractor.write(
      { text: claimText, links: { 条件: { ref: condition.ref, required: true } } },
      {
        sources: [{ ref: source.ref, start: 0, end: Buffer.byteLength(claimText) }],
      },
    );
    await extractor.write(claimText, {
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
  for (const remove of ['retire', 'revise'])
    test(`${adapter}: R1 ${remove} removes membership without resurrecting an old cited member`, async (t) => {
      const calls = [];
      const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
      const p = await m.write('P');
      const a = await m.write('A remains');
      const b = await m.write('B removed');
      await m.write({ text: 'PA', links: { 資料: p.ref, 補足: a.ref } });
      const link = await m.write({ text: 'PB', links: { 資料: p.ref, 補足: b.ref } });
      const summary = await writer.edit(async (d) => {
        await d.inspect(p.ref, { depth: 2, version: 'latest', limit: 100 });
        return d.write('summarymarker', { sources: [{ ref: b.ref }] });
      });
      const raw = host.engine.storage.metaGet(`sdk:ref:${summary.value.ref}`).target;
      const receiptId = host.engine.storage.get(raw, host.engine.storage.watermark()).provenance
        .inputReceiptId;
      const before = host.engine.storage.metaGet(`sdk:trace:${receiptId}`);
      await m.edit((d) =>
        remove === 'retire' ? d.retire(link.ref) : d.revise(link.ref, 'unattached relation'),
      );
      await m.read({ query: 'summarymarker' }, readOptions);
      assert.ok(calls.length);
      const input = calls.at(-1);
      assert.ok(input.sources.some((s) => s.text === a.text));
      assert.ok(!input.sources.some((s) => s.text === b.text || s.text === 'PB'));
      assert.deepEqual(host.engine.storage.metaGet(`sdk:trace:${receiptId}`), before);
      assert.ok(input.atoms.some((a) => a.links.some((l) => l.role === '資料')));
      assert.ok(input.receipt.state.endsWith(`:${host.engine.storage.watermark()}`));
    });
  test(`${adapter}: R1 an initially empty search is acquired again after an insertion`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    await writer.edit(async (d) => {
      assert.equal((await d.search('freshlookup')).items.length, 0);
      await d.write('summarymarker empty result');
    });
    const added = await m.write('freshlookup newly arrived');
    await m.read({ query: 'summarymarker' }, readOptions);
    assert.ok(calls.at(-1).sources.some((s) => s.text === added.text));
  });
  test(`${adapter}: R1 an empty declared composition acquires its first member`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    await writer.edit(async (d) => {
      assert.equal((await d.inspect(p.ref, { composition })).items.length, 1);
      await d.write('summarymarker');
    });
    const c = await m.write('first member');
    await m.write({ text: 'new relation', links: { 資料: p.ref, 補足: c.ref } });
    await m.read({ query: 'summarymarker' }, readOptions);
    assert.ok(calls.at(-1).sources.some((s) => s.text === c.text));
  });
  test(`${adapter}: R1 new matching information before an old page position is not missed`, async (t) => {
    const calls = [];
    const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await m.write(`unmatched ${i}`));
    // IDs are still generated by the public API. Choose the earliest existing slot and
    // make it newly match after reading later pages, without replacing the real adapter.
    const id = (v) => host.engine.storage.metaGet(`sdk:ref:${v.ref}`).target.atomId;
    rows.sort((a, b) => id(a).localeCompare(id(b)));
    for (let i = 1; i < rows.length; i++)
      await m.edit((d) => d.revise(rows[i].ref, `pagekeyword ${i}`));
    await writer.edit(async (d) => {
      const first = await d.search('pagekeyword', { limit: 1 });
      assert.ok(first.cursor);
      await d.search('pagekeyword', { limit: 1, cursor: first.cursor });
      await d.write('summarymarker');
    });
    const added = await m.edit((d) =>
      d.revise(rows[0].ref, 'pagekeyword newly matches before cursor'),
    );
    await m.read({ query: 'summarymarker' }, readOptions);
    assert.ok(calls.at(-1).sources.some((s) => s.text === added.value.text));
  });
  test(`${adapter}: R1 regenerated caches reuse text but issue current input records and respect total budget`, async (t) => {
    const calls = [];
    const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
    const a = await m.write('original input');
    await writer.write('summarymarker', { sources: [{ ref: a.ref }] });
    await m.edit((d) => d.revise(a.ref, 'corrected input'));
    const pending = await m.read(
      { query: 'summarymarker' },
      { ...readOptions, budget: { maxModelCalls: 0 } },
    );
    assert.equal(pending.diagnostics.derivedReason, 'budget');
    assert.equal(calls.length, 0);
    const first = await m.read({ query: 'summarymarker' }, readOptions);
    const second = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(calls.length, 1);
    const one = JSON.parse(first.text).temporary[0].receipt;
    const two = JSON.parse(second.text).temporary[0].receipt;
    assert.notEqual(one.id, two.id);
    assert.equal(one.state, two.state);
    assert.equal(host.engine.storage.metaEntries('sdk:cache:derived:').length, 1);
    assert.equal(first.usage.maxModelCalls, 1);
    assert.equal(second.usage.maxModelCalls, 0);
  });
  test(`${adapter}: R1 a paginated inspect replays the selection from its root`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    for (let i = 0; i < 3; i++) {
      const child = await m.write(`child ${i}`);
      await m.write({ text: `relation ${i}`, links: { arbitrary: p.ref, target: child.ref } });
    }
    await writer.edit(async (d) => {
      const page = await d.inspect(p.ref, { depth: 2, limit: 2 });
      assert.ok(page.cursor);
      await d.inspect(p.ref, { depth: 2, limit: 2, cursor: page.cursor });
      await d.write('summarymarker paginated');
    });
    const added = await m.write('new paginated child');
    await m.write({ text: 'new relation', links: { arbitrary: p.ref, target: added.ref } });
    await m.read({ query: 'summarymarker' }, readOptions);
    assert.ok(calls.at(-1).sources.some((s) => s.text === added.text));
    for (let i = 0; i < 3; i++)
      assert.ok(calls.at(-1).sources.some((s) => s.text === `child ${i}`));
  });
  test(`${adapter}: R1 changes during generation reject the obsolete result`, async (t) => {
    const calls = [];
    const f = setup(t, { generator: generator(calls) });
    const { memory: m, writer, host } = f;
    const source = await m.write('old current input');
    await writer.write('summarymarker', { sources: [{ ref: source.ref }] });
    const correction = await m.edit((d) => d.revise(source.ref, 'corrected input'));
    host.engine.options.generator.generate = async (input) => {
      calls.push(input);
      await m.edit((d) => d.revise(correction.value.ref, 'changed during generation'));
      return 'obsolete generated result';
    };
    await assert.rejects(
      m.read({ query: 'summarymarker' }, readOptions),
      (e) => e.code === 'STATE_INVALIDATED',
    );
    assert.equal(host.engine.storage.metaEntries('sdk:cache:derived:').length, 0);
  });
  test(`${adapter}: R1 incomplete reacquisition never calls the generator`, async (t) => {
    const calls = [];
    const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    await writer.edit(async (d) => {
      await d.inspect(p.ref, { depth: 2 });
      await d.write('summarymarker');
    });
    for (let i = 0; i < 4; i++) {
      const child = await m.write(`large child ${i}`);
      await m.write({ text: 'attachment', links: { arbitrary: p.ref, target: child.ref } });
    }
    host.engine.options.maxScan = 2;
    // Search pagination may be needed to discover the summary under the same bounded provider.
    let page;
    do {
      page = await m.read({ query: 'summarymarker' }, { ...readOptions, cursor: page?.cursor });
      if (page.diagnostics.derived === 'pending') break;
    } while (page.cursor);
    assert.equal(calls.length, 0);
    assert.equal(page.diagnostics.derived, 'pending');
    assert.equal(page.diagnostics.derivedReason, 'acquisition-incomplete');
  });
  test(`${adapter}: R1 legacy receipts without plans degrade without guessing current membership`, async (t) => {
    const calls = [];
    const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
    const p = await m.write('old source');
    const summary = await writer.write('summarymarker', { sources: [{ ref: p.ref }] });
    const entry = host.engine.storage.metaGet(`sdk:ref:${summary.ref}`);
    const revision = host.engine.storage.get(entry.target, host.engine.storage.watermark());
    const key = `sdk:trace:${revision.provenance.inputReceiptId}`;
    const trace = host.engine.storage.metaGet(key);
    delete trace.plans;
    host.engine.storage.metaSet(key, trace);
    await m.edit((d) => d.revise(p.ref, 'new source'));
    const page = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(calls.length, 0);
    assert.equal(page.diagnostics.derived, 'pending');
    assert.equal(page.diagnostics.derivedReason, 'missing-plan');
    assert.doesNotMatch(page.text, /summarymarker/);
  });
  test(`${adapter}: R1 a newly generated member and its original evidence both reach regeneration`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    await writer.edit(async (d) => {
      await d.inspect(p.ref, { composition });
      await d.write('summarymarker');
    });
    const original = await m.write('new original evidence');
    const child = await writer.write('generated child explanation', {
      sources: [{ ref: original.ref }],
    });
    await m.write({ text: 'new relationship', links: { 資料: p.ref, 補足: child.ref } });
    const result = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(result.diagnostics.derived, 'regenerated');
    for (const value of [original.text, child.text, 'new relationship'])
      assert.ok(calls.at(-1).sources.some((s) => s.text === value));
  });
  test(`${adapter}: R1 blob metadata is not presented as complete regeneration evidence`, async (t) => {
    const calls = [];
    const { memory: m, writer, host, binding } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    await writer.edit(async (d) => {
      await d.inspect(p.ref, { composition });
      await d.write('summarymarker');
    });
    const blob = await host.ingestBlob(Buffer.from('日本語の原資料'), 'text/plain', binding);
    await m.write({ text: 'blob member', links: { 資料: p.ref, 補足: blob.ref } });
    const page = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(calls.length, 0);
    assert.equal(page.diagnostics.derivedReason, 'unsupported-input');
    assert.equal(
      (await m.inspect(blob.ref, { range: { bytes: 100 } })).range.text,
      '日本語の原資料',
    );
  });
  test(`${adapter}: R1 a later successful regeneration does not hide another pending input`, async (t) => {
    const calls = [];
    const { memory: m, writer, host } = setup(t, { generator: generator(calls) });
    const one = await m.write('first original');
    const two = await m.write('second original');
    const legacy = await writer.write('summarymarker', { sources: [{ ref: one.ref }] });
    await writer.write('summarymarker longer current explanation', { sources: [{ ref: two.ref }] });
    const target = host.engine.storage.metaGet(`sdk:ref:${legacy.ref}`).target;
    const id = host.engine.storage.get(target, host.engine.storage.watermark()).provenance
      .inputReceiptId;
    const trace = host.engine.storage.metaGet(`sdk:trace:${id}`);
    delete trace.plans;
    host.engine.storage.metaSet(`sdk:trace:${id}`, trace);
    await m.edit(async (d) => {
      await d.revise(one.ref, 'first corrected');
      await d.revise(two.ref, 'second corrected');
    });
    const result = await m.read({ query: 'summarymarker' }, readOptions);
    assert.equal(calls.length, 1);
    assert.equal(result.diagnostics.derived, 'pending');
    assert.equal(result.diagnostics.derivedReason, 'missing-plan');
    assert.equal(JSON.parse(result.text).temporary.length, 1);
  });
  test(`${adapter}: R3 retaining P does not enumerate Q through their shared child`, async (t) => {
    const { memory: m } = setup(t, { historyMaxAtoms: 5 });
    const p = await m.write('P');
    const q = await m.write('Q');
    const a = await m.write('A');
    const b = await m.write('B shared');
    const c = await m.write('C belongs only to Q');
    await m.write({ text: 'PA', links: { 資料: p.ref, 補足: a.ref } });
    await m.write({ text: 'PB', links: { 資料: p.ref, 補足: b.ref } });
    await m.write({ text: 'QB', links: { 資料: q.ref, 補足: b.ref } });
    await m.write({ text: 'QC', links: { 資料: q.ref, 補足: c.ref } });
    const p2 = await m.write('P2');
    for (let i = 0; i < 30; i++) {
      const extra = await m.write(`Q extra ${i}`);
      await m.write({
        text: 'large unrelated composition',
        links: { 資料: q.ref, 補足: extra.ref },
      });
    }
    await m.edit((d) => d.supersede(p.ref, p2.ref, { composition }), {
      budget: { maxCandidates: 30 },
    });
    const old = await m.inspect(p.ref, { history: 'retained', limit: 100 });
    assert.deepEqual(old.items.map((i) => i.text).sort(), ['A', 'B shared', 'P', 'PA', 'PB']);
    assert.equal((await m.inspect(q.ref)).atom.text, 'Q');
  });
  test(`${adapter}: R3 explicit deep composition survives child changes and receipt expiry`, async (t) => {
    const { memory: m, host } = setup(t, { historyMaxAtoms: 1 });
    const root = await m.write('deep root');
    let parent = root;
    for (let i = 0; i < 36; i++) {
      const child = await m.write(`deep child ${i}`);
      await m.write({ text: `edge ${i}`, links: { 資料: parent.ref, 補足: child.ref } });
      parent = child;
    }
    // An explicit recursive cycle also stops without turning neighbouring groups into children.
    await m.write({ text: 'cycle', links: { 資料: parent.ref, 補足: root.ref } });
    const next = await m.write('new root');
    await m.edit((d) =>
      d.supersede(root.ref, next.ref, {
        composition: { relations: [{ parent: '資料', children: ['補足'], recursive: true }] },
      }),
    );
    await m.edit((d) => d.revise(parent.ref, 'leaf changed later'));
    for (const [key] of host.engine.storage.metaEntries('receipt:'))
      host.engine.storage.metaDelete(key);
    for (const [key] of host.engine.storage.metaEntries('sdk:cursor:'))
      host.engine.storage.metaDelete(key);
    let page;
    const items = [];
    let pages = 0;
    do {
      page = await m.inspect(root.ref, {
        history: 'retained',
        depth: 0,
        limit: 7,
        cursor: page?.cursor,
      });
      assert.ok(page.items.length);
      items.push(...page.items);
      assert.ok(++pages < 30);
    } while (page.cursor);
    assert.equal(new Set(items.map((i) => i.ref)).size, 74);
    assert.ok(items.some((i) => i.text === 'deep child 35'));
    assert.ok(!items.some((i) => i.text === 'leaf changed later'));
  });
  test(`${adapter}: R3 a host composition inspect supplies the same plan to regeneration and succession`, async (t) => {
    const calls = [];
    const { memory: m, writer } = setup(t, { generator: generator(calls) });
    const p = await m.write('P');
    const q = await m.write('Q unrelated');
    const a = await m.write('A');
    await m.write({ text: 'PA', links: { 資料: p.ref, 補足: a.ref } });
    await m.write({ text: 'QA', links: { 資料: q.ref, 補足: a.ref } });
    await writer.edit(async (d) => {
      await d.inspect(p.ref, { composition });
      await d.write('summarymarker');
    });
    const b = await m.write('B new');
    await m.write({ text: 'PB', links: { 資料: p.ref, 補足: b.ref } });
    await m.read({ query: 'summarymarker' }, readOptions);
    assert.ok(calls.at(-1).sources.some((s) => s.text === b.text));
    assert.ok(!calls.at(-1).sources.some((s) => s.text === q.text));
    const next = await m.write('P2');
    await m.edit(async (d) => {
      await d.inspect(p.ref, { composition });
      await d.supersede(p.ref, next.ref);
    });
    assert.equal((await m.inspect(p.ref, { history: 'retained', limit: 100 })).items.length, 5);
  });
  test(`${adapter}: R3 unknown links need a declared composition, not an inferred connected component`, async (t) => {
    const { memory: m } = setup(t);
    const p = await m.write('P');
    const q = await m.write('Q');
    await m.write({ text: 'ambiguous relation', links: { whatever: p.ref } });
    await assert.rejects(
      m.edit((d) => d.supersede(p.ref, q.ref)),
      (e) => e.code === 'HISTORY_PLAN_REQUIRED',
    );
    assert.equal((await m.inspect(p.ref, { successor: true })).atom.ref, p.ref);
  });
  test(`${adapter}: R3 failed snapshot retention rolls back successor and staged writes`, async (t) => {
    const { memory: m, host } = setup(t);
    const p = await m.write('P');
    const q = await m.write('Q');
    host.engine.storage.retainSnapshot = () => 'unretained-token';
    await assert.rejects(
      m.edit(async (d) => {
        await d.write('must roll back');
        await d.supersede(p.ref, q.ref);
      }),
      (e) => e.code === 'HISTORY_INCOMPLETE',
    );
    assert.equal((await m.search('must roll back')).items.length, 0);
    assert.equal((await m.inspect(p.ref, { successor: true })).atom.ref, p.ref);
  });
  test(`${adapter}: R3 manifest fallback is local, finite and preserves observed children`, async (t) => {
    const { memory: m, host } = setup(t, { historyMaxAtoms: 3 });
    host.engine.storage.retainSnapshot = undefined;
    const p = await m.write('P');
    const q = await m.write('Q');
    const a = await m.write('A old');
    const link = await m.write({ text: 'PA', links: { 資料: p.ref, 補足: a.ref } });
    await m.write({ text: 'QA', links: { 資料: q.ref, 補足: a.ref } });
    const next = await m.write('P2');
    await m.edit((d) => d.supersede(p.ref, next.ref, { composition }));
    await m.edit(async (d) => {
      await d.revise(a.ref, 'A new');
      await d.retire(link.ref);
    });
    // Pre-fix manifests have only pinned pages and a watermark, without a stored plan.
    for (const [key, value] of host.engine.storage.metaEntries('sdk:history:')) {
      delete value.composition;
      host.engine.storage.metaSet(key, value);
    }
    const past = await m.inspect(p.ref, { history: 'retained', limit: 20 });
    assert.deepEqual(past.items.map((i) => i.text).sort(), ['A old', 'P', 'PA']);
    const q2 = await m.write('Q2');
    host.engine.options.historyMaxAtoms = 1;
    await assert.rejects(
      m.edit((d) => d.supersede(q.ref, q2.ref, { composition })),
      (e) => e.code === 'HISTORY_INCOMPLETE',
    );
    assert.equal((await m.inspect(q.ref, { successor: true })).atom.ref, q.ref);
  });
  test(`${adapter}: R3 concurrent successor adoption conflicts without replay or partial publication`, async (t) => {
    const { memory: m } = setup(t);
    const p = await m.write('P');
    const one = await m.write('first successor');
    const two = await m.write('second successor');
    let calls = 0;
    await assert.rejects(
      m.edit(async (d) => {
        calls++;
        await d.supersede(p.ref, one.ref);
        await m.edit((other) => other.supersede(p.ref, two.ref));
        await d.write('losing change');
      }),
      (e) => e.code === 'SUCCESSOR_CONFLICT',
    );
    assert.equal(calls, 1);
    assert.equal((await m.inspect(p.ref, { successor: true })).atom.ref, two.ref);
    assert.equal((await m.search('losing change')).items.length, 0);
  });
  for (const invalidate of ['revoke', 'purge'])
    test(`${adapter}: R3 current ${invalidate} still overrides retained history`, async (t) => {
      const { memory: m, host, authority, auth } = setup(t);
      const p = await m.write('P');
      const a = await m.write('private child');
      await m.write({ text: 'PA', links: { 資料: p.ref, 補足: a.ref } });
      const next = await m.write('P2');
      await m.edit((d) => d.supersede(p.ref, next.ref, { composition }));
      await m.inspect(p.ref, { history: 'retained', limit: 1 });
      if (invalidate === 'revoke') authority.revoke(auth);
      else host.purge(host.engine.storage.metaGet(`sdk:ref:${a.ref}`).target.atomId);
      await assert.rejects(m.inspect(p.ref, { history: 'retained', limit: 100 }), (e) =>
        ['ACCESS_DENIED', 'REFERENCE_UNAVAILABLE', 'HISTORY_EXPIRED'].includes(e.code),
      );
    });
}
