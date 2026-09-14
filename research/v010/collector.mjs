// Research-only v0.10 relation collectors. Production read/ranking remains unchanged.
import assert from 'node:assert/strict';
import { snapshotUse } from '../../dist/client/activation.js';
import { pinRevision } from '../../dist/client/engine.js';
import { collectRanking, finishRanking, startRanking } from '../../dist/client/ranking.js';
import { validateMemory } from '../../dist/client/retrieval.js';
import { evaluateActivation } from '../../dist/core/evaluation.js';
import { activationOptions, retrievalOptions, seedScore } from '../../dist/core/ranking.js';
import { AtomMemoryError, canonical, fail } from '../../dist/core/util.js';

export const COLLECTOR_MODES = Object.freeze([
  'candidate-only',
  'fifo-v09',
  'priority-only',
  'fair-only',
  'fair-evaluated',
  'active-fair',
]);

const ALTERNATE_MODES = new Set(['priority-only', 'fair-only', 'fair-evaluated', 'active-fair']);
// fair-evaluated pays for and refreshes the same shadow activation as active-fair. Its
// only ablated behavior is the epoch-internal comparator. fair-only remains the cheap
// allocation-only control.
const EVALUATION_MODES = new Set(['priority-only', 'fair-evaluated', 'active-fair']);
const PRIORITY_MODES = new Set(['priority-only', 'active-fair']);
const FAIR_MODES = new Set(['fair-only', 'fair-evaluated', 'active-fair']);

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail('INVALID_INPUT', `Invalid ${label}`);
  return value;
}

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

function addUsage(target, delta) {
  for (const [key, value] of Object.entries(delta)) target[key] += value;
}

function measure(state, phase, operation) {
  const before = state.rootLedger.usage();
  try {
    return operation();
  } finally {
    addUsage(state.phaseUsage[phase], usageDelta(before, state.rootLedger.usage()));
  }
}

/** Minimum work needed for a fresh, finite certificate from the production evaluator. */
export function freshEvaluationMinimum(nodes, edges) {
  integer(nodes, 'node count');
  integer(edges, 'edge count');
  return 44 + 20 * nodes + 18 * edges;
}

/** Research accounting adds seed/use preparation and two directed edge assembly operations. */
export function finalEvaluationReserve(nodes, edges) {
  return freshEvaluationMinimum(nodes, edges) + 2 * nodes + 2 * edges;
}

function provisionalMinimum(nodes, edges, warm) {
  // evaluateActivation charges one extra node pass when a matched warm vector is supplied.
  return 44 + (warm ? 21 : 20) * nodes + 20 * edges;
}

function edgeKey(edge) {
  return canonical(edge);
}

function relationEnabled(config, role) {
  const weights = Object.hasOwn(config.relations, role) ? config.relations[role] : undefined;
  return !weights || !!weights.forward || !!weights.reverse;
}

function evaluationEdges(state) {
  const indices = new Map(
    state.nodes.map((candidate, index) => [candidate.revision.revisionId, index]),
  );
  return state.edges.flatMap((edge) => {
    const from = indices.get(edge.from);
    const to = indices.get(edge.to);
    assert.notEqual(from, undefined);
    assert.notEqual(to, undefined);
    const weights = Object.hasOwn(state.activationConfig.relations, edge.role)
      ? state.activationConfig.relations[edge.role]
      : { forward: 1, reverse: 1 };
    return [
      { from, to, weight: weights.forward },
      { from: to, to: from, weight: weights.reverse },
    ];
  });
}

function prepareRevision(state, revision) {
  const before = state.rootLedger.usage();
  const usage = snapshotUse(state.engine, state.session, [revision], state.evaluatedAt);
  assert.equal(usage.at, state.evaluatedAt, 'the use model must be evaluated at the fixed time');
  state.session.ledger.charge({ maxEvaluationWork: 1 });
  const body = state.engine.indexedBody(revision);
  const baseSeed = seedScore(body.text, body.vectors, state.signals);
  const after = state.rootLedger.usage();
  return {
    baseSeed,
    boost: usage.boosts[0],
    seed: baseSeed * usage.boosts[0],
    useBytes: after.maxBytes - before.maxBytes,
  };
}

