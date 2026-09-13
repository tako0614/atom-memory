import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition } from './evaluator.mjs';
import { compileLinear } from './linear.mjs';
import { WorkBudget } from './work.mjs';

test('sparse flat and heap push agree with the fixed graph after query and edge changes', () => {
  let seed = 17;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 32; sample++) {
    const n = 8 + (sample % 9),
      alpha = [0, 0.2, 0.65, 0.95][sample % 4];
    const edges = [];
    for (let from = 0; from < n - 1; from++)
      for (let to = 0; to < n; to++) if (random() < 0.2) edges.push({ from, to, weight: random() });
    const seeds = Array.from({ length: n }, () => random());
    const old = compileComposition(n, edges, [], { propagation: alpha }).solve(seeds).rawScores();
    edges.push({ from: 0, to: n - 1, weight: 5 });
    seeds[sample % n] += 2;
    const expected = compileComposition(n, edges, [], { propagation: alpha }).solve(seeds).scores();
    for (const mode of ['flat', 'push'])
      for (const previousRaw of [undefined, old]) {
        const work = new WorkBudget(10_000_000),
          q = compileLinear(n, edges, alpha).query(seeds, { mode, previousRaw, spend: work.take });
        for (let step = 0; step < 2000; step++) {
          const bounds = q.bounds();
          expected.forEach((v, i) =>
            assert.ok(bounds[i][0] <= v + 1e-14 && v - 1e-14 <= bounds[i][1]),
          );
          if (q.stats.rawErrorL1Upper < 1e-11) break;
          q.refine();
        }
        assert.ok(q.stats.rawErrorL1Upper < 1e-11);
        expected.forEach((v, i) => assert.ok(Math.abs(v - q.score(i)) < 1e-10));
      }
  }
});

test('work budget pauses push atomically and supports more work without losing the residual', () => {
  const edges = [
    { from: 0, to: 1, weight: 1 },
    { from: 1, to: 0, weight: 1 },
  ];
  const work = new WorkBudget(10),
    q = compileLinear(2, edges, 0.9).query([1, 0], { spend: work.take });
  assert.throws(() => q.refine(), { code: 'BUDGET_EXHAUSTED' });
  assert.ok(work.used <= 10);
  work.extend(100000);
  for (let i = 0; i < 50; i++) q.refine();
  const expected = compileComposition(2, edges, [], { propagation: 0.9 }).solve([1, 0]).scores();
  expected.forEach((v, i) => assert.ok(Math.abs(v - q.score(i)) < 1e-12));
});
