import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger, defaultBudget } from '../dist/core/budget.js';
import { evaluateActivation } from '../dist/core/evaluation.js';
import { activationOptions, cosine, retrievalOptions, seedScore } from '../dist/core/ranking.js';

function evaluate(seeds, edges, options = {}) {
  const ledger = new BudgetLedger({
    ...defaultBudget,
    maxEvaluationWork: options.maxEvaluationWork ?? defaultBudget.maxEvaluationWork,
  });
  const result = evaluateActivation(seeds, edges, {
    propagation: options.propagation ?? 0.5,
    ids: options.ids ?? seeds.map((_, index) => `node-${index}`),
    ledger,
    ...(options.initial === undefined ? {} : { initial: options.initial }),
  });
  assert.equal(result.diagnostics.work, ledger.usage().maxEvaluationWork);
  assert.ok(result.diagnostics.work <= ledger.limits.maxEvaluationWork);
  return result;
}

function denseReference(seeds, edges, propagation) {
  const size = seeds.length;
  const maximum = Array(size).fill(0);
  for (const edge of edges) maximum[edge.from] = Math.max(maximum[edge.from], edge.weight);
  const denominators = Array(size).fill(0);
  for (const edge of edges)
    if (maximum[edge.from]) denominators[edge.from] += edge.weight / maximum[edge.from];
  const matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
  for (const edge of edges)
    if (edge.weight && propagation)
      matrix[edge.to][edge.from] -=
        propagation * (edge.weight / maximum[edge.from] / denominators[edge.from]);
  const values = [...seeds];
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++)
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [values[column], values[pivot]] = [values[pivot], values[column]];
    for (let row = column + 1; row < size; row++) {
      const factor = matrix[row][column] / matrix[column][column];
      for (let next = column; next < size; next++)
        matrix[row][next] -= factor * matrix[column][next];
      values[row] -= factor * values[column];
    }
  }
  const activation = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    let value = values[row];
    for (let column = row + 1; column < size; column++)
      value -= matrix[row][column] * activation[column];
    activation[row] = value / matrix[row][row];
  }
  const scale = Math.max(0, ...activation);
  const scaled = scale ? activation.map((value) => value / scale) : activation;
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return {
    activation,
    scores: scaled.map((value) => (total ? value / total : 0)),
  };
}

const l1 = (left, right) =>
  left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0);

test('zero, dangling, cycles, and shared descendants follow a=b+T^T a', () => {
  const zero = evaluate(
    [0, 0],
    [
      { from: 0, to: 1, weight: 1 },
      { from: 1, to: 0, weight: 1 },
    ],
  );
  assert.deepEqual(zero.activation, [0, 0]);
  assert.deepEqual(zero.scores, [0, 0]);
  assert.deepEqual(zero.diagnostics, {
    converged: true,
    errorL1Upper: 0,
    work: zero.diagnostics.work,
  });

  const dangling = evaluate([1, 0], []);
  assert.deepEqual(dangling.activation, [1, 0]);
  assert.deepEqual(dangling.scores, [1, 0]);

  const oneWay = evaluate([1, 0], [{ from: 0, to: 1, weight: 1 }]);
  assert.deepEqual(oneWay.activation, [1, 0.5]);
  assert.deepEqual(oneWay.scores, [2 / 3, 1 / 3]);

  const cycle = evaluate(
    [1, 0],
    [
      { from: 0, to: 1, weight: 1 },
      { from: 1, to: 0, weight: 1 },
    ],
  );
  const exactCycle = [2 / 3, 1 / 3];
  assert.ok(l1(cycle.scores, exactCycle) <= cycle.diagnostics.errorL1Upper);
  assert.ok(Math.abs(cycle.activation[0] - 4 / 3) < 1e-12);
  assert.ok(Math.abs(cycle.activation[1] - 2 / 3) < 1e-12);

  const shared = evaluate(
    [1, 1, 0],
    [
      { from: 0, to: 2, weight: 1 },
      { from: 1, to: 2, weight: 1 },
    ],
  );
  assert.deepEqual(shared.activation, [1, 1, 1]);
  shared.scores.forEach((score) => assert.equal(score, 1 / 3));
});