function canKeepFinal(
  state,
  extraWork = 0,
  nodes = state.nodes.length,
  edges = state.edges.length,
) {
  const reserve = finalEvaluationReserve(nodes, edges);
  return (
    state.rootLedger.remaining('maxEvaluationWork') >= reserve + extraWork &&
    state.session.ledger.remaining('maxEvaluationWork') >= extraWork
  );
}

function stop(state, reason, error) {
  state.stopped = reason;
  state.truncated = state.truncated || state.depth > 0;
  if (error)
    state.metrics.errors.push({
      code: error instanceof AtomMemoryError ? error.code : error.name,
      message: error.message,
      phase: 'relation',
    });
}

function evaluateProvisional(state) {
  const warm = state.provisional !== undefined;
  const minimum = provisionalMinimum(state.nodes.length, state.edges.length, warm);
  const reserve = finalEvaluationReserve(state.nodes.length, state.edges.length);
  const available = Math.min(
    state.session.ledger.remaining('maxEvaluationWork'),
    state.rootLedger.remaining('maxEvaluationWork') - reserve,
    state.provisionalMaxEvaluationWork,
  );
  if (available < minimum) return false;
  const parent = state.session.ledger;
  const child = parent.window({ maxEvaluationWork: available });
  state.session.ledger = child;
  try {
    const directed = evaluationEdges(state);
    // Weight lookup and construction are deliberately visible in the common ledger.
    child.charge({ maxEvaluationWork: directed.length });
    const ids = state.nodes.map((candidate) => candidate.revision.revisionId);
    const seeds = ids.map((id) => {
      const prepared = state.prepared.get(id);
      assert.ok(prepared, `missing fixed direct seed for ${id}`);
      return prepared.seed;
    });
    const previous = state.provisional
      ? ids.map((id) => state.provisional.activationById.get(id) ?? 0)
      : undefined;
    const result = evaluateActivation(seeds, directed, {
      propagation: state.activationConfig.propagation,
      ledger: child,
      ids,
      ...(previous ? { initial: previous } : {}),
      check: () => state.engine.check(state.session),
    });
    state.provisional = {
      activationById: new Map(ids.map((id, index) => [id, result.activation[index]])),
      scoreById: new Map(ids.map((id, index) => [id, result.scores[index]])),
      diagnostics: result.diagnostics,
      graphVersion: state.graphVersion,
    };
    state.metrics.provisionalEvaluations++;
    state.metrics.provisionalCertificates.push({
      graphVersion: state.graphVersion,
      nodes: state.nodes.length,
      edges: state.edges.length,
      converged: result.diagnostics.converged,
      numericErrorL1Upper: result.diagnostics.errorL1Upper,
      work: result.diagnostics.work + directed.length,
    });
    return true;
  } finally {
    state.session.ledger = parent;
  }
}

function computeKnownDistances(state) {
  const distances = new Map(state.nodes.map(({ revision }) => [revision.revisionId, Infinity]));
  const pending = [];
  for (const id of state.seedIds) {
    if (!distances.has(id)) continue;
    distances.set(id, 0);
    pending.push(id);
  }
  for (let index = 0; index < pending.length; index++) {
    const from = pending[index];
    const nextDepth = distances.get(from) + 1;
    for (const to of state.adjacency.get(from) ?? []) {
      if (nextDepth >= distances.get(to)) continue;
      distances.set(to, nextDepth);
      pending.push(to);
    }
  }
  return distances;
}

function frontierKey(revisionId, direction) {
  return `${revisionId}\u0000${direction}`;
}

