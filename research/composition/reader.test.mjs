import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';
import { pack } from '../../dist/client/retrieval.js';
import { atomFixture, acquire, prepare, budget } from './fixture.mjs';
import { compileComposition, CompositionCache } from './evaluator.mjs';
import { createResearchRead, prepareEvaluator } from './reader.mjs';

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: budgeted evaluation returns exactly packed evidence and resumes`, async (t) => {
    const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    t.after(() => storage.close());
    const f = await atomFixture(storage, 2, 4);
    const condition = await f.memory.write('APPROVAL REQUIRED');
    const claim = await f.memory.write({
      text: 'LAUNCH IS ALLOWED',
      links: { condition: { ref: condition.ref, required: true } },
    });
    const source = await f.memory.write('AAAABBBBCCCC');
    const writer = f.host.connect({
      ...f.binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    await writer.write('AAAABBBB', { sources: [{ ref: source.ref, start: 0, end: 8 }] });
    await writer.write('BBBBCCCC', { sources: [{ ref: source.ref, start: 4, end: 12 }] });
    await prepare(f.host, f.binding);
    const g = await acquire(f),
      cache = new CompositionCache();
    const raw = compileComposition(g.seeds.length, g.edges, g.regions, { propagation: 0.65 })
      .solve(g.seeds)
      .scores();
    const candidates = g.state.nodes.map((c, i) => ({ ...c, score: raw[i] }));
    for (const method of ['composition', 'block', 'flat', 'push']) {
      const prepared = prepareEvaluator(g, method, 0.65, cache);
      for (const tokens of [0, 1200, 8000])
        for (const limit of [1, 6]) {
          const reference = await pack(
            f.engine,
            f.engine.session(f.binding, { budget }),
            candidates,
            tokens,
            limit,
          );
          const r = createResearchRead(f, g, { prepared, tokens, limit, maxWork: 0 });
          assert.equal(r.advance().complete, false);
          const done = r.advance(2_000_000);
          assert.equal(
            done.complete,
            true,
            `${method}/${tokens}/${limit}: ${JSON.stringify(done)}`,
          );
          const actual = r.finish();
          assert.equal(actual.text, reference.text);
          assert.deepEqual(actual.sources, reference.sources);
          assert.ok(actual.tokenCount <= tokens);
          if (actual.items.some((i) => i.ref === claim.ref))
            assert.ok(actual.items.some((i) => i.ref === condition.ref));
        }
    }
    const partial = createResearchRead(f, g, { maxWork: 25 });
    partial.advance();
    assert.ok(partial.finish().evaluation.work <= 25);
    const changing = createResearchRead(f, g, { maxWork: 0 });
    changing.advance();
    await f.memory.edit((d) => d.revise(condition.ref, 'UPDATED CONDITION'));
    assert.throws(() => changing.advance(2e6), { code: 'STATE_INVALIDATED' });
    assert.throws(() => changing.finish(), { code: 'STATE_INVALIDATED' });
    await prepare(f.host, f.binding);
    const current = await acquire(f);
    const purging = createResearchRead(f, current, { maxWork: 0 });
    purging.advance();
    f.host.purge(f.atomId(claim.ref));
    assert.throws(() => purging.advance(2e6), { code: 'STATE_INVALIDATED' });
    assert.throws(() => purging.finish(), { code: 'STATE_INVALIDATED' });
    const remaining = await acquire(f);
    const revoked = createResearchRead(f, remaining, { maxWork: 0 });
    revoked.advance();
    f.options.authority.update(f.binding.auth, {
      subject: 'composition',
      readPolicies: [],
      writePolicies: [],
    });
    assert.throws(() => revoked.advance(2e6), { code: 'STATE_INVALIDATED' });
  });
