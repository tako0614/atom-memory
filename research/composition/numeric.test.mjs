import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition, CompositionCache } from './evaluator.mjs';
import { propagate } from '../../dist/core/ranking.js';

const error = (a, b) => Math.max(0, ...a.map((v, i) => Math.abs(v - b[i])));
const reference = (seeds, edges, propagation) => {
  const result = propagate(seeds, edges, { propagation, tolerance: 1e-13, maxIterations: 1000 });
  assert.ok(result.converged, 'the iterative reference must reach its stopping criterion');
  return result.scores;
};
function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
function modules() {
  const edges = [];
  for (const ids of [
    [0, 1, 2, 3],
    [3, 4, 5, 6],
  ])
    for (const from of ids)
      for (const to of ids) if (from !== to) edges.push({ from, to, weight: (from + to + 1) / 3 });
  edges.push({ from: 3, to: 7, weight: 0.4 });
  return edges;
}

test('composition agrees with converged propagation across 90 fixed graphs and elimination orders', () => {
  const rng = random(20260912);
  let folded = 0,
    maximum = 0;
  for (let sample = 0; sample < 90; sample++) {
    const n = 5 + Math.floor(rng() * 14),
      edges = [];
    for (let from = 0; from < n; from++)
      for (let to = 0; to < n; to++)
        if (rng() < 0.18 && from !== sample % n) edges.push({ from, to, weight: rng() * 3 });
    const seeds = Array.from({ length: n }, () => (rng() < 0.5 ? rng() : 0));
    seeds[sample % n] += 1;
    const alpha = [0, 0.25, 0.7, 0.95][sample % 4];
    const groups = [
      Array.from({ length: Math.ceil(n / 2) }, (_, i) => i),
      Array.from({ length: n - Math.floor(n / 2) + 1 }, (_, i) => i + Math.floor(n / 2) - 1),
      Array.from({ length: n }, (_, i) => i),
    ];
    const expected = reference(seeds, edges, alpha);
    for (const regions of [groups, [...groups].reverse(), []]) {
      const compiled = compileComposition(n, edges, regions, { propagation: alpha });
      const query = compiled.solve(seeds);
      const result = compiled.solve(seeds).scores();
      withinBounds(query, result);
      const selected = query.topK(Math.min(3, n));
      assert.equal(selected.certified, true);
      assert.deepEqual(selected.items, order(result).slice(0, Math.min(3, n)));
      maximum = Math.max(maximum, error(result, expected));
      assert.ok(error(result, expected) < 2e-12, `sample ${sample}`);
      assert.ok(Math.abs(result.reduce((sum, v) => sum + v, 0) - 1) < 2e-13);
      folded += compiled.stats.eliminated;
    }
  }
  assert.ok(folded > 90, 'comparison actually exercises folded interiors');
  assert.ok(maximum < 2e-12);
});

test('overlapping regions retain a single shared port; duplicate membership is not duplicated mass', () => {
  const edges = modules(),
    seeds = [1, 0.3, 0, 0, 0, 0.7, 0, 0];
  const groups = [
    [0, 1, 2, 3],
    [3, 4, 5, 6],
    [0, 1, 2, 3, 4, 5, 6, 7],
  ];
  const folded = compileComposition(8, edges, groups);
  assert.equal(folded.stats.sharedPorts, 1);
  assert.ok(folded.stats.eliminated >= 6);
  const query = folded.solve(seeds);
  const expected = reference(seeds, edges, 0.5);
  assert.ok(Math.abs(query.score(3) - expected[3]) < 1e-12);
  assert.equal(
    query.stats.recoveredNodes,
    0,
    'the shared boundary is read without opening interiors',
  );
  assert.ok(Math.abs(query.score(1) - expected[1]) < 1e-12);
  assert.ok(query.stats.recoveredNodes < folded.stats.eliminated);
  assert.ok(error(query.scores(), expected) < 1e-12);
  const duplicated = compileComposition(8, edges, [...groups, [0, 1, 1, 2, 3]]).solve(seeds);
  assert.ok(error(duplicated.scores(), expected) < 1e-12);
});

