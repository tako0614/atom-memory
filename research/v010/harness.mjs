// Research-only comparison harness. It starts below MemoryClient.read so no public API changes.
import assert from 'node:assert/strict';
import { select } from '../../dist/client/selection.js';
import { retrievalOptions } from '../../dist/core/ranking.js';
import { AtomMemoryError, canonical, fail } from '../../dist/core/util.js';
import {
  COLLECTOR_MODES,
  collectorSnapshot,
  createCollector,
  finishCollector,
  runCollector,
} from './collector.mjs';

function usageZero(ledger) {
  return Object.fromEntries(Object.keys(ledger.usage()).map((key) => [key, 0]));
}

function usageDelta(before, after) {
  return Object.fromEntries(
    Object.keys(after).map((key) => {
      const value = after[key] - before[key];
      assert.ok(Number.isSafeInteger(value) && value >= 0, `negative ${key} usage delta`);
      return [key, value];
    }),
  );
}

function phaseTotal(phaseUsage, zero) {
  const total = { ...zero };
  for (const usage of Object.values(phaseUsage))
    for (const [key, value] of Object.entries(usage)) total[key] += value;
  return total;
}

export function assertUsageConservation(usage, phaseUsage) {
  const zero = Object.fromEntries(Object.keys(usage).map((key) => [key, 0]));
  assert.deepEqual(phaseTotal(phaseUsage, zero), usage, 'phase usage must equal the shared ledger');
  for (const [phase, resources] of Object.entries(phaseUsage))
    for (const [resource, value] of Object.entries(resources))
      assert.ok(
        Number.isSafeInteger(value) && value >= 0,
        `${phase}.${resource} must be a nonnegative safe integer`,
      );
  return true;
}

function candidateIdentity(acquisition) {
  return canonical({
    at: acquisition.at,
    signalDigest: acquisition.signalDigest,
    candidates: acquisition.candidates.map((candidate) => ({
      revisionId: candidate.revision.revisionId,
      score: candidate.score,
    })),
  });
}

/** Execute the same full candidate ingress used by MemoryClient.retrieve, before ranking. */
export async function acquireCandidates({ engine, binding, input, budget, at, diagnostic }) {
  if (!engine || !binding || !input || typeof input !== 'object')
    fail('INVALID_INPUT', 'Invalid candidate acquisition input');
  const session = engine.session(
    binding,
    { ...(budget ? { budget } : {}) },
    undefined,
    undefined,
    at,
  );
  const rootLedger = session.ledger;
  if (diagnostic) {
    diagnostic.phase = 'candidate';
    diagnostic.rootLedger = rootLedger;
    diagnostic.session = session;
  }
  const before = rootLedger.usage();
  const maximum = retrievalOptions(engine.options.retrieval).maxScan;
  session.ledger = rootLedger.window({
    maxCandidates: Math.max(1, Math.floor(rootLedger.remaining('maxCandidates') / 2)),
    maxBytes: Math.floor(rootLedger.remaining('maxBytes') / 2),
  });
  let found;
  const started = performance.now();
  try {
    found = await engine.candidates(input, session, undefined, maximum);
  } finally {
    session.ledger = rootLedger;
  }
  const elapsedMs = performance.now() - started;
  if (!found.complete && found.scanned === 0 && found.after === undefined)
    fail('BUDGET_EXHAUSTED', 'Candidate cannot advance: increase byte or candidate budget');
  const seen = new Map();
  for (const candidate of found.candidates) {
    const prior = seen.get(candidate.revision.revisionId);
    if (!prior || prior.score < candidate.score) seen.set(candidate.revision.revisionId, candidate);
  }
  const candidates = [...seen.values()].sort(
    (left, right) =>
      right.score - left.score || left.revision.atomId.localeCompare(right.revision.atomId, 'en'),
  );
  return {
    engine,
    binding,
    input,
    session,
    rootLedger,
    candidates,
    signals: found.signals,
    signalDigest: found.signalDigest,
    scanned: found.scanned,
    complete: found.complete,
    pending: found.pending,
    approximate: found.approximate,
    after: found.after,
    at: session.at,
    elapsedMs,
    usage: usageDelta(before, rootLedger.usage()),
  };
}

