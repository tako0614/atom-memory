// Sparse reference evaluators on the identical y=(I-W)^-1 s equation.
// Forward residual push is a baseline, not an implementation of BEARD or a
// reproduction of a paper's reported timings. W includes propagation already.
import { up, down } from './evaluator.mjs';

class MaxHeap {
  ids = [];
  positions = new Map();
  constructor(priority) {
    this.priority = priority;
  }
  swap(a, b) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    this.positions.set(this.ids[a], a);
    this.positions.set(this.ids[b], b);
  }
  update(id) {
    if (!this.positions.has(id)) {
      this.positions.set(id, this.ids.length);
      this.ids.push(id);
    }
    let at = this.positions.get(id);
    while (at && this.priority(this.ids[at]) > this.priority(this.ids[(at - 1) >> 1])) {
      const parent = (at - 1) >> 1;
      this.swap(at, parent);
      at = parent;
    }
    for (;;) {
      let best = at;
      for (const child of [at * 2 + 1, at * 2 + 2])
        if (
          child < this.ids.length &&
          this.priority(this.ids[child]) > this.priority(this.ids[best])
        )
          best = child;
      if (best === at) break;
      this.swap(at, best);
      at = best;
    }
  }
  top() {
    return this.ids[0];
  }
}

export function compileLinear(size, edges, propagation = 0.5) {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isFinite(propagation) ||
    propagation < 0 ||
    propagation >= 1
  )
    throw Error('Invalid linear graph');
  const outgoing = Array(size).fill(0),
    columns = Array.from({ length: size }, () => []);
  for (const e of edges) {
    if (
      !Number.isSafeInteger(e.from) ||
      !Number.isSafeInteger(e.to) ||
      e.from < 0 ||
      e.to < 0 ||
      e.from >= size ||
      e.to >= size ||
      !Number.isFinite(e.weight) ||
      e.weight < 0
    )
      throw Error('Invalid edge');
    outgoing[e.from] += e.weight;
    if (!Number.isFinite(outgoing[e.from])) throw Error('Invalid outgoing sum');
  }
  for (const e of edges)
    if (outgoing[e.from] && e.weight)
      columns[e.from].push({ to: e.to, weight: propagation * (e.weight / outgoing[e.from]) });
  const count = columns.reduce((n, c) => n + c.length, 0);
  const beta = Math.max(0, ...columns.map((c) => c.reduce((sum, e) => up(sum + e.weight), 0)));
  return {
    query(seeds, { mode = 'push', spend = () => {}, previousRaw, check = () => {} } = {}) {
      if (
        !['push', 'flat'].includes(mode) ||
        seeds.length !== size ||
        seeds.some((x) => !Number.isFinite(x) || x < 0)
      )
        throw Error('Invalid linear input');
      const total = seeds.reduce((a, b) => a + b, 0);
      if (!Number.isFinite(total)) throw Error('Invalid seed sum');
      const s = seeds.map((x) => (total ? x / total : 0));
      if (
        previousRaw &&
        (previousRaw.length !== size || previousRaw.some((x) => !Number.isFinite(x)))
      )
        throw Error('Invalid previous solution');
      spend(size + (previousRaw ? count : 0));
      let y = previousRaw && total ? [...previousRaw] : Array(size).fill(0);
      const residual = s.map((x, i) => x - y[i]);
      if (previousRaw)
        for (let i = 0; i < size; i++)
          for (const e of columns[i]) residual[e.to] += e.weight * y[i];
      const heap = new MaxHeap((i) => Math.abs(residual[i]) / Math.max(1, columns[i].length));
      for (let i = 0; i < size; i++) heap.update(i);
      const stats = {
        iterations: 0,
        pushes: 0,
        residualL1Upper: Infinity,
        rawErrorL1Upper: Infinity,
      };
      let savedBounds, savedMass;
      const bounds = () => {
        check();
        if (savedBounds) return savedBounds;
        spend(size * 4 + count * 2);
        // Outward evaluation of s - (I-W)y includes accumulated push/solve error.
        const low = s.map((x, i) => down(x - y[i])),
          high = s.map((x, i) => up(x - y[i]));
        for (let i = 0; i < size; i++)
          for (const e of columns[i]) {
            low[e.to] = down(low[e.to] + down(e.weight * y[i]));
            high[e.to] = up(high[e.to] + up(e.weight * y[i]));
          }
        const residualUpper = low.reduce(
          (sum, x, i) => up(sum + Math.max(Math.abs(x), Math.abs(high[i]))),
          0,
        );
        const error = beta < 1 ? up(residualUpper / down(1 - beta)) : Infinity;
        stats.residualL1Upper = residualUpper;
        stats.rawErrorL1Upper = error;
        const massLow = down(y.reduce((sum, x) => down(sum + x), 0) - error);
        const massHigh = up(y.reduce((sum, x) => up(sum + x), 0) + error);
        savedBounds = y.map((x) =>
          !total
            ? [0, 0]
            : massLow <= 0
              ? [0, 1]
              : [
                  Math.max(0, down(down(x - error) / massHigh)),
                  Math.min(1, up(up(x + error) / massLow)),
                ],
        );
        return savedBounds;
      };
      return {
        bounds,
        stats,
        certificateScope: 'fixed-rounded-transition-residual',
        known: () => false,
        recoveryCost: () => (mode === 'flat' ? size + count : 1),
        score(i) {
          if (savedMass === undefined) {
            spend(size);
            savedMass = y.reduce((a, b) => a + b, 0);
          }
          const sum = savedMass;
          return sum ? Math.max(0, y[i]) / sum : 0;
        },
        rawScores: () => [...y],
        refine() {
          check();
          if (mode === 'flat') {
            spend(size + count);
            const next = [...s];
            for (let i = 0; i < size; i++)
              for (const e of columns[i]) next[e.to] += e.weight * y[i];
            y = next;
            stats.iterations++;
          } else {
            // A small batch amortizes global residual verification. Each push
            // is atomic w.r.t. the work budget and preserves r=s-(I-W)y.
            for (let n = 0; n < 16 && size; n++) {
              check();
              const id = heap.top(),
                value = residual[id];
              if (!value) break;
              spend(1 + columns[id].length);
              savedBounds = undefined;
              savedMass = undefined;
              residual[id] = 0;
              y[id] += value;
              for (const e of columns[id]) {
                residual[e.to] += e.weight * value;
                heap.update(e.to);
              }
              heap.update(id);
              stats.pushes++;
            }
          }
          savedBounds = undefined;
          savedMass = undefined;
        },
      };
    },
  };
}
