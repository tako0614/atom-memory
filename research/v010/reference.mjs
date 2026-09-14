import assert from 'node:assert/strict';
import { snapshotUse } from '../../dist/client/activation.js';
import { seedScore, activationOptions } from '../../dist/core/ranking.js';
import { ampleBudget } from './setup.mjs';

/** Dense independent oracle, only for small acquired graphs and outside measured work. */
export function referenceActivation(seeds, edges, propagation = 0.5) {
  const n = seeds.length;
  if (!n) return { activation: [], scores: [] };
  const weights = Array.from({ length: n }, () => new Float64Array(n));
  for (const { from, to, weight } of edges) weights[from][to] += weight;
  const a = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n + 1);
    row[i] = 1;
    row[n] = seeds[i];
    return row;
  });
  for (let from = 0; from < n; from++) {
    const total = weights[from].reduce((sum, weight) => sum + weight, 0);
    if (!total) continue;
    for (let to = 0; to < n; to++) a[to][from] -= (propagation * weights[from][to]) / total;
  }
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-14) throw new Error('Singular reference system');
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = column + 1; row < n; row++) {
      const factor = a[row][column] / a[column][column];
      for (let j = column; j <= n; j++) a[row][j] -= factor * a[column][j];
    }
  }
  const activation = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let value = a[row][n];
    for (let j = row + 1; j < n; j++) value -= a[row][j] * activation[j];
    activation[row] = value / a[row][row];
  }
  const total = activation.reduce((sum, value) => sum + value, 0);
  return { activation, scores: activation.map((value) => (total > 0 ? value / total : 0)) };
}

export function checkNumeric(variant, nodes, edges, candidates, signals, evaluatedAt, errorBound) {
  const session = variant.engine.session(variant.binding, { budget: ampleBudget });
  const config = activationOptions(variant.engine.options.activation);
  const usage = snapshotUse(
    variant.engine,
    session,
    nodes.map((node) => node.revision),
    evaluatedAt,
  );
  const seeds = nodes.map(({ revision }, i) => {
    const body = variant.engine.indexedBody(revision);
    return seedScore(body.text, body.vectors, signals) * usage.boosts[i];
  });
  const indices = new Map(nodes.map(({ revision }, i) => [revision.revisionId, i]));
  const directed = edges.flatMap((edge) => {
    const weights = config.relations[edge.role] ?? { forward: 1, reverse: 1 };
    const from = indices.get(edge.from),
      to = indices.get(edge.to);
    return [
      { from, to, weight: weights.forward },
      { from: to, to: from, weight: weights.reverse },
    ];
  });
  const reference = referenceActivation(seeds, directed, config.propagation);
  const scores = new Map(
    candidates.map((candidate) => [candidate.revision.revisionId, candidate.score]),
  );
  const errorL1 = nodes.reduce(
    (sum, { revision }, i) =>
      sum + Math.abs((scores.get(revision.revisionId) ?? 0) - reference.scores[i]),
    0,
  );
  assert.ok(errorL1 <= errorBound + 1e-12, `oracle error ${errorL1} exceeds ${errorBound}`);
  return errorL1;
}