function ensureFrontiers(state, revisionId) {
  if (state.depths.get(revisionId) >= state.depth) return;
  const revision = state.nodeById.get(revisionId).revision;
  for (const direction of ['forward', 'reverse']) {
    const key = frontierKey(revisionId, direction);
    if (state.frontiers.has(key)) continue;
    state.frontiers.set(key, {
      key,
      revisionId,
      ref: pinRevision(revision),
      direction,
      slot: 0,
      done: false,
      insertion: state.nextFrontierInsertion++,
      availableEpoch:
        FAIR_MODES.has(state.mode) && state.currentEpoch >= 0 ? state.currentEpoch + 1 : 0,
    });
  }
}

function recomputeDepths(state) {
  const next = computeKnownDistances(state);
  for (const [id, depth] of next) {
    assert.ok(Number.isFinite(depth), `admitted node ${id} is disconnected from every seed`);
    state.depths.set(id, depth);
  }
  for (const [id, depth] of next) if (depth < state.depth) ensureFrontiers(state, id);
}

function initializeAlternative(state) {
  state.seedIds = new Set(state.nodes.map(({ revision }) => revision.revisionId));
  state.nodeById = new Map(
    state.nodes.map((candidate) => [candidate.revision.revisionId, candidate]),
  );
  state.edgeKeys = new Set();
  state.adjacency = new Map(state.nodes.map(({ revision }) => [revision.revisionId, new Set()]));
  state.depths = new Map(state.nodes.map(({ revision }) => [revision.revisionId, 0]));
  state.frontiers = new Map();
  state.nextFrontierInsertion = 0;
  state.currentEpoch = -1;
  state.epochQueue = [];
  for (const id of state.seedIds) ensureFrontiers(state, id);

  if (!EVALUATION_MODES.has(state.mode)) return;
  const initialMinimum = 2 * state.nodes.length + provisionalMinimum(state.nodes.length, 0, false);
  if (!canKeepFinal(state, initialMinimum)) {
    stop(state, 'final-reserve');
    return;
  }
  for (const { revision } of state.nodes) {
    const prepared = prepareRevision(state, revision);
    state.prepared.set(revision.revisionId, prepared);
    state.finalUseBytes += prepared.useBytes;
  }
  if (state.rootLedger.remaining('maxBytes') < state.finalUseBytes || !evaluateProvisional(state))
    stop(state, 'final-reserve');
}

function beginEpoch(state) {
  state.currentEpoch++;
  const eligible = [...state.frontiers.values()]
    .filter((frontier) => !frontier.done && frontier.availableEpoch <= state.currentEpoch)
    .sort((left, right) => left.insertion - right.insertion);
  state.epochQueue = eligible.map((frontier) => frontier.key);
  state.metrics.epochs.push({
    epoch: state.currentEpoch,
    eligible: [...state.epochQueue],
    served: [],
  });
  return eligible.length > 0;
}

function unfinishedFrontiers(state) {
  return [...state.frontiers.values()].filter((frontier) => !frontier.done);
}

function chooseFrontier(state) {
  let eligible;
  if (FAIR_MODES.has(state.mode)) {
    for (;;) {
      while (!state.epochQueue.length) {
        if (!unfinishedFrontiers(state).length) return;
        if (!beginEpoch(state)) continue;
      }
      eligible = state.epochQueue
        .map((key) => state.frontiers.get(key))
        .filter((frontier) => frontier && !frontier.done);
      if (eligible.length) break;
      state.epochQueue = [];
    }
  } else {
    eligible = unfinishedFrontiers(state);
  }
  if (!eligible.length) return;
  const schedulingWork = eligible.length + 1;
  if (!canKeepFinal(state, schedulingWork)) {
    stop(state, 'final-reserve');
    return;
  }
  state.session.ledger.charge({ maxEvaluationWork: schedulingWork });
  state.metrics.schedulingWork += schedulingWork;
  let selected;
  if (!PRIORITY_MODES.has(state.mode)) {
    selected = eligible.reduce(
      (best, frontier) => (!best || frontier.insertion < best.insertion ? frontier : best),
      undefined,
    );
  } else {
    selected = eligible.reduce((best, frontier) => {
      if (!best) return frontier;
      const left = state.provisional.activationById.get(frontier.revisionId) ?? 0;
      const right = state.provisional.activationById.get(best.revisionId) ?? 0;
      return left > right || (left === right && frontier.insertion < best.insertion)
        ? frontier
        : best;
    }, undefined);
  }
  if (FAIR_MODES.has(state.mode)) {
    state.epochQueue = state.epochQueue.filter((key) => key !== selected.key);
    state.metrics.epochs.at(-1).served.push(selected.key);
    selected.availableEpoch = state.currentEpoch + 1;
  }
  return selected;
}