test('dense references lie inside the reported normalized error certificate', () => {
  let state = 20260913;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 48; sample++) {
    const size = 3 + (sample % 8),
      propagation = [0.15, 0.5, 0.85][sample % 3],
      edges = [];
    for (let from = 0; from < size; from++)
      for (let to = 0; to < size; to++)
        if (random() < 0.28) edges.push({ from, to, weight: random() * 8 });
    const seeds = Array.from({ length: size }, () => (random() < 0.55 ? random() * 3 : 0));
    seeds[sample % size] += 1;
    const expected = denseReference(seeds, edges, propagation);
    const actual = evaluate(seeds, edges, { propagation });
    const difference = l1(actual.scores, expected.scores);
    assert.ok(
      difference <= actual.diagnostics.errorL1Upper + 2e-12,
      `sample ${sample}: ${difference} > ${actual.diagnostics.errorL1Upper}`,
    );
    assert.ok(actual.diagnostics.errorL1Upper <= 1e-6);
    assert.equal(actual.diagnostics.converged, true);
    actual.activation.forEach((value) => assert.ok(Number.isFinite(value) && value >= 0));
    actual.scores.forEach((value) => assert.ok(Number.isFinite(value) && value >= 0));
  }
});

test('raw activation is linear and bounded input boosts keep raw and normalized bounds', () => {
  const edges = [
    { from: 0, to: 1, weight: 2 },
    { from: 1, to: 2, weight: 1 },
    { from: 2, to: 0, weight: 3 },
    { from: 2, to: 1, weight: 1 },
  ];
  const base = evaluate([1, 0.4, 0.8], edges, { propagation: 0.7 });
  const doubled = evaluate([2, 0.8, 1.6], edges, { propagation: 0.7 });
  const boosted = evaluate([1.3, 0.44, 0.96], edges, { propagation: 0.7 });
  for (let index = 0; index < base.activation.length; index++) {
    assert.ok(Math.abs(doubled.activation[index] - 2 * base.activation[index]) < 1e-8);
    assert.ok(boosted.activation[index] >= base.activation[index] - 1e-8);
    assert.ok(boosted.activation[index] <= 1.3 * base.activation[index] + 1e-8);
    assert.ok(boosted.scores[index] >= base.scores[index] / 1.3 - 1e-8);
    assert.ok(boosted.scores[index] <= 1.3 * base.scores[index] + 1e-8);
  }
});

test('signed warm correction survives changed seeds and graphs without going negative', () => {
  const firstGraph = [{ from: 0, to: 1, weight: 1 }];
  const changedGraph = [
    { from: 0, to: 1, weight: 1 },
    { from: 1, to: 0, weight: 1 },
  ];
  const old = evaluate([4, 0], firstGraph, { propagation: 0.7 });
  const warm = evaluate([0, 1], changedGraph, {
    propagation: 0.7,
    initial: old.activation,
  });
  const fresh = evaluate([0, 1], changedGraph, { propagation: 0.7 });
  assert.ok(
    warm.activation[0] < old.activation[0],
    'the warm solve must apply a negative correction',
  );
  warm.activation.forEach((value) => assert.ok(value >= 0));
  assert.ok(
    l1(warm.scores, fresh.scores) <= warm.diagnostics.errorL1Upper + fresh.diagnostics.errorL1Upper,
  );

  const excessive = evaluate([1, 0], changedGraph, {
    propagation: 0.7,
    initial: [1e6, 0],
  });
  excessive.activation.forEach((value) => assert.ok(value >= 0));
  assert.equal(excessive.diagnostics.converged, true);
});

test('the final residual is reserved and low budget returns a finite approximation', () => {
  const edges = [
    { from: 0, to: 1, weight: 1 },
    { from: 1, to: 0, weight: 1 },
  ];
  assert.throws(() => evaluate([1, 0], edges, { propagation: 0.9, maxEvaluationWork: 101 }), {
    code: 'BUDGET_EXHAUSTED',
  });
  const partial = evaluate([1, 0], edges, {
    propagation: 0.9,
    maxEvaluationWork: 102,
  });
  assert.equal(partial.diagnostics.converged, false);
  assert.equal(partial.diagnostics.errorL1Upper, 2);
  assert.deepEqual(partial.activation, [1, 0]);
  partial.scores.forEach((value) => assert.ok(Number.isFinite(value)));
  const exact = [1 / 1.9, 0.9 / 1.9];
  assert.ok(l1(partial.scores, exact) <= partial.diagnostics.errorL1Upper);
});

test('equal residual priority uses IDs and charges heap selection work', () => {
  const result = evaluate(
    [1, 1, 0, 0],
    [
      { from: 0, to: 2, weight: 1 },
      { from: 1, to: 3, weight: 1 },
    ],
    {
      ids: ['seed-a', 'seed-b', 'z-target', 'a-target'],
      maxEvaluationWork: 200,
    },
  );
  assert.deepEqual(result.activation, [1, 1, 0, 0.5]);
  assert.equal(result.diagnostics.work, 200);
  assert.equal(result.diagnostics.converged, false);
});

