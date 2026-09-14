import { create, revise } from '../../test/fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';
import { CompositionCache } from './evaluator.mjs';
import { atomFixture, acquire, comparePacked, prepare } from './fixture.mjs';
for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: composed Atom graph preserves packed evidence, scope, updates and stale exclusion`, async () => {
    const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    try {
      const f = await atomFixture(storage),
        cache = new CompositionCache();
      let previous;
      const check = async (context, tokens, limit) => {
        const graph = await acquire(f, context);
        const result = await comparePacked(f, graph, cache, tokens, limit);
        assert.ok(result.maximumError < 1e-12);
        const ids = graph.state.nodes.map((c) => c.revision.atomId);
        const sameIds = previous && JSON.stringify(ids) === JSON.stringify(previous.ids);
        const query = sameIds
          ? result.compiled.correct(graph.seeds, previous.raw)
          : result.compiled.solve(graph.seeds);
        const cold = result.compiled.solve(graph.seeds).scores();
        const selected = query.topK(Math.min(5, ids.length));
        assert.equal(selected.certified, true);
        const actual = query.scores();
        assert.ok(actual.every((v, i) => Math.abs(v - cold[i]) < 1e-12));
        assert.deepEqual(
          selected.items.map((i) => i.index),
          actual
            .map((score, index) => ({ score, index }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, Math.min(5, ids.length))
            .map((i) => i.index),
        );
        previous = { ids, raw: query.rawScores() };
        assert.deepEqual(
          result.folded.items.map((i) => i.ref),
          result.reference.items.map((i) => i.ref),
        );
        assert.equal(result.folded.text, result.reference.text);
        return result;
      };
      const first = await check('launch conditions');
      assert.ok(first.compiled.stats.eliminated > 0);
      const next = await check('different conversation and thought');
      assert.equal(next.compiled.stats.coefficientMisses, 0);
      const changedText = await revise(f.memory, f.leaves[0].ref, 'corrected record text');
      await prepare(f.host, f.binding);
      const bodyOnly = await check('launch conditions');
      assert.equal(
        bodyOnly.compiled.stats.coefficientMisses,
        0,
        'body revision does not alter transition operators',
      );
      const revisedGroup = await revise(f.memory, f.groups[0].ref, {
        text: 'changed membership',
        links: { member: f.leaves.slice(0, 3).map((l) => l.ref) },
      });
      await prepare(f.host, f.binding);
      const topology = await check('launch conditions');
      assert.ok(topology.compiled.stats.coefficientMisses > 0);
      assert.ok(topology.compiled.stats.coefficientHits > 0);
      const writer = f.host.connect({ ...f.binding, actor: { type: 'agent' } });
      const derived = {
        value: await create(writer, 'DERIVED CLAIM', { sources: [{ ref: changedText.value.ref }] }),
      };
      const privateAuth = f.options.authority.issue({
        subject: 'private',
        readPolicies: ['p', 'q'],
        writePolicies: ['q'],
        canIngestSource: true,
      });
      const privateBinding = { ...f.binding, auth: privateAuth, writePolicy: 'q' };
      const privateGroupRef = f.host.reference(
        storage.metaGet(`sdk:ref:${revisedGroup.value.ref}`).target,
        privateBinding,
      );
      const privateAgent = { ...privateBinding, actor: { type: 'agent' } };
      const inspection = await f.host.connect(privateAgent).inspect(privateGroupRef, { limit: 0 });
      const input = f.host.observe(
        { presentations: [{ receipt: inspection.receipt }], payloadDigest: '0'.repeat(64) },
        privateAgent,
      );
      await assert.rejects(
        create(
          f.host.connect(privateAgent),
          { text: 'PRIVATE CLAIM', links: { member: privateGroupRef } },
          { input },
        ),
        { code: 'ACCESS_DENIED' },
      );
      await create(f.host.connect(privateBinding), 'PRIVATE CLAIM');
      await prepare(f.host, privateBinding);
      await prepare(f.host, f.binding);
      const before = await check('claim');
      assert.ok(before.folded.items.some((i) => i.ref === derived.value.ref));
      assert.doesNotMatch(before.folded.text, /PRIVATE CLAIM/);
      await revise(f.memory, changedText.value.ref, 'latest correction');
      await prepare(f.host, f.binding);
      const after = await check('claim');
      assert.doesNotMatch(after.folded.text, /DERIVED CLAIM|PRIVATE CLAIM/);
      const condition = await create(f.memory, 'REQUIRED CONDITION');
      await create(f.memory, {
        text: 'CONDITIONAL CLAIM',
        links: { required: { ref: condition.ref, required: true } },
      });
      await prepare(f.host, f.binding);
      const fullConditions = await check('conditions');
      assert.ok(fullConditions.folded.items.some((i) => i.text === 'CONDITIONAL CLAIM'));
      assert.ok(fullConditions.folded.items.some((i) => i.ref === condition.ref));
      const packed = await check('conditions', 8000, 5);
      if (packed.folded.items.some((i) => i.text === 'CONDITIONAL CLAIM'))
        assert.ok(packed.folded.items.some((i) => i.ref === condition.ref));
      f.host.purge(f.atomId(condition.ref));
      const purged = await check('conditions');
      assert.doesNotMatch(purged.folded.text, /REQUIRED CONDITION|CONDITIONAL CLAIM/);
    } finally {
      storage.close();
    }
  });
