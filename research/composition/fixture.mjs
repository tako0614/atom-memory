// Test/evaluation harness only. Reuses the actual authorization, freshness,
// candidate, graph and packing paths; does not replace public read/search.
import { MemoryHost, LocalAuthority, utf8Tokenizer } from '../../dist/index.js';
import { Engine } from '../../dist/client/engine.js';
import { startRanking, collectRanking } from '../../dist/client/ranking.js';
import { pack, validateMemory } from '../../dist/client/retrieval.js';
import { rankingOptions, propagate } from './reference-ranking.mjs';
import { compileComposition } from './evaluator.mjs';

// Mirrors numeric graph construction at the RFC baseline commit; compared
// against the frozen v0.5 PPR reference. Production 0.6 uses signed residual evaluation.
function rankingGraph(state, options) {
  const config = rankingOptions(options);
  const indices = new Map(state.nodes.map((c, i) => [c.revision.revisionId, i]));
  const edges = state.edges.flatMap((edge) => {
    const from = indices.get(edge.from),
      to = indices.get(edge.to);
    const weights = Object.hasOwn(config.relations, edge.role)
      ? config.relations[edge.role]
      : { forward: 1, reverse: 1 };
    return [
      { from, to, weight: weights.forward },
      { from: to, to: from, weight: weights.reverse },
    ];
  });
  return { seeds: state.nodes.map((c) => c.score), edges };
}

export const budget = {
  maxAtoms: 1024,
  maxCandidates: 200000,
  maxBytes: 64000000,
  maxContextTokens: 2000000,
  maxModelInputTokens: 2000000,
  maxModelCalls: 10000,
};
export async function prepare(host, binding) {
  let cursor;
  for (let i = 0; i < 100; i++) {
    const result = await host.prepareIndex(binding, { budget, cursor });
    if (!result.pending) return;
    cursor = result.cursor;
    if (!cursor) throw Error('Index preparation did not advance');
  }
  throw Error('Index preparation did not complete');
}
export async function atomFixture(storage, count = 4, width = 6, embedding) {
  const authority = new LocalAuthority();
  const binding = {
    auth: authority.issue({
      subject: 'composition',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    }),
    writePolicy: 'p',
    actor: { type: 'human' },
  };
  const options = {
    authority,
    storage,
    defaults: budget,
    embedding: embedding ?? {
      id: 'composition-fixed',
      dimensions: 2,
      networkCallsPerCall: 0,
      tokenizer: utf8Tokenizer,
      embed: async (texts) =>
        texts.map((text) => {
          let hash = 7;
          for (const c of text) hash = (Math.imul(hash, 31) + c.codePointAt(0)) >>> 0;
          return [0.1 + (hash % 997) / 997, 0.1 + ((hash >>> 10) % 991) / 991];
        }),
    },
    activation: { propagation: 0.65 },
    retrieval: {
      maxSeeds: 512,
      maxNodes: 512,
      maxEdges: 10000,
      depth: 4,
    },
  };
  const host = new MemoryHost(options),
    memory = host.connect(binding),
    engine = new Engine(options);
  const groups = [],
    leaves = [],
    regions = [];
  for (let group = 0; group < count; group++) {
    const members = [];
    for (let item = 0; item < width; item++) {
      const ref = await memory.write({
        text: `record ${group}:${item}`,
        links: item ? { preceding: members[item - 1].ref } : undefined,
      });
      members.push(ref);
      leaves.push(ref);
    }
    // One identity belongs to two groups; it is never copied.
    if (group) members.push(leaves[(group - 1) * width + width - 1]);
    const parent = await memory.write({
      text: `collection ${group}`,
      links: { member: members.map((m) => m.ref) },
    });
    groups.push(parent);
    regions.push([parent.ref, ...members.map((m) => m.ref)]);
  }
  const root = await memory.write({
    text: 'community collection',
    links: { member: groups.map((g) => g.ref) },
  });
  regions.push([root.ref, ...groups.map((g) => g.ref), ...leaves.map((g) => g.ref)]);
  await prepare(host, binding);
  const atomId = (ref) => storage.metaGet(`sdk:ref:${ref}`).target.atomId;
  return {
    storage,
    host,
    memory,
    engine,
    options: {
      ...options,
      ranking: rankingOptions({
        ...options.retrieval,
        ...options.activation,
        maxIterations: 1000,
        tolerance: 1e-13,
      }),
    },
    binding,
    groups,
    leaves,
    root,
    regions: regions.map((refs) => refs.map(atomId)),
    atomId,
  };
}

export async function acquire(f, context = 'initial context') {
  const session = f.engine.session(f.binding, { budget });
  const found = await f.engine.candidates({ context }, session);
  const eligible = found.candidates.filter((c) => validateMemory(f.engine, c.revision, session));
  const state = startRanking(eligible, 4, f.options.retrieval);
  if (!collectRanking(f.engine, session, state) || state.truncated)
    throw Error('Fixture graph is incomplete');
  // Canonicalize the same graph for query-independent reuse. Revision IDs are
  // retained on Candidates; logical IDs order this current-head-only fixture.
  state.nodes.sort((a, b) => a.revision.atomId.localeCompare(b.revision.atomId, 'en'));
  const index = new Map(state.nodes.map((c, i) => [c.revision.atomId, i]));
  const regions = f.regions.map((ids) =>
    ids.filter((id) => index.has(id)).map((id) => index.get(id)),
  );
  return { session, state, regions, ...rankingGraph(state, f.options.ranking) };
}

export async function comparePacked(f, graph, cache, tokens = 2000000, limit = 512) {
  const compiled = compileComposition(graph.state.nodes.length, graph.edges, graph.regions, {
    propagation: f.options.ranking.propagation,
    cache,
  });
  const query = compiled.solve(graph.seeds),
    scores = query.scores();
  const total = graph.seeds.reduce((a, b) => a + b, 0);
  const composed = graph.state.nodes.map((candidate, i) => {
    const direct = ((1 - f.options.ranking.propagation) * graph.seeds[i]) / total;
    return {
      ...candidate,
      score: scores[i],
      scoreBreakdown: { direct, structural: scores[i] - direct },
    };
  });
  const evaluated = propagate(graph.seeds, graph.edges, f.options.ranking);
  const iterative = graph.state.nodes
    .map((candidate, i) => ({ ...candidate, score: evaluated.scores[i] }))
    .filter((c) => c.score > 0);
  const reference = await pack(
    f.engine,
    f.engine.session(f.binding, { budget }),
    iterative,
    tokens,
    limit,
  );
  const folded = await pack(
    f.engine,
    f.engine.session(f.binding, { budget }),
    composed,
    tokens,
    limit,
  );
  const expected = new Map(iterative.map((c) => [c.revision.revisionId, c.score]));
  return {
    compiled,
    query,
    reference,
    folded,
    maximumError: Math.max(
      0,
      ...composed.map((c) => Math.abs(c.score - (expected.get(c.revision.revisionId) ?? 0))),
    ),
  };
}
