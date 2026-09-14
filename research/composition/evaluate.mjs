import { revise } from '../../test/fixtures.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryStorage } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';
import { compileComposition, CompositionCache } from './evaluator.mjs';
import { propagate, seedScore } from './reference-ranking.mjs';
import { atomFixture, acquire, comparePacked, prepare } from './fixture.mjs';
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function measure(fn, repetitions = 40) {
  for (let i = 0; i < 8; i++) fn(i);
  const samples = [];
  for (let trial = 0; trial < 7; trial++) {
    const start = performance.now();
    for (let i = 0; i < repetitions; i++) fn(i);
    samples.push((performance.now() - start) / repetitions);
  }
  return median(samples);
}
const runs = [];
for (const adapter of ['memory', 'sqlite']) {
  const storage = adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
  try {
    const f = await atomFixture(storage, 12, 12);
    const acquisitionStart = performance.now(),
      graph = await acquire(f);
    const acquisitionMs = performance.now() - acquisitionStart;
    const cache = new CompositionCache();
    let start = performance.now();
    const compiled = compileComposition(graph.seeds.length, graph.edges, graph.regions, {
      propagation: 0.65,
      cache,
    });
    const coldCompileMs = performance.now() - start;
    start = performance.now();
    const expanded = compileComposition(graph.seeds.length, graph.edges, [], { propagation: 0.65 });
    const fullFactorCompileMs = performance.now() - start;
    const inputs = [];
    for (let i = 0; i < 12; i++) {
      const context = `conversation ${i} context`,
        thought = `consideration ${i}`;
      const vectors = await f.options.embedding.embed([context, thought]);
      inputs.push(
        graph.state.nodes.map((c) =>
          seedScore(
            c.revision.body.value,
            storage.metaGet(`sdk:index:${c.revision.revisionId}`).vectors,
            [
              { kind: 'context', text: context, vector: vectors[0] },
              { kind: 'thought', text: thought, vector: vectors[1] },
            ],
            f.options.ranking,
          ),
        ),
      );
    }
    const choose = (i) => inputs[i % inputs.length];
    let maximumScoreError = 0,
      defaultMaximumScoreError = 0,
      referenceIterations = 0;
    for (const seeds of inputs) {
      const reference = propagate(seeds, graph.edges, f.options.ranking);
      assert.ok(reference.converged);
      referenceIterations = Math.max(referenceIterations, reference.iterations);
      const currentDefault = propagate(seeds, graph.edges, { propagation: 0.65 });
      const result = compiled.solve(seeds).scores();
      maximumScoreError = Math.max(
        maximumScoreError,
        ...result.map((v, i) => Math.abs(v - reference.scores[i])),
      );
      defaultMaximumScoreError = Math.max(
        defaultMaximumScoreError,
        ...result.map((v, i) => Math.abs(v - currentDefault.scores[i])),
      );
    }
    assert.ok(maximumScoreError < 1e-12);
    const referenceMs = measure((i) => propagate(choose(i), graph.edges, f.options.ranking));
    const defaultIterationsMs = measure((i) =>
      propagate(choose(i), graph.edges, { propagation: 0.65 }),
    );
    const foldedMs = measure((i) => compiled.solve(choose(i)).scores());
    const previousRaw = compiled.solve(choose(0)).rawScores();
    const adaptive = [];
    let correctionMaximumError = 0;
    for (const seeds of inputs) {
      const query = compiled.solve(seeds),
        selected = query.topK(5);
      assert.ok(selected.certified);
      const reference = compiled.solve(seeds).scores();
      assert.deepEqual(
        selected.items,
        reference
          .map((score, index) => ({ score, index }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, 5),
      );
      adaptive.push({
        recoveredNodes: selected.recoveredNodes,
        closedBlocks: selected.closedBlocks,
        numericCoefficientsVisited: query.stats.coefficientsVisited,
        boundCoefficientsVisited: query.stats.boundCoefficientsVisited,
      });
      const corrected = compiled.correct(seeds, previousRaw).scores();
      correctionMaximumError = Math.max(
        correctionMaximumError,
        ...corrected.map((v, i) => Math.abs(v - reference[i])),
      );
    }
    assert.ok(correctionMaximumError < 1e-12);
    const adaptiveMs = measure((i) => compiled.solve(choose(i)).topK(5));
    const correctionMs = measure((i) => compiled.correct(choose(i), previousRaw).scores());
    const fullFactorMs = measure((i) => expanded.solve(choose(i)).scores());
    const rebuildWithCacheMs = measure(
      () =>
        compileComposition(graph.seeds.length, graph.edges, graph.regions, {
          propagation: 0.65,
          cache,
        }),
      8,
    );
    const packed = await comparePacked(f, graph, cache);
    assert.equal(packed.folded.text, packed.reference.text);
    assert.deepEqual(
      packed.folded.items.map((i) => i.ref),
      packed.reference.items.map((i) => i.ref),
    );
    const second = await acquire(f, 'other context');
    const reused = compileComposition(second.seeds.length, second.edges, second.regions, {
      propagation: 0.65,
      cache,
    });
    assert.equal(reused.stats.coefficientMisses, 0);
    // Repeat with one relationship update. Other groups' coefficients remain reusable.
    await revise(f.memory, f.groups[0].ref, {
      text: 'changed collection',
      links: { member: f.leaves.slice(0, 6).map((l) => l.ref) },
    });
    await prepare(f.host, f.binding);
    const updated = await acquire(f, 'other context');
    const updatePlan = compileComposition(updated.seeds.length, updated.edges, updated.regions, {
      propagation: 0.65,
      cache,
    });
    assert.deepEqual(
      second.state.nodes.map((c) => c.revision.atomId),
      updated.state.nodes.map((c) => c.revision.atomId),
    );
    const correctedUpdate = updatePlan.correct(
      updated.seeds,
      reused.solve(second.seeds).rawScores(),
    );
    const expected = propagate(updated.seeds, updated.edges, f.options.ranking);
    assert.ok(expected.converged);
    const updateError = Math.max(
      0,
      ...updatePlan
        .solve(updated.seeds)
        .scores()
        .map((v, i) => Math.abs(v - expected.scores[i])),
    );
    assert.ok(
      updateError < 1e-12 &&
        updatePlan.stats.coefficientMisses > 0 &&
        updatePlan.stats.coefficientHits > 0,
    );
    const correctedUpdateError = Math.max(
      0,
      ...correctedUpdate.scores().map((v, i) => Math.abs(v - expected.scores[i])),
    );
    assert.ok(correctedUpdateError < 1e-12);
    runs.push({
      adapter,
      nodes: graph.seeds.length,
      directedEdges: graph.edges.length,
      plan: compiled.stats,
      acquisitionMs,
      coldCompileMs,
      fullFactorCompileMs,
      medianPerQueryMs: {
        referenceConverged: referenceMs,
        currentFiniteIteration: defaultIterationsMs,
        composedAllScores: foldedMs,
        composedAdaptiveTop5: adaptiveMs,
        residualCorrectionAllScores: correctionMs,
        fullFactorAllScores: fullFactorMs,
        recompileWithCache: rebuildWithCacheMs,
      },
      numericSpeedupAgainstConverged: referenceMs / foldedMs,
      numericSpeedupAgainstFinite: defaultIterationsMs / foldedMs,
      referenceIterations,
      maximumScoreError,
      defaultMaximumScoreError,
      contextChange: { ...reused.stats, correctionMaximumError },
      adaptiveTop5: {
        certificateScope: 'compiled-numeric-scores',
        recoveredNodes: [
          Math.min(...adaptive.map((a) => a.recoveredNodes)),
          Math.max(...adaptive.map((a) => a.recoveredNodes)),
        ],
        closedBlocks: [
          Math.min(...adaptive.map((a) => a.closedBlocks)),
          Math.max(...adaptive.map((a) => a.closedBlocks)),
        ],
        medianNumericCoefficientsVisited: median(adaptive.map((a) => a.numericCoefficientsVisited)),
        medianBoundCoefficientsVisited: median(adaptive.map((a) => a.boundCoefficientsVisited)),
        allSelectedIndicesAndScoresMatchFullRecovery: true,
      },
      relationshipChange: {
        ...updatePlan.stats,
        maximumScoreError: updateError,
        correctedMaximumScoreError: correctedUpdateError,
      },
      packedTextAndOrderIdentical: true,
      graphAcquisitionsSaved: 0,
    });
  } finally {
    storage.close();
  }
}
const record = {
  at: new Date().toISOString(),
  node: process.version,
  libraryCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sha256: Object.fromEntries(
    [
      'evaluator.mjs',
      'fixture.mjs',
      'numeric.test.mjs',
      'adapters.test.mjs',
      'evaluate.mjs',
      '../../src/core/ranking.ts',
      '../../src/client/ranking.ts',
    ].map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest('hex'),
    ]),
  ),
  kind: 'experimental compositional evaluation on real Atom storage; not a default evaluator or novelty claim',
  reference:
    'Same authorized, current, bounded graph; propagation=0.65; converged L1 iteration tolerance=1e-13',
  timing:
    'Median of 7 batches of 40 numeric queries after 8 warm-ups; cached recompilation uses 8 repetitions; excludes embedding, graph acquisition and packing',
  runs,
  decision:
    'Keep default read/search unchanged. Numeric reuse works, but graph acquisition is still full and current finite-iteration semantics differ.',
  limits: [
    'Synthetic graph and fixed encoder; no LLM or paid calls',
    'Dense initial matrix and boundary LU are bounded prototypes, not a large-scale sparse solver',
    'Computational regions are explicit fixture hints; arbitrary semantic membership is not inferred',
    'Top-k bounds enclose floating reconstruction within the compiled graph, not exact PPR or all memory',
    'Node-recovery budget excludes RHS/boundary solves, bound calculation and full graph acquisition',
    'Ordinary packing comparison still recovers all scores; no output-cost-aware expansion or local-push comparison',
    'These results do not establish research novelty or end-to-end speedup',
  ],
};
if (process.argv.includes('--record'))
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
