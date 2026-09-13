import type { Candidate, SelectionDiagnostics } from './types.js';
import type { Engine, Session } from './engine.js';
import { packingMaterials, type Packed, type PackingSolution } from './retrieval.js';
import { AtomMemoryError, canonical } from '../core/util.js';

/** Bounded marginal gains on existing activation. No role-specific scoring or optimality claim. */
export function select(
  engine: Engine,
  s: Session,
  candidates: readonly Candidate[],
  tokens: number,
  limit: number,
  evaluated: readonly Candidate[] = candidates,
): Packed & { selection: SelectionDiagnostics } {
  const weights = new Map(evaluated.map((c) => [c.revision.revisionId, c]));
  const evaluator = packingMaterials(engine, s, (id) => weights.get(id));
  const start = s.ledger.usage().maxPackingWork;
  const ranked = [...candidates]; // already fixed by the common evaluation
  let best = evaluator.empty,
    baseline = evaluator.empty,
    baselineComplete = false,
    complete = true;
  let minimumTokens: number | undefined;
  const eligible = new Set<string>();
  const eligibleLimit = Math.min(limit, s.ledger.remaining('maxAtoms'));
  const fits = (x: PackingSolution) => x.tokenCount <= tokens && x.items.length <= eligibleLimit;
  const identity = (x: PackingSolution) => canonical(x.revisions.map((r) => r.revisionId).sort());
  const better = (a: PackingSolution, b: PackingSolution) =>
    a.utility > b.utility ||
    (a.utility === b.utility &&
      (a.tokenCount < b.tokenCount ||
        (a.tokenCount === b.tokenCount && identity(a) < identity(b))));
  const keep = (x: PackingSolution) => {
    if (fits(x) && better(x, best)) best = x;
  };
  try {
    // Preserve the actual feasible rank-order baseline before allocating extra exploration work.
    for (const c of ranked) {
      evaluator.work();
      if (baseline.revisions.some((r) => r.revisionId === c.revision.revisionId)) continue;
      const unit = evaluator.closure(c.revision);
      if (!unit) continue;
      eligible.add(c.revision.revisionId);
      const trial = evaluator.evaluate([...baseline.revisions, ...unit]);
      if (fits(trial)) {
        baseline = trial;
        keep(baseline);
      } else {
        const single = evaluator.evaluate(unit);
        minimumTokens = Math.min(minimumTokens ?? Infinity, single.tokenCount);
        keep(single);
      }
    }
    baselineComplete = true;
    let greedy = evaluator.empty;
    const remaining = new Set(ranked.map((c) => c.revision.revisionId));
    while (remaining.size) {
      let winner:
        | { candidate: Candidate; solution: PackingSolution; ratio: number; gain: number }
        | undefined;
      for (const c of ranked) {
        evaluator.work();
        if (!remaining.has(c.revision.revisionId)) continue;
        if (greedy.revisions.some((r) => r.revisionId === c.revision.revisionId)) {
          remaining.delete(c.revision.revisionId);
          continue;
        }
        const unit = evaluator.closure(c.revision);
        if (!unit) {
          remaining.delete(c.revision.revisionId);
          continue;
        }
        eligible.add(c.revision.revisionId);
        const trial = evaluator.evaluate([...greedy.revisions, ...unit]);
        keep(trial);
        if (!fits(trial)) continue;
        const gain = trial.utility - greedy.utility;
        if (gain < 0) continue;
        const ratio = gain / Math.max(1, trial.tokenCount - greedy.tokenCount);
        const ref = c.revision.revisionId;
        if (
          !winner ||
          ratio > winner.ratio ||
          (ratio === winner.ratio &&
            (gain > winner.gain ||
              (gain === winner.gain &&
                (trial.tokenCount < winner.solution.tokenCount ||
                  (trial.tokenCount === winner.solution.tokenCount &&
                    ref < winner.candidate.revision.revisionId)))))
        )
          winner = { candidate: c, solution: trial, ratio, gain };
      }
      if (!winner) break;
      greedy = winner.solution;
      remaining.delete(winner.candidate.revision.revisionId);
      keep(greedy);
    }
  } catch (error) {
    if (error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED') complete = false;
    else throw error;
  }
  engine.check(s);
  s.ledger.charge({ maxAtoms: best.items.length, maxContextTokens: best.tokenCount });
  const selected = new Set(best.revisions.map((r) => r.revisionId));
  const blocked = s.blocked ?? new Set();
  return {
    items: best.items,
    text: best.text,
    tokenCount: best.tokenCount,
    sources: best.sources,
    used: ranked.filter((c) => selected.has(c.revision.revisionId)).length,
    deferred: ranked.filter(
      (c) =>
        !selected.has(c.revision.revisionId) &&
        (!complete || eligible.has(c.revision.revisionId)) &&
        !blocked.has(engine.issue(c.revision, s)),
    ),
    ...(minimumTokens ? { minimumTokens } : {}),
    selection: {
      method: 'bounded-marginal-gain',
      complete,
      baselineComplete,
      utility: best.utility,
      baselineUtility: baseline.utility,
      work: s.ledger.usage().maxPackingWork - start,
      ...(minimumTokens ? { minimumTokens } : {}),
    },
  };
}
