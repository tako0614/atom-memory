// Research-only read controller. Production read/search keep their evaluator.
import { createPacking } from '../../dist/client/retrieval.js';
import { canonical, fail } from '../../dist/core/util.js';
import { compileComposition } from './evaluator.mjs';
import { compileLinear } from './linear.mjs';
import { WorkBudget } from './work.mjs';
import { budget as fixtureBudget } from './fixture.mjs';

export function prepareEvaluator(graph, method, propagation = 0.65, cache) {
  if (method === 'composition' || method === 'block') {
    const plan = compileComposition(
      graph.seeds.length,
      graph.edges,
      method === 'block' ? [] : graph.regions,
      { propagation, cache },
    );
    return {
      stats: plan.stats,
      start: (seeds, spend, previousRaw) =>
        previousRaw ? plan.correct(seeds, previousRaw, { spend }) : plan.solve(seeds, { spend }),
    };
  }
  if (method !== 'flat' && method !== 'push') throw Error('Unknown evaluator');
  const plan = compileLinear(graph.seeds.length, graph.edges, propagation);
  return {
    start: (seeds, spend, previousRaw) => plan.query(seeds, { mode: method, spend, previousRaw }),
  };
}

export function createResearchRead(
  f,
  graph,
  {
    prepared = prepareEvaluator(graph, 'composition', f.options.ranking.propagation),
    maxWork = 1_000_000,
    tokens = 8192,
    limit = 8,
    budget = {},
    previous,
    coverage = { candidates: 'unmeasured', graph: 'selected-bounded-graph' },
  } = {},
) {
  const engine = f.engine,
    work = new WorkBudget(maxWork);
  const s = engine.session(f.binding, {
    budget: { ...fixtureBudget, ...budget, maxContextTokens: tokens },
  });
  const at = f.storage.watermark(),
    generation = f.storage.metaGet('sdk:index-generation');
  if (at !== graph.session.at || s.principal.generation !== graph.session.principal.generation)
    fail('STATE_INVALIDATED');
  const nodes = graph.state.nodes,
    ids = nodes.map((c) => c.revision.atomId);
  const byRevision = new Map(nodes.map((c, i) => [c.revision.revisionId, i]));
  const byAtom = new Map(nodes.map((c, i) => [c.revision.atomId, i]));
  const total = graph.seeds.reduce((a, b) => a + b, 0);
  const old = previous && canonical(previous.ids) === canonical(ids) ? previous.raw : undefined;
  let query,
    lastBounds,
    stopped = 'ready',
    finalized = false,
    attempted = 0;
  const excluded = new Set();
  const check = () => {
    engine.check(s);
    if (finalized) fail('INVALID_INPUT', 'Research read finished');
    if (f.storage.watermark() !== at || f.storage.metaGet('sdk:index-generation') !== generation)
      fail('STATE_INVALIDATED', 'Research read graph changed; reacquire before resuming');
  };
  const scored = (i) => {
    const score = query.score(i),
      direct = total ? ((1 - f.options.ranking.propagation) * graph.seeds[i]) / total : 0;
    return { ...nodes[i], score, scoreBreakdown: { direct, structural: score - direct } };
  };
  const packing = createPacking(
    engine,
    s,
    (revisionId) => (byRevision.has(revisionId) ? scored(byRevision.get(revisionId)) : undefined),
    tokens,
    limit,
  );
  const bodyBytes = nodes.map((c) => Buffer.byteLength(canonical(c.revision.body)));
  const tie = (a, b) => bodyBytes[a] - bodyBytes[b] || ids[a].localeCompare(ids[b], 'en');
  function outputEstimate(index) {
    // Scheduling estimate only; final acceptance always uses exact shared packing.
    // Include known companions and origins, once per identity. Unknown external
    // evidence is never assumed free: a small floor admits uncertainty explicitly.
    const seen = new Set(),
      pending = [index];
    let bytes = 0;
    while (pending.length) {
      const i = pending.pop();
      if (seen.has(i) || packing.has(nodes[i].revision.revisionId)) continue;
      work.take(1);
      seen.add(i);
      bytes += bodyBytes[i] + 1;
      for (const link of nodes[i].revision.slots)
        if (link.mode === 'include' || link.required) {
          work.take(1);
          const target =
            link.target.kind === 'pinned'
              ? byRevision.get(link.target.revisionId)
              : byAtom.get(link.target.atomId);
          if (target === undefined) bytes += 1;
          else pending.push(target);
        }
      for (const origin of nodes[i].revision.origins) {
        work.take(1);
        const target = byRevision.get(origin.source.revisionId);
        if (target === undefined) bytes += Math.max(1, origin.selector.end - origin.selector.start);
        else pending.push(target);
      }
    }
    return Math.max(1, bytes);
  }
  return {
    work,
    advance(newMaxWork = work.limit) {
      check();
      work.extend(newMaxWork);
      try {
        query ??= prepared.start(graph.seeds, work.take, old);
        while (!packing.full) {
          check();
          const available = nodes
            .map((_, i) => i)
            .filter((i) => !excluded.has(i) && !packing.has(nodes[i].revision.revisionId));
          if (!available.length) {
            stopped = 'complete';
            return this.status();
          }
          work.take(available.length);
          const bounds = query.bounds();
          lastBounds = bounds;
          const best = available.reduce((a, b) =>
            bounds[b][0] > bounds[a][0] || (bounds[b][0] === bounds[a][0] && tie(b, a) < 0) ? b : a,
          );
          const resolved = available.every(
            (i) =>
              i === best ||
              bounds[best][0] > bounds[i][1] ||
              (bounds[best][0] === bounds[best][1] &&
                bounds[i][0] === bounds[i][1] &&
                bounds[best][0] === bounds[i][0] &&
                tie(best, i) < 0),
          );
          if (resolved) {
            const result = packing.offer(scored(best));
            if (result === 'exhausted') {
              stopped = 'storage-budget';
              return this.status();
            }
            excluded.add(best);
            attempted++;
          } else {
            let chosen,
              priority = -Infinity;
            for (const i of available)
              if (!query.known(i) && bounds[i][1] >= bounds[best][0]) {
                const benefit = bounds[i][1] / (query.recoveryCost(i) + outputEstimate(i));
                if (chosen === undefined || benefit > priority) {
                  chosen = i;
                  priority = benefit;
                }
              }
            if (chosen === undefined) {
              stopped = 'unresolved';
              return this.status();
            }
            query.refine(chosen);
          }
        }
        stopped = 'output-limit';
      } catch (e) {
        if (e.code !== 'BUDGET_EXHAUSTED') throw e;
        stopped = 'numeric-budget';
      }
      return this.status();
    },
    status() {
      return {
        reason: stopped,
        work: work.used,
        items: packing.itemCount,
        tokens: packing.tokenCount,
        attempted,
        complete: ['complete', 'output-limit'].includes(stopped),
        scope: query?.certificateScope ?? 'compiled-numeric-scores',
        unresolvedCandidates: nodes.filter(
          (c, i) => !excluded.has(i) && !packing.has(c.revision.revisionId),
        ).length,
        unresolvedUpper: Math.max(
          0,
          ...nodes.map((c, i) =>
            excluded.has(i) || packing.has(c.revision.revisionId) ? 0 : (lastBounds?.[i]?.[1] ?? 1),
          ),
        ),
        coverage,
      };
    },
    finish() {
      check();
      const result = packing.finish();
      finalized = true;
      return {
        ...result,
        evaluation: this.status(),
        storageUsage: s.ledger.usage(),
        numeric: query?.stats,
      };
    },
  };
}
