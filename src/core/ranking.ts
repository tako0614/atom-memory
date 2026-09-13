import type { ActivationOptions, RetrievalOptions, RetrievalSignal } from '../client/types.js';
import { fail } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function record(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_INPUT', `Invalid ${label}`);
}

function known(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key)))
    fail('INVALID_INPUT', `Unknown ${label} option`);
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail('INVALID_INPUT', `${label} must be finite and nonnegative`);
  return value;
}

function integer(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    fail('INVALID_INPUT', `Invalid ${label}`);
  return value;
}

export function activationOptions(options: ActivationOptions = {}) {
  record(options, 'activation options');
  known(
    options as Record<string, unknown>,
    ['halfLifeMs', 'maxBoost', 'propagation', 'relations'],
    'activation',
  );
  const halfLifeMs = nonnegative(options.halfLifeMs ?? 7 * DAY_MS, 'Half-life');
  if (halfLifeMs === 0) fail('INVALID_INPUT', 'Half-life must be positive');
  const propagation = nonnegative(options.propagation ?? 0.5, 'Propagation');
  if (propagation >= 1) fail('INVALID_INPUT', 'Propagation must be below one');
  const relationInput = options.relations ?? {};
  record(relationInput, 'relation options');
  const relations: Record<string, { forward: number; reverse: number }> = {};
  for (const [role, value] of Object.entries(relationInput)) {
    if (!role.length) fail('INVALID_INPUT', 'Relation roles must be nonempty');
    record(value, `relation ${role}`);
    known(value, ['forward', 'reverse'], 'relation');
    Object.defineProperty(relations, role, {
      value: {
        forward: nonnegative(value.forward ?? 1, 'Forward relation weight'),
        reverse: nonnegative(value.reverse ?? 1, 'Reverse relation weight'),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    halfLifeMs,
    maxBoost: nonnegative(options.maxBoost ?? 0.3, 'Maximum boost'),
    propagation,
    relations,
  };
}

export function retrievalOptions(options: RetrievalOptions = {}) {
  record(options, 'retrieval options');
  known(
    options as Record<string, unknown>,
    ['depth', 'maxSeeds', 'maxNodes', 'maxEdges', 'maxScan'],
    'retrieval',
  );
  const depth = options.depth ?? 2;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32)
    fail('INVALID_INPUT', 'Invalid retrieval depth');
  const maxNodes = integer(options.maxNodes ?? 512, 10_000, 'node bound');
  return {
    depth,
    maxSeeds: Math.min(integer(options.maxSeeds ?? 64, 10_000, 'seed bound'), maxNodes),
    maxNodes,
    maxEdges: integer(options.maxEdges ?? 4096, 100_000, 'edge bound'),
    maxScan: integer(options.maxScan ?? 10_000, 10_000, 'scan bound'),
  };
}

/** Fixed local match rule: 0.8 semantic + 0.2 lexical, averaged per signal kind. */
export function seedScore(
  text: string,
  vectors: readonly (readonly number[])[] | undefined,
  signals: readonly RetrievalSignal[],
): number {
  const groups = new Map<string, number[]>();
  for (const signal of signals) {
    let semantic: number | undefined;
    if (signal.vector && vectors?.length) {
      semantic = 0;
      for (const vector of vectors) semantic = Math.max(semantic, cosine(signal.vector, vector));
    }
    const lexical = signal.text ? lexicalScore(text, [signal.text]) : undefined;
    const denominator = (semantic === undefined ? 0 : 0.8) + (lexical === undefined ? 0 : 0.2);
    const score = denominator ? ((semantic ?? 0) * 0.8 + (lexical ?? 0) * 0.2) / denominator : 0;
    if (!Number.isFinite(score)) fail('INVALID_INPUT', 'Nonfinite seed score');
    const entries = groups.get(signal.kind) ?? [];
    entries.push(score);
    groups.set(signal.kind, entries);
  }
  let sum = 0;
  for (const entries of groups.values())
    sum += entries.reduce((group, value) => group + value, 0) / entries.length;
  const score = groups.size ? sum / groups.size : 0;
  if (!Number.isFinite(score)) fail('INVALID_INPUT', 'Nonfinite seed score');
  return score;
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
export function words(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
        .filter((segment) => segment.isWordLike)
        .map((segment) => segment.segment),
    ),
  ];
}

export function lexicalScore(text: string, signals: readonly string[]): number {
  const haystack = text.normalize('NFKC').toLowerCase();
  let best = 0;
  for (const signal of signals) {
    const tokens = words(signal);
    if (tokens.length)
      best = Math.max(
        best,
        tokens.filter((token) => haystack.includes(token)).length / tokens.length,
      );
  }
  return best;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (
    a.length !== b.length ||
    a.some((value) => !Number.isFinite(value)) ||
    b.some((value) => !Number.isFinite(value))
  )
    fail('MODEL_SPACE_MISMATCH');
  let scaleA = 0,
    scaleB = 0,
    identical = true;
  for (let index = 0; index < a.length; index++) {
    scaleA = Math.max(scaleA, Math.abs(a[index]!));
    scaleB = Math.max(scaleB, Math.abs(b[index]!));
    identical &&= a[index] === b[index];
  }
  if (!scaleA || !scaleB) return 0;
  if (identical) return 1;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]! / scaleA,
      right = b[index]! / scaleB;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const result = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(result)) fail('MODEL_SPACE_MISMATCH');
  return Math.max(0, Math.min(1, result));
}