test('query changes reuse query-independent operators even with dangling redistribution and internal seeds', () => {
  const edges = modules(),
    cache = new CompositionCache();
  const groups = [
    [0, 1, 2, 3],
    [3, 4, 5, 6],
  ];
  compileComposition(8, edges, groups, { cache });
  const again = compileComposition(8, edges, groups, { cache });
  assert.equal(again.stats.coefficientMisses, 0);
  assert.equal(again.stats.coefficientHits, again.stats.blocks + 1);
  for (let i = 0; i < 8; i++) {
    const seeds = Array(8).fill(0);
    seeds[i] = 1;
    assert.ok(error(again.solve(seeds).scores(), reference(seeds, edges, 0.5)) < 1e-12);
  }
  assert.deepEqual(again.solve(Array(8).fill(0)).scores(), Array(8).fill(0));
});

test('a parent composes child interfaces and recovers an internal score through nested operators', () => {
  const edges = [];
  for (const members of [
    [0, 1, 2],
    [3, 4, 5, 6],
  ])
    for (const from of members)
      for (const to of members)
        if (from !== to) edges.push({ from, to, weight: from + 2 * to + 1 });
  edges.push(
    { from: 2, to: 3, weight: 2 },
    { from: 3, to: 2, weight: 1 },
    { from: 6, to: 7, weight: 1 },
  );
  const compiled = compileComposition(8, edges, [
    [0, 1, 2],
    [3, 4, 5, 6],
    [0, 1, 2, 3, 4, 5, 6],
  ]);
  assert.equal(compiled.stats.blocks, 3);
  assert.equal(compiled.stats.sharedPorts, 0, 'nested ownership is not overlapping ownership');
  assert.equal(compiled.stats.boundary, 2);
  const seeds = [1, 0, 0, 0, 0.3, 0, 0.2, 0],
    expected = reference(seeds, edges, 0.5);
  const query = compiled.solve(seeds);
  assert.ok(Math.abs(query.score(7) - expected[7]) < 1e-12);
  assert.equal(query.stats.recoveredNodes, 0);
  assert.ok(Math.abs(query.score(0) - expected[0]) < 1e-12);
  assert.ok(query.stats.recoveredNodes < compiled.stats.eliminated);
  assert.ok(error(query.scores(), expected) < 1e-12);
});

test('local relationship and boundary-degree changes invalidate affected operators and retain others', () => {
  const edges = modules(),
    cache = new CompositionCache();
  const groups = [
    [0, 1, 2, 3],
    [3, 4, 5, 6],
  ];
  const seeds = [1, 0.1, 0.7, 0, 0.2, 0, 0, 0];
  const first = compileComposition(8, edges, groups, { cache }).solve(seeds).scores();
  // This changes an outgoing denominator in the left region without changing
  // the right region's transition coefficients.
  const changed = edges.map((e) =>
    e.from === 0 && e.to === 1 ? { ...e, weight: e.weight * 7 } : e,
  );
  const next = compileComposition(8, changed, groups, { cache });
  assert.ok(next.stats.coefficientHits > 0);
  assert.ok(next.stats.coefficientMisses > 0);
  assert.ok(error(next.solve(seeds).scores(), reference(seeds, changed, 0.5)) < 1e-12);
  assert.ok(error(next.solve(seeds).scores(), first) > 1e-4);
  const boundaryChange = [...changed, { from: 3, to: 7, weight: 8 }];
  const boundary = compileComposition(8, boundaryChange, groups, { cache });
  assert.ok(boundary.stats.coefficientMisses > 0);
  assert.ok(error(boundary.solve(seeds).scores(), reference(seeds, boundaryChange, 0.5)) < 1e-12);
});

