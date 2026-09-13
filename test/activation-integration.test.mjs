import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { MemoryHost } from '../dist/index.js';
import { finishRanking, startRanking, collectRanking } from '../dist/client/ranking.js';
const budget = { maxCandidates: 4000, maxBytes: 4000000, maxAtoms: 100, maxContextTokens: 40000 };

test('a provider proposes references; injected scores and bodies cannot control activation', async (t) => {
  let refs = [];
  const provider = {
    id: 'untrusted-scores',
    async retrieve() {
      return {
        candidates: refs,
        scanned: refs.length,
        complete: true,
        pending: false,
        approximate: true,
      };
    },
  };
  const f = fixture({ candidateProvider: provider, activation: { propagation: 0 } });
  t.after(() => f.storage.close());
  const match = await f.memory.write('needle');
  const unrelated = await f.memory.write('something different');
  refs = [match, unrelated].map((v) => ({
    ...f.storage.metaGet(`sdk:ref:${v.ref}`).target,
    score: v === unrelated ? 1e100 : 0,
    body: { kind: 'inline', value: 'needle' },
  }));
  const result = await f.memory.search('needle', { budget });
  assert.deepEqual(
    result.items.map((i) => i.ref),
    [match.ref],
  );
  refs = [{ revision: refs[0], score: 10 }];
  await assert.rejects(f.memory.search('needle', { budget }), { code: 'INVALID_INPUT' });
});

test('every acquired internal body supplies direct activation, even outside provider seeds', async (t) => {
  const f = fixture();
  t.after(() => f.storage.close());
  const child = await f.memory.write('needle child');
  const parent = await f.memory.write({ text: 'unrelated parent', links: { member: child.ref } });
  const engine = f.host.engine;
  const session = engine.session(f.binding, { budget });
  const revision = engine.get(engine.resolve(parent.ref, session).target, session);
  const state = startRanking([{ revision, score: 1 }], 2, engine.options.retrieval);
  assert.ok(collectRanking(engine, session, state));
  const evaluated = finishRanking(engine, session, state, [{ kind: 'query', text: 'needle' }]);
  assert.equal(
    evaluated.candidates[0].revision.atomId,
    f.storage.metaGet(`sdk:ref:${child.ref}`).target.atomId,
  );
  assert.ok(evaluated.evaluation.evaluationConverged);
});

test('read alone does not record; actual delivery changes only the next frozen evaluation', async (t) => {
  const f = fixture({ activation: { propagation: 0 } });
  t.after(() => f.storage.close());
  const a = await f.memory.write('needle A');
  const b = await f.memory.write('needle B');
  const page = await f.memory.search('needle', { limit: 1, budget });
  assert.equal(f.storage.metaEntries('sdk:use:state:').length, 0);
  const other = page.items[0].ref === a.ref ? b : a;
  f.host.recordUse([other.ref], f.binding, { eventId: 'model:1' });
  const frozen = await f.memory.search('needle', { cursor: page.cursor, limit: 1, budget });
  assert.equal(frozen.items[0].score, 0.5);
  assert.equal(frozen.diagnostics.evaluatedAt, page.diagnostics.evaluatedAt);
  const next = await f.memory.search('needle', { budget });
  assert.equal(next.items[0].ref, other.ref);
  assert.ok(next.items[0].score > 0.5);
  assert.ok(next.diagnostics.numericErrorL1Upper <= 1e-6);
});

test('warm context and graph corrections agree with cold evaluation within reported bounds', async (t) => {
  const f = fixture();
  t.after(() => f.storage.close());
  const a = await f.memory.write('alpha');
  const b = await f.memory.write('beta');
  const p = await f.memory.write({ text: 'parent', links: { member: [a.ref, b.ref] } });
  await f.memory.search('alpha', { budget });
  const revised = await f.memory.edit((d) =>
    d.revise(p.ref, { text: 'parent', links: { member: b.ref } }),
  );
  const warm = await f.memory.search('beta', { budget });
  const coldHost = new MemoryHost({ ...f.host.engine.options, cacheMaxEntries: 0 });
  const cold = await coldHost.connect(f.binding).search('beta', { budget });
  const scores = new Map(cold.items.map((i) => [i.ref, i.score]));
  assert.equal(warm.items.length, cold.items.length);
  for (const item of warm.items)
    assert.ok(
      Math.abs(item.score - scores.get(item.ref)) <=
        warm.diagnostics.numericErrorL1Upper + cold.diagnostics.numericErrorL1Upper + 1e-14,
    );
  assert.ok(warm.items.some((i) => i.ref === revised.value.ref));
  assert.ok(!warm.items.some((i) => i.ref === a.ref));
});

test('0.6 rejects retired scoring configuration instead of silently accepting it', (t) => {
  const f = fixture();
  t.after(() => f.storage.close());
  for (const options of [
    { ranking: {} },
    { maxScan: 3 },
    { activation: { score: () => 1 } },
    { activation: { semantic: 1 } },
  ])
    assert.throws(() => new MemoryHost({ ...f.host.engine.options, ...options }), {
      code: 'INVALID_INPUT',
    });
});

for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter}: use transaction rolls back written markers and states on a late budget failure`, async (t) => {
    const { SqliteStorage } = await import('../dist/adapters/sqlite.js');
    const f = fixture(adapter === 'sqlite' ? { storage: new SqliteStorage(':memory:') } : {});
    t.after(() => f.storage.close());
    const atom = await f.memory.write('atomic use');
    const constrained = new MemoryHost({ ...f.host.engine.options, defaults: { maxBytes: 1 } });
    assert.throws(() => constrained.recordUse([atom.ref], f.binding, { eventId: 'retry' }), {
      code: 'BUDGET_EXHAUSTED',
    });
    assert.equal(f.storage.metaEntries('sdk:use:').length, 0);
    assert.equal(f.host.recordUse([atom.ref], f.binding, { eventId: 'retry' }).recorded, 1);
  });
}

test('SQLite reopen, scoped reset, and transitive purge preserve exact use-event semantics', async (t) => {
  const { SqliteStorage } = await import('../dist/adapters/sqlite.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'atom-use-reopen-'));
  const path = join(directory, 'memory.sqlite');
  let storage = new SqliteStorage(path);
  t.after(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture({ storage });
  const child = await f.memory.write('child');
  const parent = await f.memory.write({ text: 'parent', links: { member: child.ref } });
  f.host.recordUse([child.ref, parent.ref, child.ref], f.binding, { eventId: 'request:0' });
  const childPin = storage.metaGet(`sdk:ref:${child.ref}`).target;
  storage.close();
  storage = new SqliteStorage(path);
  const host = new MemoryHost({ ...f.host.engine.options, storage });
  assert.equal(
    host.recordUse([child.ref, parent.ref], f.binding, { eventId: 'request:0' }).repeated,
    2,
  );
  const auth = f.authority.issue({
    subject: 'another',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const other = { ...f.binding, auth };
  const otherRef = host.reference(childPin, other);
  host.recordUse([otherRef], other, { eventId: 'request:0' });
  host.resetUse(f.binding);
  assert.equal(storage.metaEntries('sdk:use:state:').length, 1);
  assert.equal(host.recordUse([child.ref], f.binding, { eventId: 'request:0' }).repeated, 1);
  host.purge(childPin.atomId);
  assert.equal(storage.metaEntries('sdk:use:').length, 0);
  assert.throws(() => host.recordUse([otherRef], other, { eventId: 'request:1' }), {
    code: 'ACCESS_DENIED',
  });
});
