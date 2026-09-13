import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MemoryStorage } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';
import { pack } from '../../dist/client/retrieval.js';
import { atomFixture, acquire, budget, prepare } from './fixture.mjs';
import { compileComposition, CompositionCache } from './evaluator.mjs';
import { prepareEvaluator, createResearchRead } from './reader.mjs';
import { WorkBudget } from './work.mjs';
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const results = [];
for (const adapter of ['memory', 'sqlite'])
  for (const shape of ['shared', 'costly-condition']) {
    const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    try {
      const f = await atomFixture(storage, 6, 8);
      if (shape === 'costly-condition') {
        const condition = await f.memory.write(
          'Required approval and source evidence. '.repeat(400),
        );
        await f.memory.write({
          text: 'Important exception with a costly indivisible condition',
          links: { condition: { ref: condition.ref, required: true } },
        });
        await prepare(f.host, f.binding);
      }
      const begin = performance.now(),
        g = await acquire(f),
        acquisitionMs = performance.now() - begin;
      const full = compileComposition(g.seeds.length, g.edges, [], { propagation: 0.65 })
        .solve(g.seeds)
        .scores();
      const candidates = g.state.nodes.map((c, i) => ({ ...c, score: full[i] }));
      const tokens = 8192,
        limit = 8;
      const expected = await pack(
        f.engine,
        f.engine.session(f.binding, { budget }),
        candidates,
        tokens,
        limit,
      );
      for (const method of ['composition', 'block', 'flat', 'push']) {
        const cache = new CompositionCache();
        const start = performance.now(),
          prepared = prepareEvaluator(g, method, 0.65, cache),
          prepareMs = performance.now() - start;
        for (const maxWork of [2_000, 20_000, 200_000]) {
          const times = [],
            trials = [];
          for (let repeat = 0; repeat < 5; repeat++) {
            const start = performance.now();
            const reader = createResearchRead(f, g, { prepared, tokens, limit, maxWork });
            reader.advance();
            const output = reader.finish();
            times.push(performance.now() - start);
            trials.push(output);
            assert.ok(output.evaluation.work <= maxWork);
            assert.ok(output.tokenCount <= tokens);
            const refs = output.items.map((x) => x.ref);
            assert.deepEqual(
              refs,
              expected.items.slice(0, refs.length).map((x) => x.ref),
            );
            if (output.evaluation.complete) {
              assert.equal(output.text, expected.text);
              assert.deepEqual(output.sources, expected.sources);
            }
            for (const item of output.items)
              for (const link of item.links)
                if (link.required)
                  assert.ok(
                    refs.includes(link.ref),
                    'a selected claim cannot omit its required condition',
                  );
          }
          const output = trials[0];
          results.push({
            adapter,
            shape,
            nodes: g.seeds.length,
            method,
            maxWork,
            prepareMs,
            cache: cache.footprint,
            medianReadMs: median(times),
            acquisitionMs,
            coldTotalEstimateMs: acquisitionMs + prepareMs + median(times),
            returned: output.items.length,
            referenceReturned: expected.items.length,
            referenceEvidenceRecall: expected.items.length
              ? output.items.length / expected.items.length
              : 1,
            conditionOmissions: 0,
            orderedPrefixMatches: true,
            complete: output.evaluation.complete,
            work: output.evaluation.work,
            reason: output.evaluation.reason,
            scope: output.evaluation.scope,
            outputStorageUsage: output.storageUsage,
            acquisitionUsage: g.session.ledger.usage(),
            graphReadsSaved: 0,
            outputTokens: output.tokenCount,
          });
        }
      }
    } finally {
      storage.close();
    }
  }
// Separate numeric scale probe: exact directed-ring solution, no body I/O.
const scale = [];
for (const nodes of [128, 1024, 8192]) {
  const edges = Array.from({ length: nodes }, (_, i) => ({
    from: i,
    to: (i + 1) % nodes,
    weight: 1,
  }));
  const seeds = Array(nodes).fill(0);
  seeds[0] = 1;
  const regions = Array.from({ length: Math.ceil(nodes / 32) }, (_, block) =>
    Array.from({ length: Math.min(32, nodes - block * 32) }, (_, i) => block * 32 + i),
  );
  for (const method of ['composition', 'block', 'flat', 'push']) {
    const start = performance.now();
    let prepared;
    try {
      prepared = prepareEvaluator({ seeds, edges, regions }, method, 0.65);
    } catch (e) {
      if (nodes > 1024 && e.code === 'INVALID_INPUT') {
        scale.push({ nodes, method, supported: false, reason: 'bounded dense prototype limit' });
        continue;
      }
      throw e;
    }
    const prepareMs = performance.now() - start,
      work = new WorkBudget(2_000_000),
      queryStart = performance.now();
    let complete = false,
      error;
    try {
      const q = prepared.start(seeds, work.take);
      if (method === 'flat' || method === 'push') {
        for (;;) {
          q.bounds();
          if (q.stats.rawErrorL1Upper < 1e-9) break;
          q.refine();
        }
      }
      const scores = Array.from({ length: nodes }, (_, i) => q.score(i));
      error = Math.max(
        ...scores.map((v, i) => Math.abs(v - (0.35 * 0.65 ** i) / (1 - 0.65 ** nodes))),
      );
      assert.ok(error < 1e-9);
      complete = true;
    } catch (e) {
      if (e.code !== 'BUDGET_EXHAUSTED') throw e;
    }
    scale.push({
      nodes,
      method,
      supported: true,
      complete,
      prepareMs,
      numericMs: performance.now() - queryStart,
      work: work.used,
      maximumScoreError: error,
    });
  }
}
const sourceFiles = [
  'evaluator.mjs',
  'linear.mjs',
  'reader.mjs',
  'work.mjs',
  'fixture.mjs',
  'evaluate-reader.mjs',
  '../../src/client/retrieval.ts',
];
const record = {
  at: new Date().toISOString(),
  node: process.version,
  sourceSha256: Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest('hex'),
    ]),
  ),
  contract:
    'Identical authorized bounded graph, input, propagation=.65, output budget and cumulative numeric work budget; median of five query+packing runs, preparation and acquisition reported separately.',
  workDefinition:
    'Coefficient applications, bound endpoints, candidate/closure comparisons; not FLOPs or equal CPU cost. Wall time includes scheduling and actual packing.',
  results,
  numericScale: scale,
  decision:
    'Do not replace default retrieval: compare cold acquisition+preparation+read costs, not only folded score recovery. Required closure selection is implemented, but global candidate completeness is not certified.',
  limits: [
    'Synthetic data and fixed encoder in this comparison; semantic model evaluation is separate',
    'Graph acquisition is full; numeric work bounds do not reduce the acquisition ledger',
    'Compiled bounds enclose floating reconstruction; sparse baselines use residual bounds for the fixed rounded transition',
    'These are in-repo implementations; this does not reproduce BEARD timings or establish novelty',
  ],
};
if (process.argv.includes('--record'))
  writeFileSync(
    new URL('reader-results.json', import.meta.url),
    JSON.stringify(record, null, 2) + '\n',
  );
console.log(JSON.stringify(record, null, 2));
