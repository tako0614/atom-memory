import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
import {
  MemoryHost,
  MemoryStorage,
  LexicalCandidateProvider,
  utf8Tokenizer,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { propagate, seedScore, rankingOptions } from '../dist/core/ranking.js';
import { collectRanking, startRanking } from '../dist/client/ranking.js';
const budget = { maxCandidates: 4000, maxBytes: 4000000, maxAtoms: 100, maxContextTokens: 40000 };

function collectFrom(f, ref, options = {}, operationBudget = budget) {
  const session = f.host.engine.session(f.binding, { budget: operationBudget });
  const root = f.host.engine.get(f.host.engine.resolve(ref, session).target, session);
  const state = startRanking(
    [{ revision: root, score: 1 }],
    options.depth ?? 2,
    f.host.engine.options.ranking,
  );
  const complete = collectRanking(f.host.engine, session, state);
  return { complete, session, state };
}

test('signal kinds keep their weights; repeated observations cannot drown out context', () => {
  const signals = [
    { kind: 'context', text: 'alpha', vector: [1, 0] },
    { kind: 'thought', text: 'beta', vector: [0, 1] },
  ];
  assert.equal(seedScore('alpha', [[1, 0]], signals), 0.5);
  assert.equal(
    seedScore('alpha', [[1, 0]], signals, { signals: { context: 3, thought: 1 } }),
    0.75,
  );
  const a = [
    { kind: 'context', text: 'alpha' },
    { kind: 'observations', text: 'beta' },
  ];
  assert.equal(
    seedScore('alpha', undefined, a),
    seedScore('alpha', undefined, [...a, ...a.slice(1)]),
  );
  for (const value of [-1, NaN, Infinity])
    assert.throws(() => rankingOptions({ propagation: value }), { code: 'INVALID_INPUT' });
  assert.throws(() => rankingOptions({ propagation: 1 }), { code: 'INVALID_INPUT' });
});
test('weighted propagation conserves mass, joins paths, and handles cycles and dangling nodes', () => {
  const graph = [
    { from: 0, to: 2, weight: 1 },
    { from: 1, to: 2, weight: 1 },
    { from: 2, to: 0, weight: 1 },
  ];
  const result = propagate([1, 1, 0, 0], graph);
  assert.ok(result.converged);
  assert.ok(Math.abs(result.scores.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.ok(result.scores[2] > result.scores[1]);
  assert.equal(result.scores[3], 0);
  result.breakdown.forEach((value, i) =>
    assert.equal(value.direct + value.structural, result.scores[i]),
  );
  assert.deepEqual(propagate([1, 1, 0], graph, { propagation: 0 }).scores, [0.5, 0.5, 0]);
  assert.deepEqual(propagate([0, 0], []).scores, [0, 0]);
});
for (const adapter of ['memory', 'sqlite']) {
  const setup = (t, options = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-rank-'));
    const storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'db.sqlite')) : new MemoryStorage();
    t.after(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return fixture({ storage, ...options });
  };
  test(`${adapter}: an exact node cap still collects every edge among admitted nodes`, async (t) => {
    const f = setup(t, { ranking: { maxNodes: 3, maxSeeds: 1 } });
    const c = await f.memory.write('C');
    const b = await f.memory.write({ text: 'B', links: { next: c.ref } });
    const a = await f.memory.write({ text: 'A', links: { child: [b.ref, c.ref] } });
    const { complete, state } = collectFrom(f, a.ref);
    assert.equal(complete, true);
    assert.equal(state.nodes.length, 3);
    assert.equal(state.edges.length, 3);
    assert.equal(state.truncated, false);
  });
  test(`${adapter}: rejected nodes do not stop edges between already admitted nodes`, async (t) => {
    const f = setup(t, { ranking: { maxNodes: 2, maxSeeds: 1 } });
    const a = await f.memory.write('A');
    const c = await f.memory.write('C');
    const b = await f.memory.write({
      text: 'B',
      links: { first: a.ref, reject: c.ref, second: a.ref },
    });
    const { complete, state } = collectFrom(f, b.ref);
    assert.equal(complete, true);
    assert.equal(state.nodes.length, 2);
    assert.equal(state.edges.length, 2);
    assert.equal(state.truncated, true);
    const cAtomId = f.storage.metaGet(`sdk:ref:${c.ref}`).target.atomId;
    assert.equal(
      state.nodes.some((node) => node.revision.atomId === cAtomId),
      false,
    );
    assert.deepEqual(state.edges.map((edge) => edge.role).sort(), ['first', 'second']);
  });
  test(`${adapter}: a stale seed cannot lend rank to its current neighbor`, async (t) => {
    const f = setup(t);
    const evidence = await f.memory.write('old evidence');
    const neighbor = await f.memory.write('unrelated current neighbor');
    const stale = await f.writer.write(
      { text: 'stale seed trigger', links: { related: neighbor.ref } },
      { sources: [{ ref: evidence.ref }] },
    );
    await f.memory.edit((draft) => draft.revise(evidence.ref, 'new evidence'));
    const page = await f.memory.search('stale seed trigger', { depth: 2, budget });
    assert.equal(
      page.items.some((item) => item.ref === stale.ref),
      false,
    );
    assert.equal(
      page.items.some((item) => item.ref === neighbor.ref),
      false,
    );
    assert.ok(page.stale.includes(stale.ref));
  });
  test(`${adapter}: traversal stops at a stale bridge and reports it`, async (t) => {
    const f = setup(t);
    const evidence = await f.memory.write('bridge old evidence');
    const neighbor = await f.memory.write('bridge current neighbor');
    const bridge = await f.writer.write(
      { text: 'stale bridge', links: { related: neighbor.ref } },
      { sources: [{ ref: evidence.ref }] },
    );
    const root = await f.memory.write({
      text: 'valid root trigger',
      links: { related: bridge.ref },
    });
    await f.memory.edit((draft) => draft.revise(evidence.ref, 'bridge new evidence'));
    const result = await f.memory.read(
      { query: 'valid root trigger' },
      { depth: 2, tokens: 20000, budget },
    );
    assert.ok(result.items.some((item) => item.ref === root.ref));
    assert.equal(
      result.items.some((item) => item.ref === bridge.ref),
      false,
    );
    assert.equal(
      result.items.some((item) => item.ref === neighbor.ref),
      false,
    );
    assert.ok(result.stale.includes(bridge.ref));
  });
  test(`${adapter}: relation-only evidence is recalled, duplicate edges have no extra weight, pages keep ranks`, async (t) => {
    const f = setup(t, { ranking: { relations: { condition: { forward: 2, reverse: 0 } } } });
    const condition = await f.memory.write('Only after an administrator signs.');
    const first = await f.memory.write({
      text: 'launch alpha',
      links: { condition: condition.ref },
    });
    await f.memory.write({ text: 'launch beta', links: { condition: condition.ref } });
    await f.memory.write('irrelevant huge hub');
    const all = await f.memory.search('launch', { limit: 20, budget });
    const target = all.items.find((i) => i.ref === condition.ref);
    assert.ok(target?.scoreBreakdown.structural > 0);
    assert.equal(target.scoreBreakdown.direct, 0);
    assert.ok(!all.items.some((i) => i.text === 'irrelevant huge hub'));
    const seen = [];
    let page;
    do {
      page = await f.memory.search('launch', { limit: 1, budget, cursor: page?.cursor });
      seen.push(...page.items.map((i) => [i.ref, i.score]));
    } while (page.cursor);
    assert.deepEqual(
      seen,
      all.items.map((i) => [i.ref, i.score]),
    );
    await f.memory.edit((d) =>
      d.revise(first.ref, {
        text: 'launch alpha',
        links: { condition: [condition.ref, condition.ref] },
      }),
    );
    const repeated = await f.memory.search('launch', { limit: 20, budget });
    assert.ok(
      Math.abs(repeated.items.find((i) => i.ref === condition.ref).score - target.score) < 1e-10,
    );
  });
  test(`${adapter}: graph differences, not extra embeddings, cause related evidence recall`, async (t) => {
    const embedding = {
      id: 'fixed',
      dimensions: 2,
      tokenizer: utf8Tokenizer,
      networkCallsPerCall: 0,
      embed: async (texts) => texts.map((text) => (text.startsWith('launch') ? [1, 0] : [0, 1])),
    };
    const f = setup(t, { embedding, ranking: { lexical: 0, semantic: 1 } });
    const evidence = await f.memory.write('a separate prerequisite');
    await f.memory.write({ text: 'launch topic', links: { evidence: evidence.ref } });
    await f.host.prepareIndex(f.binding, { budget });
    const without = await f.memory.read(
      { query: 'launch' },
      { depth: 0, tokens: 20000, limit: 20, budget },
    );
    const withGraph = await f.memory.read(
      { query: 'launch' },
      { depth: 2, tokens: 20000, limit: 20, budget },
    );
    assert.ok(!without.refs.includes(evidence.ref));
    assert.ok(withGraph.refs.includes(evidence.ref));
  });
  test(`${adapter}: 0.3 vector and feed migration resumes without document model calls; weights never invalidate it`, async (t) => {
    let documents = 0;
    const embedding = {
      id: 'space',
      dimensions: 2,
      tokenizer: utf8Tokenizer,
      networkCallsPerCall: 0,
      embed: async (texts, _signal, purpose) => {
        if (purpose === 'document') documents += texts.length;
        return texts.map(() => [1, 0]);
      },
    };
    const f = setup(t, { embedding });
    await f.memory.write('stored alpha');
    await f.memory.write('stored beta');
    await f.host.prepareIndex(f.binding, { budget });
    const engine = f.host.engine;
    for (const [key, value] of f.storage.metaEntries('sdk:index:'))
      f.storage.metaSet(key, { ...value, config: engine.legacyConfig });
    for (const [key] of f.storage.metaEntries('sdk:index-migration:')) f.storage.metaDelete(key);
    documents = 0;
    for (let i = 0; i < 10; i++)
      if (!(await f.host.updateIndex(f.binding, { limit: 1, budget })).pending) break;
    assert.equal(documents, 0);
    const next = new MemoryHost({
      ...engine.options,
      ranking: { signals: { context: 3 }, propagation: 0.7 },
    });
    await next.prepareIndex(f.binding, { budget });
    assert.equal(documents, 0);
    assert.equal(
      (await next.connect(f.binding).search('stored', { budget })).diagnostics.index,
      'ready',
    );
  });
  test(`${adapter}: role direction and grant boundaries also apply to inverse expansion`, async (t) => {
    const f = setup(t, { ranking: { relations: { hidden: { forward: 0, reverse: 0 } } } });
    const target = await f.memory.write('unrelated content');
    await f.memory.write({ text: 'visible needle', links: { hidden: target.ref } });
    const page = await f.memory.search('visible needle', { budget });
    assert.ok(!page.items.some((i) => i.ref === target.ref));
    const auth = f.authority.issue({
      subject: 'different',
      readPolicies: ['q'],
      writePolicies: ['q'],
      canIngestSource: true,
    });
    const secret = f.host.connect({ auth, writePolicy: 'q', actor: { type: 'human' } });
    await secret.write('visible needle private');
    assert.ok(
      !(await f.memory.search('visible needle', { budget })).items.some((i) =>
        i.text.includes('private'),
      ),
    );
  });
}

test('edge budget bounds graph collection after the node cap is reached', async (t) => {
  const f = fixture({ ranking: { maxNodes: 3, maxSeeds: 1, maxEdges: 2 } });
  t.after(() => f.storage.close());
  const c = await f.memory.write('C');
  const b = await f.memory.write({ text: 'B', links: { next: c.ref } });
  const a = await f.memory.write({ text: 'A', links: { child: [b.ref, c.ref] } });
  const { complete, state } = collectFrom(f, a.ref);
  assert.equal(complete, true);
  assert.equal(state.nodes.length, 3);
  assert.equal(state.edges.length, 2);
  assert.equal(state.truncated, true);
});

test('candidate budget exhaustion leaves ranking tasks resumable', async (t) => {
  const f = fixture({ ranking: { maxNodes: 3, maxSeeds: 1 } });
  t.after(() => f.storage.close());
  const c = await f.memory.write('C');
  const b = await f.memory.write({ text: 'B', links: { next: c.ref } });
  const a = await f.memory.write({ text: 'A', links: { child: [b.ref, c.ref] } });
  const first = collectFrom(
    f,
    a.ref,
    {},
    {
      maxCandidates: 2,
      maxBytes: 4000000,
      maxAtoms: 100,
      maxContextTokens: 40000,
    },
  );
  assert.equal(first.complete, false);
  assert.ok(first.state.tasks.length > 0);
  const resumed = collectRanking(
    f.host.engine,
    f.host.engine.session(f.binding, { budget }),
    first.state,
  );
  assert.equal(resumed, true);
  assert.equal(first.state.nodes.length, 3);
  assert.equal(first.state.edges.length, 3);
});

test('automatic recall returns useful memory from a large corpus within the default budget', async () => {
  const f = fixture();
  for (let i = 0; i < 700; i++) await f.memory.write(`common topic ${i}`);
  const result = await f.memory.read({ context: 'common topic' });
  assert.ok(result.refs.length > 0);
  assert.equal(result.diagnostics.approximate, true);
  const trace = f.storage.metaGet(`sdk:trace:${result.receipt.id}`);
  assert.ok(trace.reads.length < 256);
  const page = await f.memory.search('common topic', { limit: 1 });
  assert.equal(page.items.length, 1);
  const score = page.items[0].score;
  const remaining = [];
  let cursor = page.cursor;
  while (cursor) {
    const next = await f.memory.search('common topic', { cursor, limit: 100 });
    remaining.push(...next.items);
    cursor = next.cursor;
  }
  assert.ok(remaining.every((item) => item.score <= score));
  f.storage.close();
});
test('disabled inverse roles cannot add a parent; arbitrary role names remain ordinary roles', async () => {
  const f = fixture({
    candidateProvider: new LexicalCandidateProvider(),
    ranking: { relations: { hidden: { forward: 0, reverse: 0 } } },
  });
  const target = await f.memory.write('needle');
  await f.memory.write({ text: 'unrelated parent', links: { hidden: target.ref } });
  assert.equal(
    (await f.memory.search('needle', { depth: 2, budget })).items.some(
      (i) => i.text === 'unrelated parent',
    ),
    false,
  );
  await f.memory.write({ text: 'another parent', links: { constructor: target.ref } });
  assert.equal(
    (await f.memory.search('needle', { depth: 2, budget })).items.some(
      (i) => i.text === 'another parent',
    ),
    true,
  );
  f.storage.close();
});