function packedRefs(packed) {
  return packed.items.map((item) => item.ref);
}

function errorRecord(error, phase) {
  return {
    code: error instanceof AtomMemoryError ? error.code : error.name,
    message: error.message,
    phase,
  };
}

function resultMetrics(acquisition, state, phaseUsage, usage, wallMs, packingMs) {
  const probes =
    state.metrics.forwardSlotProbes + state.metrics.reversePages + state.metrics.reverseSlotProbes;
  return {
    acquiredNodes: state.nodes.length,
    acquiredEdges: state.edges.length,
    candidateScanned: acquisition.scanned,
    candidateCount: acquisition.candidates.length,
    pages: state.metrics.reversePages,
    probes,
    forwardSlotProbes: state.metrics.forwardSlotProbes,
    reversePages: state.metrics.reversePages,
    reversePostings: state.metrics.reversePostings,
    reverseSlotProbes: state.metrics.reverseSlotProbes,
    steps: state.metrics.steps,
    graphMutations: state.metrics.graphMutations,
    schedulingWork: state.metrics.schedulingWork,
    provisionalEvaluations: state.metrics.provisionalEvaluations,
    provisionalCertificates: structuredClone(state.metrics.provisionalCertificates),
    epochs: structuredClone(state.metrics.epochs),
    stagedExcluded: state.metrics.stagedExcluded,
    nodeCapRejections: state.metrics.nodeCapRejections,
    candidateMs: acquisition.elapsedMs,
    packingMs,
    wallMs,
    phaseUsage,
    usage,
    limits: structuredClone(state.rootLedger.limits),
  };
}

/**
 * Run one mode against one independent Engine/storage snapshot. Candidate acquisition is repeated
 * in full for every call. Relation collection and fixed-time use reads stay in one synchronous
 * storage transaction; asynchronous providers therefore remain outside this prototype snapshot.
 */