function prospectiveRelation(state, from, to, role) {
  if (!from || !to || from.state !== 'active' || to.state !== 'active') return { role };
  let newRevision;
  const unknown = [from, to].filter((revision) => !state.nodeById.has(revision.revisionId));
  assert.ok(unknown.length <= 1, 'a relation quantum must start at an admitted frontier');
  if (unknown.length) {
    if (state.nodes.length >= state.retrievalConfig.maxNodes) {
      state.truncated = true;
      state.metrics.nodeCapRejections++;
      return { role };
    }
    if (!validateMemory(state.engine, unknown[0], state.session)) return { role };
    newRevision = unknown[0];
  }
  const prospectiveIds = new Set(state.nodeById.keys());
  if (newRevision) prospectiveIds.add(newRevision.revisionId);
  if (!prospectiveIds.has(from.revisionId) || !prospectiveIds.has(to.revisionId)) return { role };
  const edge = { from: from.revisionId, to: to.revisionId, role };
  if (state.edgeKeys.has(edgeKey(edge))) return { role };
  return { role, edge, newRevision };
}

function forwardStage(state, frontier) {
  const owner = state.engine.get(frontier.ref, state.session);
  const slot = owner.slots[frontier.slot];
  if (!slot) return { kind: 'forward-complete', frontier, done: true };
  state.metrics.forwardSlotProbes++;
  let relation = { role: slot.role };
  if (relationEnabled(state.activationConfig, slot.role)) {
    const target = state.engine.neighbor(
      slot.target,
      state.session,
      slot.target.kind === 'logical',
    );
    relation = prospectiveRelation(state, owner, target, slot.role);
  }
  return {
    kind: 'forward-slot',
    frontier,
    nextSlot: frontier.slot + 1,
    done: frontier.slot + 1 >= owner.slots.length,
    ...relation,
  };
}

function reverseStage(state, frontier) {
  const owner = state.engine.get(frontier.ref, state.session);
  if (!frontier.posting) {
    state.session.ledger.charge({ maxCandidates: 1 });
    const incoming = state.engine.scan(
      {
        policies: state.session.trace.policies,
        relation: { target: frontier.ref },
        after: frontier.after,
        limit: 1,
      },
      state.session,
      true,
    )[0];
    state.metrics.reversePages++;
    if (!incoming) return { kind: 'reverse-empty-page', frontier, done: true };
    const current = state.engine.get(pinRevision(incoming), state.session, true);
    state.metrics.reversePostings++;
    return {
      kind: 'reverse-posting',
      frontier,
      posting: { revision: current, slot: 0 },
      done: current.slots.length === 0,
      after: current.slots.length === 0 ? current.atomId : frontier.after,
    };
  }
  const incoming = frontier.posting.revision;
  const slot = incoming.slots[frontier.posting.slot];
  assert.ok(slot, 'reverse posting cursor exceeded its slot count');
  state.metrics.reverseSlotProbes++;
  let relation = { role: slot.role };
  if (
    relationEnabled(state.activationConfig, slot.role) &&
    slot.target.atomId === owner.atomId &&
    (slot.target.kind !== 'pinned' || slot.target.revisionId === owner.revisionId) &&
    (slot.target.kind !== 'logical' ||
      state.engine.get(slot.target, state.session, true).revisionId === owner.revisionId)
  )
    relation = prospectiveRelation(state, incoming, owner, slot.role);
  const nextSlot = frontier.posting.slot + 1;
  return {
    kind: 'reverse-slot',
    frontier,
    postingSlot: nextSlot,
    postingDone: nextSlot >= incoming.slots.length,
    after: nextSlot >= incoming.slots.length ? incoming.atomId : frontier.after,
    ...relation,
  };
}