test('stable scaling accepts huge finite weights and values, while unprovable inputs fail', () => {
  const hugeWeights = evaluate(
    [1, 0, 0],
    [
      { from: 0, to: 1, weight: Number.MAX_VALUE },
      { from: 0, to: 2, weight: Number.MAX_VALUE },
    ],
  );
  assert.deepEqual(hugeWeights.activation, [1, 0.25, 0.25]);
  assert.ok(l1(hugeWeights.scores, [2 / 3, 1 / 6, 1 / 6]) < 1e-14);

  const hugeSeeds = evaluate([Number.MAX_VALUE / 4, Number.MAX_VALUE / 8], []);
  assert.deepEqual(hugeSeeds.activation, [Number.MAX_VALUE / 4, Number.MAX_VALUE / 8]);
  assert.deepEqual(hugeSeeds.scores, [2 / 3, 1 / 3]);

  const invalidCases = [
    () => evaluate([NaN], []),
    () => evaluate([1], [{ from: 0, to: 1, weight: 1 }]),
    () => evaluate([1], [{ from: 0, to: 0, weight: Infinity }]),
    () => evaluate([1], [], { initial: [-1] }),
    () => evaluate([1, 0], [], { ids: ['same', 'same'] }),
    () => evaluate([1], [], { propagation: 1 }),
  ];
  invalidCases.forEach((run) => assert.throws(run, { code: 'INVALID_INPUT' }));

  assert.throws(
    () =>
      evaluate(
        [1, 0],
        Array.from({ length: 4 }, (_, index) => ({ from: 0, to: index % 2, weight: 1 })),
        { propagation: 1 - Number.EPSILON / 2 },
      ),
    { code: 'INVALID_INPUT' },
  );
});

test('0.6 option parsing and fixed seed scoring reject legacy or nonfinite knobs', () => {
  assert.deepEqual(activationOptions(), {
    halfLifeMs: 7 * 24 * 60 * 60 * 1000,
    maxBoost: 0.3,
    propagation: 0.5,
    relations: {},
  });
  assert.deepEqual(retrievalOptions(), {
    depth: 2,
    maxSeeds: 64,
    maxNodes: 512,
    maxEdges: 4096,
    maxScan: 10000,
  });
  assert.deepEqual(retrievalOptions({ maxSeeds: 10, maxNodes: 3 }), {
    depth: 2,
    maxSeeds: 3,
    maxNodes: 3,
    maxEdges: 4096,
    maxScan: 10000,
  });
  assert.deepEqual(
    activationOptions({ relations: { __proto__: { forward: 2 } } }).relations,
    {},
    'an object-literal prototype is not an own role',
  );
  const parsed = activationOptions({
    relations: Object.fromEntries([['__proto__', { forward: 2 }]]),
  });
  assert.deepEqual(Object.keys(parsed.relations), ['__proto__']);
  assert.deepEqual(parsed.relations.__proto__, { forward: 2, reverse: 1 });

  assert.equal(
    seedScore(
      'alpha',
      [[1, 0]],
      [
        { kind: 'context', text: 'alpha', vector: [1, 0] },
        { kind: 'thought', text: 'beta', vector: [0, 1] },
      ],
    ),
    0.5,
  );
  const repeated = [
    { kind: 'context', text: 'alpha' },
    { kind: 'observations', text: 'beta' },
  ];
  assert.equal(
    seedScore('alpha', undefined, repeated),
    seedScore('alpha', undefined, [...repeated, repeated[1]]),
  );
  assert.equal(
    cosine([Number.MAX_VALUE, Number.MAX_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE]),
    1,
  );

  for (const options of [
    { propagation: 1 },
    { halfLifeMs: 0 },
    { maxBoost: Infinity },
    { semantic: 1 },
  ])
    assert.throws(() => activationOptions(options), { code: 'INVALID_INPUT' });
  assert.throws(() => retrievalOptions({ maxScan: 10001 }), { code: 'INVALID_INPUT' });
  assert.throws(() => retrievalOptions({ tolerance: 1e-6 }), { code: 'INVALID_INPUT' });
});

test('a tiny finite warm state returns a bounded approximation instead of rejecting an overflowing error ratio', () => {
  const edges = [
    { from: 0, to: 1, weight: 1 },
    { from: 1, to: 0, weight: 1 },
  ];
  const initial = [1e-320, 1e-320];
  const partial = evaluate([1, 0], edges, { initial, maxEvaluationWork: 104 });
  assert.equal(partial.diagnostics.converged, false);
  assert.equal(partial.diagnostics.errorL1Upper, 2);
  assert.ok(partial.scores.every(Number.isFinite));
  assert.ok(l1(partial.scores, [2 / 3, 1 / 3]) <= partial.diagnostics.errorL1Upper);
  const settled = evaluate([1, 0], edges, { initial });
  assert.ok(settled.diagnostics.converged);
  assert.ok(l1(settled.scores, [2 / 3, 1 / 3]) <= settled.diagnostics.errorL1Upper);
});
