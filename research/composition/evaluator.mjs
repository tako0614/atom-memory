// Experimental numeric evaluator. Not a public API or the default read/search path.
// Input must be the same already-authorized, freshness-checked bounded graph as
// the reference evaluator. This cache never supplies graph membership or authority.
import { canonical, digest, fail } from '../../dist/core/util.js';
const zeros = (rows, columns) => Array.from({ length: rows }, () => Array(columns).fill(0));
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
// Outward intervals enclose reconstruction using these floating coefficients.
// They do not bound LU backward error or missed candidates outside this graph.
const bits = new DataView(new ArrayBuffer(8));
export function up(value) {
  if (value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
export const down = (value) => -up(-value);
function product(a, b) {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return values.some(Number.isNaN)
    ? [-Infinity, Infinity]
    : [down(Math.min(...values)), up(Math.max(...values))];
}
const span = (values) => [Math.min(...values), Math.max(...values)];
function factorize(matrix, check) {
  const lu = matrix.map((row) => [...row]),
    swaps = [];
  for (let k = 0; k < lu.length; k++) {
    check();
    let pivot = k;
    for (let i = k + 1; i < lu.length; i++)
      if (Math.abs(lu[i][k]) > Math.abs(lu[pivot][k])) pivot = i;
    if (!Number.isFinite(lu[pivot][k]) || Math.abs(lu[pivot][k]) < Number.EPSILON)
      fail('INVALID_INPUT', 'Numerically singular composition');
    swaps.push(pivot);
    [lu[k], lu[pivot]] = [lu[pivot], lu[k]];
    for (let i = k + 1; i < lu.length; i++) {
      lu[i][k] = lu[i][k] / lu[k][k];
      for (let j = k + 1; j < lu.length; j++) lu[i][j] = lu[i][j] - lu[i][k] * lu[k][j];
    }
  }
  return { lu, swaps };
}
function solve(factor, values, check) {
  const x = [...values],
    { lu, swaps } = factor;
  for (let k = 0; k < x.length; k++) [x[k], x[swaps[k]]] = [x[swaps[k]], x[k]];
  for (let i = 0; i < x.length; i++) {
    check();
    for (let j = 0; j < i; j++) x[i] = x[i] - lu[i][j] * x[j];
  }
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < x.length; j++) x[i] = x[i] - lu[i][j] * x[j];
    x[i] = x[i] / lu[i][i];
  }
  return x;
}
/** Bounded process-local cache of coefficients, independent of text and query.
 * Keys include the normalized interior and both interface matrices. A changed
 * outgoing denominator therefore invalidates affected operators automatically. */
export class CompositionCache {
  maxCells;
  entries = new Map();
  cells = 0;
  stats = { hits: 0, misses: 0, evictions: 0 };
  constructor(maxCells = 131072) {
    this.maxCells = maxCells;
    if (!Number.isSafeInteger(maxCells) || maxCells < 0) fail('INVALID_INPUT');
  }
  get footprint() {
    return { cells: this.cells, entries: this.entries.size, maxCells: this.maxCells };
  }
  obtain(key, cells, build) {
    const saved = this.entries.get(key);
    if (saved) {
      this.stats.hits++;
      this.entries.delete(key);
      this.entries.set(key, saved);
      return saved.value;
    }
    this.stats.misses++;
    const value = build();
    if (cells <= this.maxCells) {
      while (this.cells + cells > this.maxCells) {
        const first = this.entries.keys().next().value;
        this.cells -= this.entries.get(first).cells;
        this.entries.delete(first);
        this.stats.evictions++;
      }
      this.entries.set(key, { value, cells });
      this.cells += cells;
    }
    return value;
  }
  block(a, b, c, check) {
    const n = a.length,
      k = c.length;
    return this.obtain(
      `block:${digest(canonical([a, b, c]))}`,
      n * n + n + 2 * n * k + k * k + 2 * k,
      () => {
        const factor = factorize(a, check),
          transfer = zeros(n, k);
        for (let j = 0; j < k; j++) {
          const column = solve(
            factor,
            b.map((row) => row[j]),
            check,
          );
          for (let i = 0; i < n; i++) transfer[i][j] = column[i];
        }
        const schur = zeros(k, k);
        for (let i = 0; i < k; i++) {
          check();
          for (let j = 0; j < k; j++)
            for (let r = 0; r < n; r++) schur[i][j] = schur[i][j] + c[i][r] * transfer[r][j];
        }
        return {
          factor,
          transfer,
          incoming: c,
          schur,
          columns: Array.from({ length: k }, (_, j) => span(transfer.map((row) => row[j]))),
        };
      },
    );
  }
  boundary(a, check) {
    return this.obtain(`boundary:${digest(canonical(a))}`, a.length * a.length + a.length, () =>
      factorize(a, check),
    );
  }
}
/** Compile disjoint interiors; overlapping, incomparable regions share ports.
 * Regions are computational hints, not new Atoms, semantic equivalences, or a
 * required tree. Ancestor regions can eliminate a child's remaining interface. */