function advance(stage) {
  const frontier = stage.frontier;
  if (stage.kind === 'forward-complete' || stage.kind === 'reverse-empty-page') {
    frontier.done = true;
    return;
  }
  if (stage.kind === 'forward-slot') {
    frontier.slot = stage.nextSlot;
    frontier.done = stage.done;
    return;
  }
  if (stage.kind === 'reverse-posting') {
    if (stage.done) {
      frontier.after = stage.after;
      frontier.done = false;
      delete frontier.posting;
    } else frontier.posting = stage.posting;
    return;
  }
  if (stage.postingDone) {
    frontier.after = stage.after;
    delete frontier.posting;
  } else frontier.posting.slot = stage.postingSlot;
}

function acceptMutation(state, stage) {
  const nextNodes = state.nodes.length + (stage.newRevision ? 1 : 0);
  const nextEdges = state.edges.length + 1;
  if (nextEdges > state.retrievalConfig.maxEdges) {
    state.truncated = true;
    stop(state, 'edge-cap');
    return false;
  }
  const depthWork = 1 + nextNodes + 2 * nextEdges;
  const prepareWork = EVALUATION_MODES.has(state.mode) && stage.newRevision ? 2 : 0;
  const solveWork = EVALUATION_MODES.has(state.mode)
    ? provisionalMinimum(nextNodes, nextEdges, true)
    : 0;
  if (
    (EVALUATION_MODES.has(state.mode) && solveWork > state.provisionalMaxEvaluationWork) ||
    !canKeepFinal(state, depthWork + prepareWork + solveWork, nextNodes, nextEdges)
  ) {
    stop(state, 'final-reserve');
    state.metrics.stagedExcluded++;
    return false;
  }

  let prepared;
  if (EVALUATION_MODES.has(state.mode) && stage.newRevision)
    prepared = prepareRevision(state, stage.newRevision);
  const nextUseBytes = state.finalUseBytes + (prepared?.useBytes ?? 0);
  const key = edgeKey(stage.edge);
  const bytes = Buffer.byteLength(key);
  if (
    !state.session.ledger.can({ maxBytes: bytes }) ||
    state.rootLedger.remaining('maxBytes') < bytes + nextUseBytes
  ) {
    stop(state, 'final-reserve');
    state.metrics.stagedExcluded++;
    return false;
  }

  state.session.ledger.charge({ maxBytes: bytes, maxEvaluationWork: depthWork });
  if (stage.newRevision) {
    const candidate = { revision: stage.newRevision, score: prepared?.baseSeed ?? 0 };
    state.nodes.push(candidate);
    state.nodeById.set(stage.newRevision.revisionId, candidate);
    state.adjacency.set(stage.newRevision.revisionId, new Set());
    if (prepared) {
      state.prepared.set(stage.newRevision.revisionId, prepared);
      state.finalUseBytes = nextUseBytes;
    }
  }
  state.edges.push(stage.edge);
  state.edgeKeys.add(key);
  state.adjacency.get(stage.edge.from).add(stage.edge.to);
  state.adjacency.get(stage.edge.to).add(stage.edge.from);
  state.graphVersion++;
  recomputeDepths(state);
  if (EVALUATION_MODES.has(state.mode) && !evaluateProvisional(state)) {
    // The preflight includes the evaluator's exact minimum, so this is an invariant failure.
    throw new Error('provisional evaluation became unavailable after an admitted mutation');
  }
  state.metrics.graphMutations++;
  return true;
}

