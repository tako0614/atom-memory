import type { RankingOptions, RetrievalSignal, ScoreBreakdown } from '../client/types.js';
import { fail } from './util.js';
export function rankingOptions(options: RankingOptions = {}) {
  const nonnegative = (value: number) => {
    if (!Number.isFinite(value) || value < 0)
      fail('INVALID_INPUT', 'Ranking weights must be finite and nonnegative');
    return value;
  };
  const integer = (value: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      fail('INVALID_INPUT', 'Invalid ranking bound');
    return value;
  };
  const signals = {
    query: 1,
    context: 1,
    thought: 1,
    observations: 1,
    signal: 1,
    ...options.signals,
  };
  Object.values(signals).forEach(nonnegative);
  if (!Object.values(signals).some(Boolean)) fail('INVALID_INPUT');
  const semantic = nonnegative(options.semantic ?? 0.8),
    lexical = nonnegative(options.lexical ?? 0.2);
  if (!(semantic + lexical > 0)) fail('INVALID_INPUT');
  const propagation = nonnegative(options.propagation ?? 0.5);
  if (propagation >= 1) fail('INVALID_INPUT', 'Propagation must be below one');
  const relations = Object.fromEntries(
    Object.entries(options.relations ?? {}).map(([role, value]) => [
      role,
      { forward: nonnegative(value.forward ?? 1), reverse: nonnegative(value.reverse ?? 1) },
    ]),
  );
  const depth = options.depth ?? 2;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
  const tolerance = nonnegative(options.tolerance ?? 1e-6);
  if (!tolerance) fail('INVALID_INPUT');
  const maxNodes = integer(options.maxNodes ?? 512, 10000);
  return {
    signals,
    semantic,
    lexical,
    propagation,
    relations,
    depth,
    tolerance,
    maxSeeds: Math.min(integer(options.maxSeeds ?? 64, 10000), maxNodes),
    maxNodes,
    maxEdges: integer(options.maxEdges ?? 4096, 100000),
    maxIterations: integer(options.maxIterations ?? 32, 1000),
  };
}
export function seedScore(
  text: string,
  vectors: readonly (readonly number[])[] | undefined,
  signals: readonly RetrievalSignal[],
  options: RankingOptions = {},
): number {
  const weights = rankingOptions(options);
  const groups = new Map<string, number[]>();
  for (const signal of signals) {
    const semantic =
      signal.vector && vectors?.length
        ? Math.max(0, ...vectors.map((v) => cosine(signal.vector!, v)))
        : undefined;
    const lexical = signal.text ? lexicalScore(text, [signal.text]) : undefined;
    const denominator =
      (semantic === undefined ? 0 : weights.semantic) +
      (lexical === undefined ? 0 : weights.lexical);
    const score = denominator
      ? ((semantic ?? 0) * weights.semantic + (lexical ?? 0) * weights.lexical) / denominator
      : 0;
    const entries = groups.get(signal.kind) ?? [];
    entries.push(score);
    groups.set(signal.kind, entries);
  }
  let sum = 0,
    total = 0;
  for (const [kind, entries] of groups) {
    const weight = weights.signals[kind as keyof typeof weights.signals];
    sum += (weight * entries.reduce((a, b) => a + b, 0)) / entries.length;
    total += weight;
  }
  return total ? sum / total : 0;
}
/** Personalized weighted propagation on an already authorized, bounded graph. */
export function propagate(
  seeds: readonly number[],
  edges: readonly { from: number; to: number; weight: number }[],
  options: RankingOptions = {},
  check = () => {},
): { scores: number[]; breakdown: ScoreBreakdown[]; iterations: number; converged: boolean } {
  const config = rankingOptions(options),
    total = seeds.reduce((a, b) => a + b, 0);
  if (seeds.some((n) => !Number.isFinite(n) || n < 0)) fail('INVALID_INPUT');
  const start = seeds.map((n) => (total ? n / total : 0));
  const outgoing = seeds.map(() => 0);
  for (const edge of edges) {
    if (
      !Number.isSafeInteger(edge.from) ||
      !Number.isSafeInteger(edge.to) ||
      edge.from < 0 ||
      edge.to < 0 ||
      edge.from >= seeds.length ||
      edge.to >= seeds.length ||
      !Number.isFinite(edge.weight) ||
      edge.weight < 0
    )
      fail('INVALID_INPUT');
    outgoing[edge.from]! += edge.weight;
  }
  let scores = [...start],
    iterations = 0,
    converged = !total;
  let breakdown = start.map((direct) => ({ direct, structural: 0 }));
  while (!converged && iterations < config.maxIterations) {
    check();
    const transfer = seeds.map(() => 0);
    for (const edge of edges)
      if (outgoing[edge.from])
        transfer[edge.to]! += (scores[edge.from]! * edge.weight) / outgoing[edge.from]!;
    const dangling = scores.reduce((sum, value, i) => sum + (outgoing[i] ? 0 : value), 0);
    breakdown = start.map((value, i) => ({
      direct: (1 - config.propagation) * value,
      structural: config.propagation * (transfer[i]! + dangling * value),
    }));
    const next = breakdown.map((value) => value.direct + value.structural);
    converged =
      next.reduce((sum, value, i) => sum + Math.abs(value - scores[i]!), 0) <= config.tolerance;
    scores = next;
    iterations++;
  }
  return { scores, breakdown, iterations, converged };
}
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
export function words(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment),
    ),
  ];
}
export function lexicalScore(text: string, signals: readonly string[]): number {
  const haystack = text.normalize('NFKC').toLowerCase();
  return Math.max(
    0,
    ...signals.map((signal) => {
      const tokens = words(signal);
      if (!tokens.length) return 0;
      return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
    }),
  );
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (
    a.length !== b.length ||
    a.some((n) => !Number.isFinite(n)) ||
    b.some((n) => !Number.isFinite(n))
  )
    fail('MODEL_SPACE_MISMATCH');
  const norm =
    Math.sqrt(a.reduce((n, x) => n + x * x, 0)) * Math.sqrt(b.reduce((n, x) => n + x * x, 0));
  return norm ? Math.max(0, a.reduce((n, x, i) => n + x * b[i]!, 0) / norm) : 0;
}