async function runVariantCore({
  engine,
  binding,
  input,
  mode,
  budget,
  depth = engine?.options?.retrieval?.depth ?? 2,
  tokens = 4096,
  limit = 24,
  evaluatedAt = Date.now(),
  provisionalMaxEvaluationWork = 50_000,
  at,
  diagnostic,
}) {
  if (!COLLECTOR_MODES.includes(mode)) fail('INVALID_INPUT', 'Unknown v0.10 collector mode');
  if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(limit) || limit < 1)
    fail('INVALID_INPUT', 'Invalid packing limits');
  if (engine.evaluations.size)
    fail('INVALID_INPUT', 'Each variant must begin with an independent empty evaluation cache');
  if (diagnostic) diagnostic.evaluatedAt = evaluatedAt;
  const started = performance.now();
  const acquisition = await acquireCandidates({ engine, binding, input, budget, at, diagnostic });
  const rootLedger = acquisition.rootLedger;
  const candidateUsage = acquisition.usage;
  const beforeRelation = rootLedger.usage();
  const relationLedger = rootLedger.window({
    maxCandidates: Math.floor(rootLedger.remaining('maxCandidates') / 2),
    maxBytes: Math.floor(rootLedger.remaining('maxBytes') / 2),
    maxEvaluationWork: rootLedger.remaining('maxEvaluationWork'),
  });
  let state;
  let final;
  let packed;
  let receipt;
  let packingUsage;
  let packingMs = 0;
  engine.storage.transaction(() => {
    if (diagnostic) diagnostic.phase = 'relation';
    acquisition.session.ledger = relationLedger;
    state = createCollector({
      engine,
      session: acquisition.session,
      rootLedger,
      candidates: acquisition.candidates,
      signals: acquisition.signals,
      depth,
      mode,
      evaluatedAt,
      provisionalMaxEvaluationWork,
    });
    if (diagnostic) diagnostic.state = state;
    runCollector(state);
    acquisition.session.ledger = rootLedger;
    if (diagnostic) diagnostic.phase = 'finalEvaluation';
    final = finishCollector(state);
    const beforePacking = rootLedger.usage();
    const packingStarted = performance.now();
    if (diagnostic) diagnostic.phase = 'packing';
    packed = select(
      engine,
      acquisition.session,
      final.candidates,
      Math.min(tokens, rootLedger.remaining('maxContextTokens')),
      limit,
      final.candidates,
    );
    packingMs = performance.now() - packingStarted;
    packingUsage = usageDelta(beforePacking, rootLedger.usage());
    receipt = engine.trace(acquisition.session);
  });
  assert.equal(
    engine.storage.watermark(),
    acquisition.at,
    'fixture graph changed during a variant',
  );
  const usage = rootLedger.usage();
  const phaseUsage = {
    candidate: candidateUsage,
    relation: state.phaseUsage.relation,
    finalEvaluation: state.phaseUsage.finalEvaluation,
    packing: packingUsage,
  };
  // If this fails, some research work escaped its measured phase.
  assertUsageConservation(usage, phaseUsage);
  assert.deepEqual(
    usageDelta(beforeRelation, usage),
    phaseTotal(
      {
        relation: phaseUsage.relation,
        finalEvaluation: phaseUsage.finalEvaluation,
        packing: phaseUsage.packing,
      },
      usageZero(rootLedger),
    ),
  );
  const byId = new Map(
    final.candidates.map((candidate) => [candidate.revision.revisionId, candidate]),
  );
  const allScores = state.nodes.map((candidate) => ({
    revisionId: candidate.revision.revisionId,
    atomId: candidate.revision.atomId,
    score: byId.get(candidate.revision.revisionId)?.score ?? 0,
    activation: byId.get(candidate.revision.revisionId)?.activation ?? 0,
  }));
  const errors = [...state.metrics.errors];
  if (!final.evaluation.evaluationConverged)
    errors.push({
      code: 'NUMERIC_BUDGET',
      message: 'Final acquired-graph certificate did not reach the target error',
      phase: 'finalEvaluation',
    });
  const wallMs = performance.now() - started;
  return {
    mode,
    evaluatedAt,
    at: acquisition.at,
    signalDigest: acquisition.signalDigest,
    rawCandidates: acquisition.candidates,
    candidates: final.candidates,
    allScores,
    graph: { nodes: state.nodes, edges: state.edges },
    items: packed.items,
    text: packed.text,
    refs: packedRefs(packed),
    sources: packed.sources,
    tokenCount: packed.tokenCount,
    receipt,
    packing: {
      used: packed.used,
      deferred: packed.deferred,
      selection: packed.selection,
      ...(packed.minimumTokens ? { minimumTokens: packed.minimumTokens } : {}),
    },
    diagnostics: {
      truncated: state.truncated,
      stop:
        state.stopped ?? (final.evaluation.evaluationConverged ? 'completed' : 'numeric-budget'),
      errors,
      candidate: {
        complete: acquisition.complete,
        approximate: acquisition.approximate,
        pending: acquisition.pending,
        scanned: acquisition.scanned,
      },
      evaluation: {
        evaluatedAt: final.evaluation.evaluatedAt,
        converged: final.evaluation.evaluationConverged,
        numericErrorL1Upper: final.evaluation.numericErrorL1Upper,
        scope: 'acquired-graph',
      },
      collector: collectorSnapshot(state),
      selection: packed.selection,
      limitation:
        'Fixed evaluatedAt is not a historical use-state snapshot; this run relies on an immutable fixture, a synchronous relation/final transaction, and the relation child window to retain final byte/candidate capacity.',
    },
    usage,
    metrics: resultMetrics(acquisition, state, phaseUsage, usage, wallMs, packingMs),
  };
}

export async function runVariant(options) {
  const diagnostic = {
    phase: 'setup',
    started: performance.now(),
    evaluatedAt: options?.evaluatedAt,
  };
  try {
    return await runVariantCore({ ...options, diagnostic });
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      const state = diagnostic.state;
      Object.defineProperty(error, 'v010', {
        configurable: true,
        enumerable: true,
        value: {
          phase: diagnostic.phase,
          evaluatedAt: diagnostic.evaluatedAt,
          wallMs: performance.now() - diagnostic.started,
          ...(diagnostic.rootLedger
            ? {
                usage: diagnostic.rootLedger.usage(),
                limits: structuredClone(diagnostic.rootLedger.limits),
              }
            : {}),
          ...(state
            ? {
                graph: { nodes: state.nodes.length, edges: state.edges.length },
                truncated: state.truncated,
                stop: state.stopped,
                phaseUsage: structuredClone(state.phaseUsage),
              }
            : {}),
        },
      });
    }
    throw error;
  }
}