export function compileComposition(size, edges, regions, options = {}) {
  const alpha = options.propagation ?? 0.5,
    check = options.check ?? (() => {});
  const defaultSpend = options.spend ?? (() => {});
  const cache = options.cache ?? new CompositionCache();
  const maxInterior = options.maxInterior ?? 64,
    maxBoundary = options.maxBoundary ?? 32;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 1024 ||
    !Number.isFinite(alpha) ||
    alpha < 0 ||
    alpha >= 1 ||
    !Number.isSafeInteger(maxInterior) ||
    maxInterior < 1 ||
    maxInterior > 128 ||
    !Number.isSafeInteger(maxBoundary) ||
    maxBoundary < 0 ||
    maxBoundary > 128 ||
    regions.length > 1024
  )
    fail('INVALID_INPUT');
  const valid = (i) => {
    if (!Number.isSafeInteger(i) || i < 0 || i >= size) fail('INVALID_INPUT');
  };
  const outgoing = Array(size).fill(0);
  for (const edge of edges) {
    valid(edge.from);
    valid(edge.to);
    if (!Number.isFinite(edge.weight) || edge.weight < 0) fail('INVALID_INPUT');
    outgoing[edge.from] = outgoing[edge.from] + edge.weight;
    if (!Number.isFinite(outgoing[edge.from])) fail('INVALID_INPUT');
  }
  const matrix = zeros(size, size);
  for (let i = 0; i < size; i++) matrix[i][i] = 1;
  // Dangling columns remain zero in T. Personalization-dependent dangling
  // redistribution is recovered exactly by normalizing (I - alpha*T)^-1 s.
  for (const edge of edges)
    if (outgoing[edge.from])
      matrix[edge.to][edge.from] =
        matrix[edge.to][edge.from] - alpha * (edge.weight / outgoing[edge.from]);
  // Snapshot transitions: caller mutation must not change a compiled evaluator.
  const transitions = edges
    .filter((e) => outgoing[e.from] && e.weight)
    .map((e) => ({
      from: e.from,
      to: e.to,
      weight: alpha * (e.weight / outgoing[e.from]),
    }));
  const groups = regions.map((members) => {
    members.forEach(valid);
    return new Set(members);
  });
  const retained = new Set(options.retain ?? []);
  retained.forEach(valid);
  const subset = (a, b) => [...a].every((i) => b.has(i));
  for (let i = 0; i < groups.length; i++) {
    check();
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i],
        b = groups[j];
      if (!subset(a, b) && !subset(b, a)) for (const id of a) if (b.has(id)) retained.add(id);
    }
  }
  let alive = Array.from({ length: size }, (_, i) => i);
  const mass = Array(size).fill(1);
  const steps = [];
  const owner = Array(size).fill(-1);
  const stats = {
    eliminated: 0,
    blocks: 0,
    skipped: 0,
    boundary: size,
    sharedPorts: retained.size,
    coefficientHits: 0,
    coefficientMisses: 0,
  };
  const hits = cache.stats.hits,
    misses = cache.stats.misses;
  for (const group of groups) {
    check();
    const interior = alive.filter(
      (i) =>
        group.has(i) &&
        !retained.has(i) &&
        !alive.some((j) => !group.has(j) && (matrix[i][j] || matrix[j][i])),
    );
    if (!interior.length) {
      stats.skipped++;
      continue;
    }
    const inside = new Set(interior);
    const ports = alive.filter(
      (j) => !inside.has(j) && interior.some((i) => matrix[i][j] || matrix[j][i]),
    );
    const n = interior.length,
      k = ports.length;
    const incident = interior.reduce(
      (sum, i) => sum + alive.filter((j) => matrix[i][j] || matrix[j][i]).length,
      0,
    );
    // Conservative fill guard. This is a size heuristic, not a speed guarantee.
    if (n > maxInterior || k > maxBoundary || (k && k * k >= incident)) {
      stats.skipped++;
      continue;
    }
    const part = (rows, columns) => rows.map((i) => columns.map((j) => matrix[i][j]));
    const operator = cache.block(
      part(interior, interior),
      part(interior, ports),
      part(ports, interior),
      check,
    );
    const weights = interior.map((i) => mass[i]);
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++)
        matrix[ports[i]][ports[j]] = matrix[ports[i]][ports[j]] - operator.schur[i][j];
      mass[ports[i]] =
        mass[ports[i]] -
        dot(
          weights,
          operator.transfer.map((row) => row[i]),
        );
    }
    for (const i of interior) owner[i] = steps.length;
    steps.push({ interior, ports, operator, mass: weights });
    alive = alive.filter((i) => !inside.has(i));
    stats.eliminated += n;
    stats.blocks++;
  }
  const boundary = cache.boundary(
    alive.map((i) => alive.map((j) => matrix[i][j])),
    check,
  );
  stats.boundary = alive.length;
  stats.coefficientHits = cache.stats.hits - hits;
  stats.coefficientMisses = cache.stats.misses - misses;
  function input(seeds) {
    if (seeds.length !== size || seeds.some((v) => !Number.isFinite(v) || v < 0))
      fail('INVALID_INPUT');
    const total = seeds.reduce((sum, v) => sum + v, 0);
    if (!Number.isFinite(total)) fail('INVALID_INPUT');
    return { rhs: seeds.map((v) => (total ? v / total : 0)), nonzero: total > 0 };
  }
  function apply(
    inputRhs,
    nonzero,
    base = Array(size).fill(0),
    residualEdges = 0,
    spend = defaultSpend,
  ) {
    spend(size);
    const rhs = [...inputRhs];
    const query = {
      triangularSolves: 0,
      recoveredNodes: 0,
      coefficientsVisited: 0,
      boundCoefficientsVisited: 0,
      residualEdges,
      residualL1: inputRhs.reduce((s, v) => s + Math.abs(v), 0),
    };
    const zs = [];
    let constant = 0;
    for (const step of steps) {
      check();
      const values = step.interior.map((i) => rhs[i]);
      const present = values.some(Boolean);
      spend((present ? values.length * values.length : 0) + values.length);
      const z = present ? solve(step.operator.factor, values, check) : values;
      query.triangularSolves += present ? 1 : 0;
      query.coefficientsVisited += present ? values.length * values.length : 0;
      zs.push(z);
      constant += dot(step.mass, z);
      for (let i = 0; i < step.ports.length; i++) {
        spend(z.length);
        rhs[step.ports[i]] = rhs[step.ports[i]] - dot(step.operator.incoming[i], z);
        query.coefficientsVisited += z.length;
      }
    }
    spend(alive.length * alive.length + alive.length);
    const values = solve(
      boundary,
      alive.map((i) => rhs[i]),
      check,
    );
    query.triangularSolves += alive.length ? 1 : 0;
    query.coefficientsVisited += alive.length * alive.length;
    const normalization =
      base.reduce((s, v) => s + v, 0) +
      constant +
      dot(
        alive.map((i) => mass[i]),
        values,
      );
    if (nonzero && (!Number.isFinite(normalization) || normalization <= 0))
      fail('INVALID_INPUT', 'Invalid composed normalization');
    const recovered = new Map(alive.map((id, i) => [id, values[i]]));
    const valueOf = (id) => {
      if (recovered.has(id)) return recovered.get(id);
      check();
      const stepIndex = owner[id],
        step = steps[stepIndex];
      const row = step.interior.indexOf(id),
        ports = step.ports.map(valueOf);
      spend(ports.length);
      const value = zs[stepIndex][row] - dot(step.operator.transfer[row], ports);
      recovered.set(id, value);
      query.recoveredNodes++;
      query.coefficientsVisited += ports.length;
      return value;
    };
    const raw = (id) => {
      valid(id);
      return base[id] + valueOf(id);
    };
    const score = (id) => {
      const value = raw(id);
      if (!Number.isFinite(value) || value < -1e-10 * normalization)
        fail('INVALID_INPUT', 'Invalid composed score');
      return nonzero ? Math.max(0, value) / normalization : 0;
    };
    const zRanges = zs.map(span);
    // Compute envelopes in reverse elimination order; ports belong to a later
    // block or the solved boundary. One variable per Atom throughout.
    function bounds() {
      spend(size);
      const result = Array(size);
      for (const [id, value] of recovered) result[id] = [value, value];
      for (let index = steps.length - 1; index >= 0; index--) {
        check();
        const step = steps[index];
        if (step.interior.every((id) => recovered.has(id))) continue;
        let lower = 0,
          upper = 0;
        for (let j = 0; j < step.ports.length; j++) {
          spend(4);
          const term = product(step.operator.columns[j], result[step.ports[j]]);
          lower = down(lower + term[0]);
          upper = up(upper + term[1]);
          query.boundCoefficientsVisited++;
        }
        const interval = [down(zRanges[index][0] - upper), up(zRanges[index][1] - lower)];
        for (const id of step.interior) if (!recovered.has(id)) result[id] = interval;
      }
      return result.map(([lower, upper], id) =>
        !nonzero
          ? [0, 0]
          : recovered.has(id)
            ? [score(id), score(id)]
            : [
                Math.max(0, down(down(base[id] + lower) / normalization)),
                up(Math.max(0, up(base[id] + upper)) / normalization),
              ],
      );
    }
    function closure(ids) {
      const needed = new Set();
      const visit = (id) => {
        if (recovered.has(id) || needed.has(id)) return;
        check();
        needed.add(id);
        steps[owner[id]].ports.forEach(visit);
      };
      ids.forEach(visit);
      return [...needed];
    }
    return {
      score,
      scores: () => Array.from({ length: size }, (_, i) => score(i)),
      rawScores: () => Array.from({ length: size }, (_, i) => raw(i)),
      bounds,
      refine: (id) => {
        valid(id);
        valueOf(id);
      },
      known: (id) => recovered.has(id),
      recoveryCost: (id) =>
        closure([id]).reduce((sum, i) => sum + steps[owner[i]].ports.length + 1, 0),
      stats: query,
      normalization,
      // Budget counts total recovered interior nodes on this query, including
      // dependencies and required nodes. Boundary/RHS solves and bounds are extra.
      topK(k, options = {}) {
        const budget = options.maxRecovered ?? size;
        if (
          !Number.isSafeInteger(k) ||
          k < 0 ||
          k > size ||
          !Number.isSafeInteger(budget) ||
          budget < 0
        )
          fail('INVALID_INPUT');
        const required = [...new Set(options.required ?? [])];
        required.forEach(valid);
        const needed = closure(required);
        if (query.recoveredNodes + needed.length <= budget) required.forEach(valueOf);
        for (;;) {
          check();
          const intervals = bounds();
          const items = [...recovered.keys()]
            .map((index) => ({ index, score: score(index) }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, k);
          const threshold = items.length === k ? (items[k - 1]?.score ?? Infinity) : -Infinity;
          let unseenUpper = -Infinity;
          for (let i = 0; i < size; i++)
            if (!recovered.has(i)) unseenUpper = Math.max(unseenUpper, intervals[i][1]);
          const requiredComplete = required.every((id) => recovered.has(id));
          const certified =
            requiredComplete &&
            items.length === k &&
            (k === 0 || recovered.size === size || threshold > unseenUpper);
          const result = {
            items,
            certified,
            certificateScope: 'compiled-numeric-scores',
            unseenUpper,
            requiredComplete,
            recoveredNodes: query.recoveredNodes,
            closedBlocks: steps.filter((s) => s.interior.some((id) => !recovered.has(id))).length,
          };
          if (certified || !requiredComplete) return result;
          let selected,
            priority = -Infinity;
          for (const step of steps) {
            const unknown = step.interior.filter((id) => !recovered.has(id));
            if (!unknown.length) continue;
            const upper = Math.max(...unknown.map((id) => intervals[id][1]));
            if (items.length === k && upper < threshold) continue;
            const open = closure(unknown);
            if (query.recoveredNodes + open.length > budget) continue;
            // Rank possible contenders by score per recovery cost. This is a
            // scheduling heuristic; certification comes only from the bounds.
            const benefit = upper / Math.max(1, open.length);
            if (!selected || benefit > priority) {
              selected = unknown;
              priority = benefit;
            }
          }
          if (!selected) return result;
          selected.forEach(valueOf);
        }
      },
    };
  }
  return {
    stats: Object.freeze(stats),
    solve(seeds, queryOptions = {}) {
      const { rhs, nonzero } = input(seeds);
      return apply(rhs, nonzero, undefined, 0, queryOptions.spend ?? defaultSpend);
    },
    correct(seeds, previousRaw, queryOptions = {}) {
      const spend = queryOptions.spend ?? defaultSpend;
      const { rhs, nonzero } = input(seeds);
      if (previousRaw.length !== size || previousRaw.some((v) => !Number.isFinite(v)))
        fail('INVALID_INPUT');
      // Caller must align the same current Atom IDs. This prototype never guesses
      // identity across graph changes. Reset exact zero instead of cancellation.
      if (!nonzero) return apply(rhs, false, undefined, 0, spend);
      const base = [...previousRaw];
      const residual = rhs.map((v, i) => v - base[i]);
      for (const edge of transitions) {
        spend(1);
        check();
        residual[edge.to] = residual[edge.to] + edge.weight * base[edge.from];
      }
      return apply(residual, true, base, transitions.length, spend);
    },
  };
}