test('dense interfaces remain expanded and a bounded cache can evict without changing results', () => {
  const edges = [];
  for (let i = 1; i <= 8; i++) {
    edges.push({ from: 0, to: i, weight: 1 }, { from: i, to: 0, weight: 1 });
    edges.push({ from: i, to: i + 8, weight: 1 });
  }
  const seeds = Array(17).fill(0);
  seeds[0] = 1;
  const plan = compileComposition(17, edges, [Array.from({ length: 9 }, (_, i) => i)]);
  assert.equal(plan.stats.eliminated, 0);
  assert.equal(plan.stats.skipped, 1);
  assert.ok(error(plan.solve(seeds).scores(), reference(seeds, edges, 0.5)) < 1e-12);
  const cache = new CompositionCache(40);
  const grouped = compileComposition(
    8,
    modules(),
    [
      [0, 1, 2, 3],
      [3, 4, 5, 6],
    ],
    { cache },
  );
  const changed = compileComposition(8, modules(), [[0, 1, 2, 3]], { cache, propagation: 0.8 });
  assert.ok(cache.stats.evictions > 0);
  assert.ok(
    error(
      grouped.solve([1, 0, 0, 0, 0, 0, 0, 0]).scores(),
      reference([1, 0, 0, 0, 0, 0, 0, 0], modules(), 0.5),
    ) < 1e-12,
  );
  assert.ok(
    error(
      changed.solve([1, 0, 0, 0, 0, 0, 0, 0]).scores(),
      reference([1, 0, 0, 0, 0, 0, 0, 0], modules(), 0.8),
    ) < 1e-12,
  );
});

test('composition rejects malformed input and supports cancellation during compile and solve', () => {
  for (const fn of [
    () => compileComposition(2, [{ from: 2, to: 0, weight: 1 }], []),
    () => compileComposition(2, [{ from: 0, to: 0, weight: NaN }], []),
    () => compileComposition(2, [], [[3]]),
    () => compileComposition(2, [], [], { propagation: 1 }),
    () => compileComposition(2, [], []).solve([1, -1]),
    () => compileComposition(2, [], []).solve([1]),
    () => new CompositionCache(-1),
  ])
    assert.throws(fn, { code: 'INVALID_INPUT' });
  const stop = new Error('stopped');
  assert.throws(
    () =>
      compileComposition(2, [], [[0, 1]], {
        check: () => {
          throw stop;
        },
      }),
    stop,
  );
  let cancelled = false;
  const compiled = compileComposition(2, [], [[0, 1]], {
    check: () => {
      if (cancelled) throw stop;
    },
  });
  cancelled = true;
  assert.throws(() => compiled.solve([1, 0]), stop);
  assert.deepEqual(compileComposition(0, [], []).solve([]).scores(), []);
});

const order = (scores) =>
  scores
    .map((score, index) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

function withinBounds(query, expected) {
  const bounds = query.bounds();
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      bounds[i][0] <= expected[i] && expected[i] <= bounds[i][1],
      `node ${i}: ${bounds[i]} must contain ${expected[i]}`,
    );
  }
}

test('120 context and graph corrections match fresh solves; signed residual bounds enclose lazy recovery', () => {
  const rng = random(20260913);
  for (let sample = 0; sample < 120; sample++) {
    const edges = modules();
    if (sample % 2) edges.push({ from: 7, to: sample % 7, weight: rng() });
    const regions = [
      [0, 1, 2, 3],
      [3, 4, 5, 6],
      [0, 1, 2, 3, 4, 5, 6, 7],
    ];
    const alpha = [0, 0.25, 0.7, 0.95][sample % 4];
    const first = compileComposition(8, edges, regions, { propagation: alpha });
    let old = first.solve(Array.from({ length: 8 }, () => rng())).rawScores();
    for (let update = 0; update < 4; update++) {
      const changed = edges.map((edge, i) =>
        i === sample % edges.length ? { ...edge, weight: update % 2 ? 0 : rng() * 4 } : edge,
      );
      const seeds = Array.from({ length: 8 }, () => (rng() < 0.5 ? rng() : 0));
      seeds[update] += 1;
      const plan = compileComposition(8, changed, regions, { propagation: alpha });
      const corrected = plan.correct(seeds, old),
        fresh = plan.solve(seeds).scores();
      const sameCorrection = plan.correct(seeds, old).scores();
      withinBounds(corrected, sameCorrection);
      const partial = corrected.topK(3, { maxRecovered: update });
      assert.ok(partial.recoveredNodes <= update);
      withinBounds(corrected, sameCorrection);
      const resumed = corrected.topK(3);
      assert.equal(resumed.certified, true);
      assert.equal(resumed.certificateScope, 'compiled-numeric-scores');
      assert.deepEqual(resumed.items, order(sameCorrection).slice(0, 3));
      assert.ok(error(corrected.scores(), fresh) < 1e-12);
      assert.ok(error(corrected.scores(), reference(seeds, changed, alpha)) < 2e-12);
      old = corrected.rawScores();
    }
    assert.deepEqual(first.correct(Array(8).fill(0), old).scores(), Array(8).fill(0));
  }
});

