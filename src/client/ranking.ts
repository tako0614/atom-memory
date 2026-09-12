import type { AtomRevision, PinnedRef } from '../contracts.js';
import type { Candidate, RankingOptions } from './types.js';
import { type Engine, type Session, pinRevision } from './engine.js';
import { AtomMemoryError, canonical } from '../core/util.js';
import { propagate, rankingOptions } from '../core/ranking.js';

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
  options?: RankingOptions,
): RankingState {
  const config = rankingOptions(options);
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
  const config = rankingOptions(engine.options.ranking);
  const nodes = new Set(state.nodes.map((c) => c.revision.revisionId));
  const edges = new Set(state.edges.map((e) => canonical(e)));
  const addNode = (r: AtomRevision, depth: number): boolean => {
    if (r.state !== 'active') return false;
    if (nodes.has(r.revisionId)) return true;
    if (nodes.size >= config.maxNodes) {
      state.truncated = true;
      return false;
    }
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
        const weights = Object.hasOwn(config.relations, slot.role)
          ? config.relations[slot.role]
          : undefined;
        if (!weights || weights.forward || weights.reverse) {
          const target = engine.get(slot.target, s, slot.target.kind === 'logical');
          if (addNode(target, task.depth + 1)) addEdge(r, target, slot.role);
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
          const weights = Object.hasOwn(config.relations, slot.role)
            ? config.relations[slot.role]
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
      if (state.edges.length >= config.maxEdges || state.nodes.length >= config.maxNodes) {
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
export function finishRanking(engine: Engine, s: Session, state: RankingState): Candidate[] {
  const config = rankingOptions(engine.options.ranking);
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
  const result = propagate(
    state.nodes.map((c) => c.score),
    edges,
    config,
    () => engine.check(s),
  );
  state.truncated ||= !result.converged;
  return state.nodes
    .map((candidate, i) => ({
      ...candidate,
      score: result.scores[i]!,
      scoreBreakdown: result.breakdown[i]!,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Buffer.byteLength(canonical(a.revision.body)) -
          Buffer.byteLength(canonical(b.revision.body)) ||
        a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
    );
}
