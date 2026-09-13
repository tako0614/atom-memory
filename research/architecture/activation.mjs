// Algebra checks for the required activation-input design. No production API changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { propagate } from '../../dist/core/ranking.js';
const normalize = (values) => {
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map((value) => (sum ? value / sum : 0));
};
function solve(b, edges, alpha) {
  let a = [...b];
  for (let k = 0; k < 10000; k++) {
    const next = [...b];
    for (const edge of edges) next[edge.to] += alpha * edge.weight * a[edge.from];
    const difference = next.reduce((sum, value, i) => sum + Math.abs(value - a[i]), 0);
    a = next;
    if (difference < 1e-13) return a;
  }
  throw Error('Raw reference failed to converge');
}
let seed = 9;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
let maximumPprDifference = 0;
for (let sample = 0; sample < 120; sample++) {
  const n = 8 + (sample % 12),
    alpha = [0, 0.2, 0.5, 0.8][sample % 4],
    edges = [];
  for (let from = 0; from < n; from++) {
    const targets = [];
    if (random() < 0.8)
      for (let to = 0; to < n; to++) if (random() < 0.3) targets.push({ to, weight: random() });
    const total = targets.reduce((sum, x) => sum + x.weight, 0);
    for (const target of targets)
      edges.push({ from, to: target.to, weight: target.weight / total });
  }
  const m = Array.from({ length: n }, () => random());
  const b = m.map((x) => x * (1 + 0.3 * random()));
  const base = solve(m, edges, alpha),
    boosted = solve(b, edges, alpha);
  const r0 = normalize(base),
    r1 = normalize(boosted);
  for (let i = 0; i < n; i++) {
    assert.ok(boosted[i] >= base[i] - 1e-12);
    assert.ok(boosted[i] <= 1.3 * base[i] + 1e-12);
    assert.ok(r1[i] >= r0[i] / 1.3 - 1e-12);
    assert.ok(r1[i] <= 1.3 * r0[i] + 1e-12);
  }
  const actual = propagate(b, edges, {
    propagation: alpha,
    maxIterations: 1000,
    tolerance: 1e-13,
  }).scores;
  maximumPprDifference = Math.max(
    maximumPprDifference,
    ...actual.map((value, i) => Math.abs(value - r1[i])),
  );
}
assert.ok(maximumPprDifference < 1e-12);
assert.deepEqual(solve([0, 0], [{ from: 0, to: 1, weight: 1 }], 0.5), [0, 0]);
const topOne = (input) => {
  const winner = input.indexOf(Math.max(...input));
  return normalize(input.map((value, i) => (i === winner ? value : 0)));
};
const truncation = {
  m: [1, 0.9],
  b: [1, 1.17],
  base: topOne([1, 0.9]),
  boosted: topOne([1, 1.17]),
};
assert.equal(truncation.base[1], 0);
assert.equal(truncation.boosted[1], 1);
const halfLife = 7,
  events = Array.from({ length: 100 }, (_, i) => ({ at: i / 3, weight: random() }));
let h = 0,
  at = 0;
for (const event of events) {
  h = h * 2 ** (-(event.at - at) / halfLife) + event.weight;
  at = event.at;
}
const direct = events.reduce(
  (sum, event) => sum + event.weight * 2 ** (-(at - event.at) / halfLife),
  0,
);
assert.ok(Math.abs(h - direct) < 1e-12);
// K(age)=1/(1+age): identical scalar h at the same time, different future h.
const arbitraryKernel = { now: [1 / (1 + 0), 2 / (1 + 1)], later: [1 / (1 + 1), 2 / (1 + 2)] };
assert.equal(arbitraryKernel.now[0], arbitraryKernel.now[1]);
assert.notEqual(arbitraryKernel.later[0], arbitraryKernel.later[1]);
const files = ['src/core/ranking.ts', 'research/architecture/activation.mjs'];
const result = {
  scope:
    'Algebra and counterexamples, not retrieval quality, biological fidelity, or a new public activation API.',
  cases: 120,
  maximumPprDifference,
  normalizedExample: { base: normalize([1, 1]), boosted: normalize([1.3, 1]) },
  seedTruncationCounterexample: truncation,
  exponentialAggregationDifference: Math.abs(h - direct),
  arbitraryKernelCounterexample: arbitraryKernel,
  sourceSha256: Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(new URL(`../../${file}`, import.meta.url)))
        .digest('hex'),
    ]),
  ),
};
if (process.argv.includes('--record'))
  writeFileSync(
    new URL('activation-results.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
console.log(JSON.stringify(result, null, 2));