test('adaptive selection can certify a winner without opening unrelated regions and resumes under budget', () => {
  // Two disconnected structures. The internal direct match must survive folding.
  const edges = [
    { from: 0, to: 1, weight: 1 },
    { from: 1, to: 0, weight: 1 },
    { from: 2, to: 3, weight: 1 },
    { from: 3, to: 2, weight: 1 },
  ];
  const plan = compileComposition(4, edges, [
    [0, 1],
    [2, 3],
  ]);
  assert.equal(plan.stats.boundary, 0);
  const query = plan.solve([1, 0, 0, 0]);
  const expected = plan.solve([1, 0, 0, 0]).scores();
  withinBounds(query, expected);
  const closed = query.topK(1, { maxRecovered: 1 });
  assert.equal(closed.certified, false);
  assert.equal(closed.recoveredNodes, 0, 'a whole block exceeding the budget stays closed');
  const selected = query.topK(1, { maxRecovered: 2 });
  assert.equal(selected.certified, true);
  assert.equal(selected.recoveredNodes, 2);
  assert.equal(selected.closedBlocks, 1);
  assert.deepEqual(selected.items, order(expected).slice(0, 1));
  assert.ok(selected.unseenUpper < selected.items[0].score);
  const condition = query.topK(1, { maxRecovered: 2, required: [3] });
  assert.equal(condition.requiredComplete, false);
  assert.equal(condition.certified, false);
  const completed = query.topK(1, { required: [3] });
  assert.equal(completed.requiredComplete, true);
  assert.equal(completed.certified, true);
  assert.equal(query.score(3), 0);
  // The other context moves the winner: no preference for the former winner.
  const next = plan.correct([0, 0, 1, 0], query.rawScores());
  assert.deepEqual(next.topK(1).items, order(plan.solve([0, 0, 1, 0]).scores()).slice(0, 1));
});

test('nested recovery charges shared dependencies once and conservative bounds handle ties and zero seeds', () => {
  const edges = modules(),
    regions = [
      [0, 1, 2, 3],
      [3, 4, 5, 6],
      [0, 1, 2, 3, 4, 5, 6, 7],
    ];
  const plan = compileComposition(8, edges, regions);
  for (const seeds of [
    Array(8).fill(1),
    Array(8).fill(0),
    [Number.MIN_VALUE, 0, 0, 0, 0, 0, 0, 0],
  ]) {
    const query = plan.solve(seeds),
      expected = plan.solve(seeds).scores();
    for (let budget = 0; budget <= 8; budget++) {
      withinBounds(query, expected);
      const result = query.topK(4, { maxRecovered: budget });
      assert.ok(result.recoveredNodes <= budget);
      if (result.certified) assert.deepEqual(result.items, order(expected).slice(0, 4));
    }
    assert.equal(query.topK(4).certified, true);
  }
  assert.deepEqual(compileComposition(0, [], []).solve([]).topK(0).items, []);
  for (const fn of [
    () => plan.correct(Array(8).fill(1), [1]),
    () => plan.correct(Array(8).fill(1), Array(8).fill(Infinity)),
    () => plan.solve(Array(8).fill(1)).topK(9),
    () => plan.solve(Array(8).fill(1)).topK(1, { maxRecovered: -1 }),
    () => plan.solve(Array(8).fill(1)).topK(1, { required: [8] }),
  ])
    assert.throws(fn, { code: 'INVALID_INPUT' });
});
