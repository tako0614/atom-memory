import { BudgetLedger } from './budget.js';
import { fail } from './util.js';

interface EvaluationEdge {
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

interface Transition {
  readonly to: number;
  readonly coefficient: number;
}

interface EvaluationOptions {
  readonly propagation: number;
  readonly ledger: BudgetLedger;
  readonly ids: readonly string[];
  readonly initial?: readonly number[];
  readonly check?: () => void;
}

interface Normalized {
  scores: number[];
  scale: number;
  massScaledLow: number;
  roundingErrorL1Upper: number;
}

const ERROR_TARGET = 1e-6;
const PUSH_BATCH = 64;
const bits = new DataView(new ArrayBuffer(8));

function nextUp(value: number): number {
  if (value === Infinity) return value;
  if (value === -Infinity) return -Number.MAX_VALUE;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}

const nextDown = (value: number) => -nextUp(-value);

/** Tight directed addition of two stored doubles (Knuth TwoSum error sign). */
function addBound(left: number, right: number, direction: 'down' | 'up'): number {
  const sum = left + right;
  if (!Number.isFinite(sum)) fail('INVALID_INPUT', 'Nonfinite activation arithmetic');
  const rightRounded = sum - left;
  const error = left - (sum - rightRounded) + (right - rightRounded);
  if (direction === 'down') return error < 0 ? nextDown(sum) : sum;
  return error > 0 ? nextUp(sum) : sum;
}

function differenceBounds(left: number, right: number): readonly [number, number] {
  if (left === right) return [0, 0];
  return [addBound(left, -right, 'down'), addBound(left, -right, 'up')];
}

function productBounds(left: number, right: number): readonly [number, number] {
  if (left === 0 || right === 0) return [0, 0];
  const product = left * right;
  if (!Number.isFinite(product)) fail('INVALID_INPUT', 'Nonfinite activation arithmetic');
  if (product === 0) return [0, Number.MIN_VALUE];
  return [Math.max(0, nextDown(product)), nextUp(product)];
}

function lowerQuotient(numerator: number, denominator: number): number {
  if (numerator === 0) return 0;
  if (numerator === denominator) return 1;
  const quotient = numerator / denominator;
  if (!Number.isFinite(quotient) || quotient < 0)
    fail('INVALID_INPUT', 'Nonfinite activation normalization');
  return Math.max(0, nextDown(quotient));
}

function upperQuotient(numerator: number, denominator: number): number {
  if (numerator === 0) return 0;
  if (numerator === denominator) return 1;
  const quotient = numerator / denominator;
  if (quotient === Infinity) return Infinity;
  if (!Number.isFinite(quotient) || quotient < 0)
    fail('INVALID_INPUT', 'Nonfinite activation normalization');
  return nextUp(quotient);
}

function safeCost(...parts: number[]): number {
  let total = 0;
  for (const part of parts) {
    total += part;
    if (!Number.isSafeInteger(total) || total < 0)
      fail('INVALID_INPUT', 'Evaluation graph is too large');
  }
  return total;
}

function actualResidual(
  seeds: readonly number[],
  activation: readonly number[],
  columns: readonly (readonly Transition[])[],
  check: () => void,
): number[] {
  const residual = seeds.map((seed, index) => seed - activation[index]!);
  for (let from = 0; from < columns.length; from++) {
    if ((from & 1023) === 0) check();
    for (const edge of columns[from]!) {
      const value = residual[edge.to]! + edge.coefficient * activation[from]!;
      if (!Number.isFinite(value)) fail('INVALID_INPUT', 'Nonfinite activation residual');
      residual[edge.to] = value;
    }
  }
  return residual;
}

function targetValue(value: number, residual: number): number {
  if (residual < 0 && -residual >= value) return 0;
  const target = value + residual;
  if (!Number.isFinite(target)) fail('INVALID_INPUT', 'Nonfinite activation update');
  return Math.max(0, target);
}

function localDelta(index: number, activation: readonly number[], residual: readonly number[]) {
  return targetValue(activation[index]!, residual[index]!) - activation[index]!;
}

function better(
  left: number,
  right: number,
  activation: readonly number[],
  residual: readonly number[],
  columns: readonly (readonly Transition[])[],
  ids: readonly string[],
): boolean {
  const leftPriority =
    Math.abs(localDelta(left, activation, residual)) / (1 + columns[left]!.length);
  const rightPriority =
    Math.abs(localDelta(right, activation, residual)) / (1 + columns[right]!.length);
  return (
    leftPriority > rightPriority ||
    (leftPriority === rightPriority &&
      (ids[left]! < ids[right]! || (ids[left] === ids[right] && left < right)))
  );
}

function bestIndex(
  activation: readonly number[],
  residual: readonly number[],
  columns: readonly (readonly Transition[])[],
  ids: readonly string[],
): number | undefined {
  let best: number | undefined;
  for (let index = 0; index < activation.length; index++)
    if (
      localDelta(index, activation, residual) !== 0 &&
      (best === undefined || better(index, best, activation, residual, columns, ids))
    )
      best = index;
  return best;
}

class ResidualHeap {
  readonly #heap: number[];
  readonly #positions: number[];
  constructor(
    private readonly activation: readonly number[],
    private readonly residual: readonly number[],
    private readonly columns: readonly (readonly Transition[])[],
    private readonly ids: readonly string[],
  ) {
    this.#heap = Array.from({ length: activation.length }, (_, index) => index);
    this.#positions = [...this.#heap];
    for (let index = (this.#heap.length >> 1) - 1; index >= 0; index--) this.#down(index);
  }
  top(): number | undefined {
    return this.#heap[0];
  }
  update(id: number): void {
    let at = this.#positions[id]!;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.#higher(at, parent)) break;
      this.#swap(at, parent);
      at = parent;
    }
    this.#down(at);
  }
  #higher(left: number, right: number): boolean {
    return better(
      this.#heap[left]!,
      this.#heap[right]!,
      this.activation,
      this.residual,
      this.columns,
      this.ids,
    );
  }
  #swap(left: number, right: number): void {
    const first = this.#heap[left]!,
      second = this.#heap[right]!;
    this.#heap[left] = second;
    this.#heap[right] = first;
    this.#positions[first] = right;
    this.#positions[second] = left;
  }
  #down(start: number): void {
    let at = start;
    for (;;) {
      let best = at;
      const first = at * 2 + 1,
        second = first + 1;
      if (first < this.#heap.length && this.#higher(first, best)) best = first;
      if (second < this.#heap.length && this.#higher(second, best)) best = second;
      if (best === at) return;
      this.#swap(at, best);
      at = best;
    }
  }
}

function normalize(activation: readonly number[]): Normalized {
  let scale = 0;
  for (const value of activation) scale = Math.max(scale, value);
  if (scale === 0)
    return {
      scores: activation.map(() => 0),
      scale: 0,
      massScaledLow: 0,
      roundingErrorL1Upper: 0,
    };
  const approximate: number[] = [],
    lows: number[] = [],
    highs: number[] = [];
  let approximateMass = 0,
    massLow = 0,
    massHigh = 0;
  for (const value of activation) {
    const quotient = value === scale ? 1 : value / scale;
    if (!Number.isFinite(quotient) || quotient < 0)
      fail('INVALID_INPUT', 'Nonfinite activation normalization');
    approximate.push(quotient);
    const low = value === 0 || value === scale ? quotient : Math.max(0, nextDown(quotient)),
      high = value === 0 || value === scale ? quotient : nextUp(quotient);
    lows.push(low);
    highs.push(high);
    approximateMass += quotient;
    massLow = addBound(massLow, low, 'down');
    massHigh = addBound(massHigh, high, 'up');
  }
  if (!Number.isFinite(approximateMass) || massLow <= 0 || !Number.isFinite(massHigh))
    fail('INVALID_INPUT', 'Nonfinite activation normalization');
  const scoreLows: number[] = [],
    scoreHighs: number[] = [];
  let scores = approximate.map((value) => Math.min(1, Math.max(0, value / approximateMass)));
  for (let index = 0; index < activation.length; index++) {
    scoreLows.push(lowerQuotient(lows[index]!, massHigh));
    scoreHighs.push(Math.min(1, upperQuotient(highs[index]!, massLow)));
  }
  // Keep the exact-real sum of the returned doubles at most one, so the
  // universal normalized L1 cap of two remains valid even after division.
  let scoreSumUpper = 0;
  for (const score of scores) scoreSumUpper = addBound(scoreSumUpper, score, 'up');
  if (scoreSumUpper > 1) scores = scores.map((score) => lowerQuotient(score, scoreSumUpper));
  let roundingError = 0;
  for (let index = 0; index < scores.length; index++) {
    const score = scores[index]!;
    const distance = Math.max(
      Math.abs(score - scoreLows[index]!),
      Math.abs(scoreHighs[index]! - score),
    );
    roundingError = addBound(roundingError, nextUp(distance), 'up');
  }
  return {
    scores,
    scale,
    massScaledLow: massLow,
    roundingErrorL1Upper: roundingError,
  };
}

function certify(
  seeds: readonly number[],
  activation: readonly number[],
  columns: readonly (readonly Transition[])[],
  ids: readonly string[],
  rhoUpper: number,
  check: () => void,
) {
  const residual = seeds.map((seed, index) => seed - activation[index]!);
  const lows: number[] = [],
    highs: number[] = [];
  for (let index = 0; index < seeds.length; index++) {
    const [low, high] = differenceBounds(seeds[index]!, activation[index]!);
    lows.push(low);
    highs.push(high);
  }
  for (let from = 0; from < columns.length; from++) {
    if ((from & 1023) === 0) check();
    for (const edge of columns[from]!) {
      const product = edge.coefficient * activation[from]!;
      const actual = residual[edge.to]! + product;
      if (!Number.isFinite(actual)) fail('INVALID_INPUT', 'Nonfinite activation residual');
      residual[edge.to] = actual;
      const [productLow, productHigh] = productBounds(edge.coefficient, activation[from]!);
      lows[edge.to] = addBound(lows[edge.to]!, productLow, 'down');
      highs[edge.to] = addBound(highs[edge.to]!, productHigh, 'up');
    }
  }
  const normalized = normalize(activation);
  let residualScaledUpper = 0;
  if (normalized.scale > 0)
    for (let index = 0; index < residual.length; index++) {
      const magnitude = Math.max(Math.abs(lows[index]!), Math.abs(highs[index]!));
      const scaled = upperQuotient(magnitude, normalized.scale);
      // A finite warm state can be arbitrarily small relative to new input.
      // Overflow of the error ratio means the universal bound of two applies;
      // it does not make the finite activation itself invalid.
      if (!Number.isFinite(residualScaledUpper + scaled)) {
        residualScaledUpper = Infinity;
        break;
      }
      residualScaledUpper = addBound(residualScaledUpper, scaled, 'up');
      if (!Number.isFinite(residualScaledUpper)) break;
    }
  const [contractionLower] = differenceBounds(1, rhoUpper);
  if (!(contractionLower > 0)) fail('INVALID_INPUT', 'Activation contraction is unprovable');
  let propagationError = 2;
  if (normalized.scale > 0) {
    const relativeResidual = upperQuotient(residualScaledUpper, normalized.massScaledLow);
    const rawNormalized = upperQuotient(relativeResidual, contractionLower);
    propagationError = rawNormalized >= 1 ? 2 : nextUp(rawNormalized * 2);
  }
  const combined = addBound(propagationError, normalized.roundingErrorL1Upper, 'up');
  const errorL1Upper = Math.min(2, combined);
  return {
    residual,
    best: bestIndex(activation, residual, columns, ids),
    scores: normalized.scores,
    errorL1Upper,
    converged: errorL1Upper <= ERROR_TARGET,
  };
}

/**
 * Evaluate a=b+T^T a on one already authorized, freshness-checked bounded graph.
 * Work units cover all node/edge passes and conservative heap-operation bounds.
 */
export function evaluateActivation(
  seeds: readonly number[],
  edges: readonly EvaluationEdge[],
  options: EvaluationOptions,
): {
  scores: number[];
  activation: number[];
  diagnostics: { converged: boolean; errorL1Upper: number; work: number };
} {
  if (
    !Array.isArray(seeds) ||
    !Array.isArray(edges) ||
    options === null ||
    typeof options !== 'object'
  )
    fail('INVALID_INPUT', 'Invalid activation evaluation input');
  if (
    Reflect.ownKeys(options).some(
      (key) =>
        typeof key !== 'string' ||
        !['propagation', 'ledger', 'ids', 'initial', 'check'].includes(key),
    )
  )
    fail('INVALID_INPUT', 'Unknown activation evaluation option');
  const { propagation, ledger, ids, initial } = options;
  const check = options.check ?? (() => {});
  if (
    !Number.isFinite(propagation) ||
    propagation < 0 ||
    propagation >= 1 ||
    !(ledger instanceof BudgetLedger) ||
    !Array.isArray(ids) ||
    ids.length !== seeds.length ||
    (initial !== undefined && (!Array.isArray(initial) || initial.length !== seeds.length)) ||
    typeof check !== 'function'
  )
    fail('INVALID_INPUT', 'Invalid activation evaluation input');

  const size = seeds.length,
    edgeCount = edges.length;
  const compileCost = safeCost(8, 5 * size, 4 * edgeCount, initial ? size : 0);
  let work = 0;
  const spend = (units: number) => {
    ledger.charge({ maxEvaluationWork: units });
    work += units;
  };
  if (!ledger.can({ maxEvaluationWork: compileCost })) fail('BUDGET_EXHAUSTED');
  spend(compileCost);
  check();

  const seenIds = new Set<string>();
  let anySeed = false;
  for (let index = 0; index < size; index++) {
    const seed = seeds[index]!,
      id = ids[index]!;
    if (
      !Number.isFinite(seed) ||
      seed < 0 ||
      typeof id !== 'string' ||
      !id.length ||
      seenIds.has(id)
    )
      fail('INVALID_INPUT', 'Invalid activation node');
    if (initial && (!Number.isFinite(initial[index]) || initial[index]! < 0))
      fail('INVALID_INPUT', 'Invalid warm activation');
    anySeed ||= seed > 0;
    seenIds.add(id);
  }

  const maximum = Array(size).fill(0) as number[];
  for (let index = 0; index < edgeCount; index++) {
    if ((index & 1023) === 0) check();
    const edge = edges[index]!;
    if (
      edge === null ||
      typeof edge !== 'object' ||
      !Number.isSafeInteger(edge.from) ||
      !Number.isSafeInteger(edge.to) ||
      edge.from < 0 ||
      edge.to < 0 ||
      edge.from >= size ||
      edge.to >= size ||
      !Number.isFinite(edge.weight) ||
      edge.weight < 0
    )
      fail('INVALID_INPUT', 'Invalid activation edge');
    maximum[edge.from] = Math.max(maximum[edge.from]!, edge.weight);
  }
  const denominators = Array(size).fill(0) as number[];
  for (let index = 0; index < edgeCount; index++) {
    const edge = edges[index]!,
      scale = maximum[edge.from]!;
    if (scale > 0) denominators[edge.from] = denominators[edge.from]! + edge.weight / scale;
  }
  if (denominators.some((value) => !Number.isFinite(value)))
    fail('INVALID_INPUT', 'Nonfinite outgoing weight sum');
  const columns = Array.from({ length: size }, () => [] as Transition[]);
  for (const edge of edges) {
    const scale = maximum[edge.from]!,
      denominator = denominators[edge.from]!;
    if (propagation === 0 || edge.weight === 0 || scale === 0) continue;
    const coefficient = propagation * (edge.weight / scale / denominator);
    if (!Number.isFinite(coefficient) || coefficient < 0)
      fail('INVALID_INPUT', 'Nonfinite transition coefficient');
    if (coefficient > 0) columns[edge.from]!.push({ to: edge.to, coefficient });
  }
  let rhoUpper = 0;
  for (const column of columns) {
    let rowUpper = 0;
    for (const edge of column) rowUpper = addBound(rowUpper, edge.coefficient, 'up');
    rhoUpper = Math.max(rhoUpper, rowUpper);
  }
  if (!Number.isFinite(rhoUpper) || rhoUpper >= 1)
    fail('INVALID_INPUT', 'Activation contraction is unprovable');

  if (!anySeed) {
    const zero = Array(size).fill(0) as number[];
    return {
      scores: [...zero],
      activation: zero,
      diagnostics: { converged: true, errorL1Upper: 0, work },
    };
  }

  const initializationCost = safeCost(4, 3 * size, edgeCount);
  const certificateCost = safeCost(32, 12 * size, 4 * edgeCount);
  if (!ledger.can({ maxEvaluationWork: safeCost(initializationCost, certificateCost) }))
    fail('BUDGET_EXHAUSTED');
  spend(initializationCost);
  const activation = initial ? [...initial] : [...seeds];
  let residual = actualResidual(seeds, activation, columns, check);
  let best = bestIndex(activation, residual, columns, ids);

  // This charge reserves a full outward residual and normalization pass. Once
  // updates begin, budget exhaustion can therefore still return a certificate.
  spend(certificateCost);
  const heapDepth = Math.ceil(Math.log2(Math.max(2, size)));
  const heapCost = safeCost(4, size * (2 * heapDepth + 4));
  const pushCost = (index: number) =>
    safeCost(8, 2 * columns[index]!.length, (columns[index]!.length + 1) * (4 * heapDepth + 6));

  for (;;) {
    if (
      best === undefined ||
      !ledger.can({ maxEvaluationWork: safeCost(heapCost, pushCost(best)) })
    ) {
      const result = certify(seeds, activation, columns, ids, rhoUpper, check);
      return {
        scores: result.scores,
        activation,
        diagnostics: {
          converged: result.converged,
          errorL1Upper: result.errorL1Upper,
          work,
        },
      };
    }

    spend(heapCost);
    const heap = new ResidualHeap(activation, residual, columns, ids);
    let pushes = 0;
    while (pushes < PUSH_BATCH) {
      check();
      const index = heap.top();
      if (index === undefined) break;
      const delta = localDelta(index, activation, residual);
      if (delta === 0) break;
      const cost = pushCost(index);
      if (!ledger.can({ maxEvaluationWork: cost })) break;
      spend(cost);
      const target = activation[index]! + delta;
      if (!Number.isFinite(target) || target < 0)
        fail('INVALID_INPUT', 'Nonfinite activation update');
      activation[index] = target;
      const own = residual[index]! - delta;
      if (!Number.isFinite(own)) fail('INVALID_INPUT', 'Nonfinite activation update');
      residual[index] = own;
      const changed = new Set<number>([index]);
      for (const edge of columns[index]!) {
        const value = residual[edge.to]! + edge.coefficient * delta;
        if (!Number.isFinite(value)) fail('INVALID_INPUT', 'Nonfinite activation update');
        residual[edge.to] = value;
        changed.add(edge.to);
      }
      for (const changedIndex of changed) heap.update(changedIndex);
      pushes++;
    }

    // Recompute from a and the stored coefficients, discarding incremental
    // residual drift before either returning or beginning another push batch.
    const result = certify(seeds, activation, columns, ids, rhoUpper, check);
    if (result.converged || result.best === undefined) {
      return {
        scores: result.scores,
        activation,
        diagnostics: {
          converged: result.converged,
          errorL1Upper: result.errorL1Upper,
          work,
        },
      };
    }
    best = result.best;
    const nextRequired = safeCost(certificateCost, heapCost, pushCost(best));
    if (!ledger.can({ maxEvaluationWork: nextRequired })) {
      return {
        scores: result.scores,
        activation,
        diagnostics: {
          converged: false,
          errorL1Upper: result.errorL1Upper,
          work,
        },
      };
    }
    residual = result.residual;
    spend(certificateCost);
  }
}