function alternateStep(state) {
  if (state.stopped) return { complete: true, graphChanged: false, stop: state.stopped };
  const frontier = chooseFrontier(state);
  if (!frontier)
    return {
      complete: true,
      graphChanged: false,
      ...(state.stopped ? { stop: state.stopped } : {}),
    };
  let stage;
  try {
    state.engine.check(state.session);
    stage =
      frontier.direction === 'forward'
        ? forwardStage(state, frontier)
        : reverseStage(state, frontier);
  } catch (error) {
    if (!(error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED')) throw error;
    stop(state, 'relation-budget', error);
    return { complete: true, graphChanged: false, frontierKey: frontier.key, stop: state.stopped };
  }
  let graphChanged = false;
  if (stage.edge) {
    graphChanged = acceptMutation(state, stage);
    if (state.stopped && !graphChanged)
      return {
        complete: true,
        graphChanged: false,
        frontierKey: frontier.key,
        kind: stage.kind,
        stop: state.stopped,
      };
  }
  advance(stage);
  if (state.edges.length >= state.retrievalConfig.maxEdges && unfinishedFrontiers(state).length)
    stop(state, 'edge-cap');
  state.metrics.steps++;
  assertCollectorInvariants(state);
  return {
    complete: unfinishedFrontiers(state).length === 0,
    graphChanged,
    evaluated: graphChanged && EVALUATION_MODES.has(state.mode),
    frontierKey: frontier.key,
    frontierDepth: state.depths.get(frontier.revisionId),
    depths: Object.fromEntries(state.depths),
    kind: stage.kind,
    nodes: state.nodes.length,
    edges: state.edges.length,
  };
}

function instrumentProductionCollection(state, operation) {
  const engine = state.engine;
  const scanOwn = Object.getOwnPropertyDescriptor(engine, 'scan');
  const neighborOwn = Object.getOwnPropertyDescriptor(engine, 'neighbor');
  const scan = engine.scan;
  const neighbor = engine.neighbor;
  Object.defineProperty(engine, 'scan', {
    configurable: true,
    writable: true,
    value(...args) {
      const result = scan.apply(this, args);
      if (args[0]?.relation) {
        state.metrics.reversePages++;
        state.metrics.reversePostings += result.length;
      }
      return result;
    },
  });
  Object.defineProperty(engine, 'neighbor', {
    configurable: true,
    writable: true,
    value(...args) {
      state.metrics.forwardSlotProbes++;
      return neighbor.apply(this, args);
    },
  });
  try {
    return operation();
  } finally {
    if (scanOwn) Object.defineProperty(engine, 'scan', scanOwn);
    else delete engine.scan;
    if (neighborOwn) Object.defineProperty(engine, 'neighbor', neighborOwn);
    else delete engine.neighbor;
  }
}

/**
 * Create one research collector over raw Engine.candidates output. Candidate validation is
 * deliberately repeated here through the real v0.9 validation path.
 */
export function createCollector({
  engine,
  session,
  candidates,
  signals,
  depth,
  mode,
  evaluatedAt,
  provisionalMaxEvaluationWork = 50_000,
  rootLedger = session?.ledger,
}) {
  if (!COLLECTOR_MODES.includes(mode)) fail('INVALID_INPUT', 'Unknown v0.10 collector mode');
  if (!engine || !session || !rootLedger || !Array.isArray(candidates) || !Array.isArray(signals))
    fail('INVALID_INPUT', 'Invalid collector input');
  integer(depth, 'depth', { maximum: 32 });
  integer(evaluatedAt, 'evaluation time');
  integer(provisionalMaxEvaluationWork, 'provisional evaluation window', { minimum: 1 });
  if ((engine.options.cacheMaxEntries ?? 512) !== 0 || engine.evaluations.size)
    fail('INVALID_INPUT', 'The research collector requires an isolated cold evaluation cache');
  if (ALTERNATE_MODES.has(mode) && session.ledger === rootLedger)
    fail(
      'INVALID_INPUT',
      'Alternate collectors require a relation child window that preserves final byte and candidate capacity',
    );
  const beforeValidation = rootLedger.usage();
  const retrievalConfig = retrievalOptions(engine.options.retrieval);
  const unique = new Map();
  for (const candidate of candidates) {
    const prior = unique.get(candidate?.revision?.revisionId);
    if (!prior || prior.score < candidate.score)
      unique.set(candidate.revision.revisionId, candidate);
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      right.score - left.score || left.revision.atomId.localeCompare(right.revision.atomId, 'en'),
  );
  const eligible = [];
  let validationExhausted = false;
  for (const candidate of ordered) {
    if (eligible.length >= retrievalConfig.maxSeeds) break;
    try {
      if (validateMemory(engine, candidate.revision, session)) eligible.push(candidate);
    } catch (error) {
      if (!(error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED')) throw error;
      if (!eligible.length) throw error;
      validationExhausted = true;
      break;
    }
  }
  const production = startRanking(
    eligible,
    mode === 'candidate-only' ? 0 : depth,
    engine.options.retrieval,
  );
  production.truncated ||= validationExhausted;
  const zero = usageZero(rootLedger);
  const validationUsage = usageDelta(beforeValidation, rootLedger.usage());
  const state = {
    engine,
    session,
    rootLedger,
    mode,
    signals,
    evaluatedAt,
    depth,
    retrievalConfig,
    activationConfig: activationOptions(engine.options.activation),
    provisionalMaxEvaluationWork,
    production,
    nodes: production.nodes,
    edges: production.edges,
    truncated: production.truncated,
    stopped: undefined,
    graphVersion: 0,
    prepared: new Map(),
    finalUseBytes: 0,
    byteIsolation: session.ledger !== rootLedger,
    provisional: undefined,
    final: undefined,
    phaseUsage: {
      relation: { ...validationUsage },
      finalEvaluation: { ...zero },
    },
    metrics: {
      steps: 0,
      graphMutations: 0,
      forwardSlotProbes: 0,
      reversePages: 0,
      reversePostings: 0,
      reverseSlotProbes: 0,
      schedulingWork: 0,
      provisionalEvaluations: 0,
      provisionalCertificates: [],
      nodeCapRejections: 0,
      stagedExcluded: 0,
      epochs: [],
      errors: [],
    },
  };
  if (ALTERNATE_MODES.has(mode)) measure(state, 'relation', () => initializeAlternative(state));
  return state;
}

/** Run one resumable relation quantum. fifo-v09 intentionally invokes the exact collector once. */
export function stepCollector(state) {
  if (!state || !COLLECTOR_MODES.includes(state.mode))
    fail('INVALID_INPUT', 'Invalid collector state');
  if (state.mode === 'candidate-only') return { complete: true, graphChanged: false };
  if (state.mode === 'fifo-v09') {
    if (state.productionComplete !== undefined)
      return { complete: true, graphChanged: false, stop: state.stopped };
    return measure(state, 'relation', () => {
      const beforeNodes = state.production.nodes.length;
      const beforeEdges = state.production.edges.length;
      const complete = instrumentProductionCollection(state, () =>
        collectRanking(state.engine, state.session, state.production),
      );
      state.productionComplete = complete;
      state.nodes = state.production.nodes;
      state.edges = state.production.edges;
      state.truncated ||= state.production.truncated || !complete;
      if (!complete) stop(state, 'relation-budget');
      state.metrics.graphMutations +=
        state.nodes.length - beforeNodes + (state.edges.length - beforeEdges);
      state.metrics.steps++;
      return {
        complete: true,
        graphChanged: state.nodes.length > beforeNodes || state.edges.length > beforeEdges,
        evaluated: false,
        kind: 'production-collectRanking',
        nodes: state.nodes.length,
        edges: state.edges.length,
        ...(state.stopped ? { stop: state.stopped } : {}),
      };
    });
  }
  return measure(state, 'relation', () => alternateStep(state));
}

export function runCollector(state) {
  let event;
  do event = stepCollector(state);
  while (!event.complete);
  return state;
}

/** Final scores always come from one fresh production finishRanking call on the final graph. */
export function finishCollector(state) {
  if (state.final) return state.final;
  return measure(state, 'finalEvaluation', () => {
    const previous = state.session.ledger;
    state.session.ledger = state.rootLedger;
    try {
      // Production finishRanking charges use-state reads and the solver. The research harness
      // additionally exposes seed and directed-edge assembly work instead of hiding it.
      state.rootLedger.charge({
        maxEvaluationWork: state.nodes.length + 2 * state.edges.length,
      });
      state.production.nodes = state.nodes;
      state.production.edges = state.edges;
      state.production.truncated = state.truncated;
      state.final = finishRanking(state.engine, state.session, state.production, state.signals, {
        evaluatedAt: state.evaluatedAt,
      });
      assert.equal(state.final.evaluation.evaluatedAt, state.evaluatedAt);
      state.truncated ||= state.production.truncated;
      return state.final;
    } finally {
      state.session.ledger = previous;
    }
  });
}

export function assertCollectorInvariants(state) {
  if (!ALTERNATE_MODES.has(state.mode)) return true;
  assert.equal(state.nodeById.size, state.nodes.length, 'nodes must be unique');
  assert.equal(state.edgeKeys.size, state.edges.length, 'edges must be unique');
  for (const id of state.seedIds)
    assert.equal(state.depths.get(id), 0, 'seed depth must stay zero');
  const expected = computeKnownDistances(state);
  for (const [id, depth] of expected)
    assert.equal(state.depths.get(id), depth, `wrong depth for ${id}`);
  for (const edge of state.edges) {
    assert.ok(state.nodeById.has(edge.from) && state.nodeById.has(edge.to));
    assert.ok(state.adjacency.get(edge.from).has(edge.to));
    assert.ok(state.adjacency.get(edge.to).has(edge.from));
    assert.ok(state.depths.get(edge.to) <= state.depths.get(edge.from) + 1);
    assert.ok(state.depths.get(edge.from) <= state.depths.get(edge.to) + 1);
  }
  assert.equal(
    state.frontiers.size,
    new Set([...state.frontiers.keys()]).size,
    'frontiers must be unique by revision and direction',
  );
  for (const frontier of state.frontiers.values()) {
    assert.equal(frontier.key, frontierKey(frontier.revisionId, frontier.direction));
    assert.ok(state.nodeById.has(frontier.revisionId));
    assert.ok(state.depths.get(frontier.revisionId) < state.depth);
  }
  if (state.provisional)
    assert.equal(
      state.provisional.graphVersion,
      state.graphVersion,
      'priority cannot use stale activation',
    );
  return true;
}

export function collectorSnapshot(state) {
  const depths = Object.fromEntries(
    [...(state.depths ?? new Map()).entries()].sort(([left], [right]) =>
      left.localeCompare(right, 'en'),
    ),
  );
  return {
    mode: state.mode,
    nodes: state.nodes.map(({ revision }) => revision.revisionId),
    edges: state.edges.map((edge) => ({ ...edge })),
    depths,
    frontiers: [...(state.frontiers ?? new Map()).values()].map((frontier) => ({
      key: frontier.key,
      revisionId: frontier.revisionId,
      direction: frontier.direction,
      slot: frontier.slot,
      done: frontier.done,
      insertion: frontier.insertion,
      availableEpoch: frontier.availableEpoch,
      ...(frontier.after ? { after: frontier.after } : {}),
      ...(frontier.posting ? { postingSlot: frontier.posting.slot } : {}),
    })),
    truncated: state.truncated,
    stop: state.stopped,
    graphVersion: state.graphVersion,
    byteIsolation: state.byteIsolation,
    ledgerTopology: state.byteIsolation ? 'relation-window-isolated' : 'shared-ledger',
    evaluationReserveEnforced: ALTERNATE_MODES.has(state.mode),
    metrics: structuredClone(state.metrics),
  };
}