export async function readVariant(options) {
  return runVariant(options);
}

function numericDelta(left, right) {
  return left === undefined || right === undefined ? undefined : left - right;
}

function activeFairDelta(results, baseline = 'fair-evaluated') {
  const active = results['active-fair'];
  const fair = results[baseline];
  if (!active || !fair) return;
  return {
    acquiredNodes: active.metrics.acquiredNodes - fair.metrics.acquiredNodes,
    acquiredEdges: active.metrics.acquiredEdges - fair.metrics.acquiredEdges,
    pages: active.metrics.pages - fair.metrics.pages,
    probes: active.metrics.probes - fair.metrics.probes,
    evaluationWork: active.usage.maxEvaluationWork - fair.usage.maxEvaluationWork,
    packingWork: active.usage.maxPackingWork - fair.usage.maxPackingWork,
    contextTokens: active.tokenCount - fair.tokenCount,
    selectionUtility: numericDelta(
      active.packing.selection.utility,
      fair.packing.selection.utility,
    ),
    wallMs: active.metrics.wallMs - fair.metrics.wallMs,
  };
}

/** Compare independent storage/Engine snapshots and reject a drifting candidate phase. */
export async function compareVariants({
  makeVariant,
  modes = COLLECTOR_MODES,
  evaluatedAt = Date.now(),
  ...options
}) {
  if (typeof makeVariant !== 'function')
    fail('INVALID_INPUT', 'compareVariants requires an independent makeVariant(mode) factory');
  if (
    !Array.isArray(modes) ||
    !modes.length ||
    modes.some((mode) => !COLLECTOR_MODES.includes(mode))
  )
    fail('INVALID_INPUT', 'Invalid comparison modes');
  const engines = new Set();
  const storages = new Set();
  const results = {};
  let expectedCandidates;
  let expectedCandidateUsage;
  let expectedLimits;
  for (const mode of modes) {
    const variant = await makeVariant(mode);
    if (!variant?.engine || !variant?.binding)
      fail('INVALID_INPUT', 'Variant factory must return engine and binding');
    if (engines.has(variant.engine) || storages.has(variant.engine.storage))
      fail('INVALID_INPUT', 'Variants must use independent Engine and storage instances');
    engines.add(variant.engine);
    storages.add(variant.engine.storage);
    try {
      const result = await runVariant({
        ...options,
        engine: variant.engine,
        binding: variant.binding,
        mode,
        evaluatedAt,
      });
      const identity = candidateIdentity({
        at: result.at,
        signalDigest: result.signalDigest,
        candidates: result.rawCandidates,
      });
      const candidateUsage = canonical(result.metrics.phaseUsage.candidate);
      const limits = canonical(result.metrics.limits);
      expectedCandidates ??= identity;
      expectedCandidateUsage ??= candidateUsage;
      expectedLimits ??= limits;
      assert.equal(
        identity,
        expectedCandidates,
        `${mode} did not receive the common raw candidates`,
      );
      assert.equal(
        candidateUsage,
        expectedCandidateUsage,
        `${mode} candidate acquisition cost drifted`,
      );
      assert.equal(limits, expectedLimits, `${mode} budget limits drifted`);
      assert.equal(result.evaluatedAt, evaluatedAt);
      results[mode] = result;
    } finally {
      variant.close?.();
    }
  }
  return {
    evaluatedAt,
    modes: [...modes],
    results,
    activeFairMinusFairOnly: activeFairDelta(results, 'fair-only'),
    activeFairMinusFairEvaluated: activeFairDelta(results, 'fair-evaluated'),
    interpretation:
      'Proxy retrieval and packing evidence on fixed fixtures; no LLM answer-quality or general optimality claim.',
  };
}

export function capturedError(error, phase = 'variant') {
  return errorRecord(error, phase);
}
