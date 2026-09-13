import type { AtomRevision, PinnedRef } from '../contracts.js';
import type { Candidate, RetrievalOptions, RetrievalSignal } from './types.js';
import { type Engine, type Session, pinRevision, bindingKey } from './engine.js';
import { validateMemory } from './retrieval.js';
import { AtomMemoryError, canonical, digest } from '../core/util.js';
import { activationOptions, retrievalOptions, seedScore } from '../core/ranking.js';
import { evaluateActivation } from '../core/evaluation.js';
import { snapshotUse } from './activation.js';

interface Task {
  ref: PinnedRef;
  depth: number;
  phase: 'forward' | 'reverse';
  slot: number;
  after?: string;
}
export interface RankingState {
  nodes: Candidate[];
  edges: { from: string; to: string; role: string }[];
  tasks: Task[];
  truncated: boolean;
  depth: number;
}
export function startRanking(
  candidates: readonly Candidate[],
  depth: number,
  options?: RetrievalOptions,
): RankingState {
  const config = retrievalOptions(options);
  const nodes = [...candidates]
    .sort((a, b) => b.score - a.score || a.revision.atomId.localeCompare(b.revision.atomId, 'en'))
    .slice(0, config.maxSeeds);
  return {
    nodes,
    edges: [],
    depth,
    truncated: candidates.length > nodes.length,
    tasks: depth
      ? nodes.flatMap(({ revision }) => [
          { ref: pinRevision(revision), depth: 0, phase: 'forward' as const, slot: 0 },
          { ref: pinRevision(revision), depth: 0, phase: 'reverse' as const, slot: 0 },
        ])
      : [],
  };
}
/** Collect every discovered edge, including paths to an already visited node.
 * Cursor acquisition finishes before any rank is exposed to a caller. */
export function collectRanking(engine: Engine, s: Session, state: RankingState): boolean {
  const config = retrievalOptions(engine.options.retrieval);
  const activation = activationOptions(engine.options.activation);
  const nodes = new Set(state.nodes.map((c) => c.revision.revisionId));
  const edges = new Set(state.edges.map((e) => canonical(e)));
  const addNode = (r: AtomRevision, depth: number): boolean => {
    if (r.state !== 'active') return false;
    if (nodes.has(r.revisionId)) return true;
    if (nodes.size >= config.maxNodes) {
      state.truncated = true;
      return false;
    }
    if (!validateMemory(engine, r, s)) return false;
    nodes.add(r.revisionId);
    state.nodes.push({ revision: r, score: 0 });
    if (depth < state.depth)
      state.tasks.push(
        { ref: pinRevision(r), depth, phase: 'forward', slot: 0 },
        { ref: pinRevision(r), depth, phase: 'reverse', slot: 0 },
      );
    return true;
  };
  const addEdge = (from: AtomRevision, to: AtomRevision, role: string) => {
    if (!nodes.has(from.revisionId) || !nodes.has(to.revisionId)) return;
    const edge = { from: from.revisionId, to: to.revisionId, role },
      key = canonical(edge);
    if (edges.has(key)) return;
    if (edges.size >= config.maxEdges) {
      state.truncated = true;
      return;
    }
    s.ledger.charge({ maxBytes: Buffer.byteLength(key) });
    edges.add(key);
    state.edges.push(edge);
  };
  while (state.tasks.length) {
    const task = state.tasks[0]!;
    try {
      engine.check(s);
      const r = engine.get(task.ref, s);
      if (task.phase === 'forward') {
        const slot = r.slots[task.slot];
        if (!slot) {
          state.tasks.shift();
          continue;
        }
        const weights = Object.hasOwn(activation.relations, slot.role)
          ? activation.relations[slot.role]
          : undefined;
        if (!weights || weights.forward || weights.reverse) {
          const target = engine.neighbor(slot.target, s, slot.target.kind === 'logical');
          if (target && addNode(target, task.depth + 1)) addEdge(r, target, slot.role);
        }
        task.slot++;
      } else {
        // A one-posting page keeps retry position exact under very small budgets.
        s.ledger.charge({ maxCandidates: 1 });
        const incoming = engine.scan(
          {
            policies: s.trace.policies,
            relation: { target: task.ref },
            after: task.after,
            limit: 1,
          },
          s,
          true,
        )[0];
        if (!incoming) {
          state.tasks.shift();
          continue;
        }
        engine.get(pinRevision(incoming), s, true);
        for (const slot of incoming.slots) {
          const weights = Object.hasOwn(activation.relations, slot.role)
            ? activation.relations[slot.role]
            : undefined;
          if (weights && !weights.forward && !weights.reverse) continue;
          if (
            slot.target.atomId !== r.atomId ||
            (slot.target.kind === 'pinned' && slot.target.revisionId !== r.revisionId)
          )
            continue;
          if (
            slot.target.kind === 'logical' &&
            engine.get(slot.target, s, true).revisionId !== r.revisionId
          )
            continue;
          if (addNode(incoming, task.depth + 1)) addEdge(incoming, r, slot.role);
        }
        task.after = incoming.atomId;
      }
      if (state.edges.length >= config.maxEdges) {
        state.truncated ||= state.tasks.length > 0;
        state.tasks = [];
      }
    } catch (error) {
      if (error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED') return false;
      throw error;
    }
  }
  return true;
}
export function finishRanking(
  engine: Engine,
  s: Session,
  state: RankingState,
  signals: readonly RetrievalSignal[],
): {
  candidates: Candidate[];
  evaluation: NonNullable<import('./engine.js').QueryState['evaluation']>;
} {
  const config = activationOptions(engine.options.activation);
  const indices = new Map(state.nodes.map((c, i) => [c.revision.revisionId, i]));
  const edges = state.edges.flatMap((edge) => {
    const from = indices.get(edge.from)!,
      to = indices.get(edge.to)!;
    const weights = Object.hasOwn(config.relations, edge.role)
      ? config.relations[edge.role]!
      : { forward: 1, reverse: 1 };
    return [
      { from, to, weight: weights.forward },
      { from: to, to: from, weight: weights.reverse },
    ];
  });
  // Freeze usage only after content-based acquisition and freshness validation.
  const usage = snapshotUse(
    engine,
    s,
    state.nodes.map((c) => c.revision),
  );
  const seeds = state.nodes.map((c, i) => {
    const body = engine.indexedBody(c.revision);
    return seedScore(body.text, body.vectors, signals) * usage.boosts[i]!;
  });
  const cacheKey = digest(
    canonical([
      bindingKey(s.binding.auth),
      s.principal.subject,
      s.principal.generation,
      s.trace.policies,
      engine.config,
    ]),
  );
  const capacity = engine.options.cacheMaxEntries ?? 512;
  const ttl = engine.options.cacheTtlMs ?? 300000;
  const now = Date.now();
  for (const [key, value] of engine.evaluations)
    if (value.expires <= now) engine.evaluations.delete(key);
  let cached = !s.overlay && capacity > 0 && ttl > 0 ? engine.evaluations.get(cacheKey) : undefined;
  if (
    cached &&
    [...cached.values.values()].some(
      (v) => engine.storage.isPurged(v.atomId) || !Number.isFinite(v.value) || v.value < 0,
    )
  ) {
    engine.evaluations.delete(cacheKey);
    cached = undefined;
  }
  const result = evaluateActivation(seeds, edges, {
    propagation: config.propagation,
    ledger: s.ledger,
    ids: state.nodes.map((c) => c.revision.revisionId),
    ...(cached
      ? { initial: state.nodes.map((c) => cached!.values.get(c.revision.revisionId)?.value ?? 0) }
      : {}),
    check: () => engine.check(s),
  });
  if (!s.overlay && capacity > 0 && ttl > 0) {
    engine.evaluations.delete(cacheKey);
    engine.evaluations.set(cacheKey, {
      expires: now + ttl,
      values: new Map(
        state.nodes.map((c, i) => [
          c.revision.revisionId,
          {
            atomId: c.revision.atomId,
            value: result.activation[i]!,
          },
        ]),
      ),
    });
    while (engine.evaluations.size > capacity)
      engine.evaluations.delete(engine.evaluations.keys().next().value!);
  }
  return {
    evaluation: {
      evaluatedAt: usage.at,
      evaluationConverged: result.diagnostics.converged,
      numericErrorL1Upper: result.diagnostics.errorL1Upper,
    },
    candidates: state.nodes
      .map((candidate, i) => ({
        ...candidate,
        score: result.scores[i]!,
        activation: result.activation[i]!,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Buffer.byteLength(canonical(a.revision.body)) -
            Buffer.byteLength(canonical(b.revision.body)) ||
          a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
      ),
  };
}
