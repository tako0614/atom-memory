import { create, revise } from '../../test/fixtures.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { MemoryStorage, utf8Tokenizer } from '../../dist/index.js';
import { records, questions, texts } from './semantic-corpus.mjs';
import { atomFixture, acquire, prepare } from './fixture.mjs';
import { createResearchRead, prepareEvaluator } from './reader.mjs';
import { compileComposition } from './evaluator.mjs';
const vectors = JSON.parse(
  gunzipSync(readFileSync(new URL('semantic-vectors.json.gz', import.meta.url))).toString(),
);
assert.equal(
  createHash('sha256').update(JSON.stringify(texts())).digest('hex'),
  vectors.inputSha256,
);
const embedding = {
  id: `${vectors.model}@${vectors.revision}:q8`,
  dimensions: vectors.dimensions,
  networkCallsPerCall: 0,
  tokenizer: utf8Tokenizer,
  embed: async (texts) =>
    texts.map((t) => {
      const v = vectors.vectors[t];
      if (!v) throw Error(`Missing precomputed embedding: ${t}`);
      return v;
    }),
};
const storage = new MemoryStorage(),
  f = await atomFixture(storage, 0, 0, embedding);
const gold = [],
  evidence = [],
  regions = [],
  summaries = [];
try {
  const extractor = f.host.connect({
    ...f.binding,
    actor: { type: 'agent', generatedOrigin: 'extraction' },
  });
  // Corpus construction has no access to the future query or evaluation answer.
  for (const record of records()) {
    const source = await create(f.memory, record.source),
      boundary = Buffer.byteLength(record.claim);
    const condition = await create(extractor, record.condition, {
      sources: [{ ref: source.ref, start: boundary, end: Buffer.byteLength(record.source) }],
    });
    const claim = await create(
      extractor,
      { text: record.claim, links: { condition: { ref: condition.ref, required: true } } },
      { sources: [{ ref: source.ref, start: 0, end: boundary }] },
    );
    const history = [];
    for (const text of record.history) history.push(await create(f.memory, text));
    const members = [source, claim, condition, ...history];
    const summary = await create(f.memory, {
      text: record.summary,
      links: { member: members.map((x) => x.ref) },
    });
    summaries.push(summary);
    regions.push([summary, ...members].map((x) => f.atomId(x.ref)));
    gold.push([claim.ref, condition.ref]);
    evidence.push({
      source: source.ref,
      ranges: [
        [0, boundary],
        [boundary, Buffer.byteLength(record.source)],
      ],
    });
  }
  await revise(f.memory, f.root.ref, {
    text: 'community collection',
    links: { member: summaries.map((x) => x.ref) },
  });
  f.regions = [...regions, [f.atomId(f.root.ref), ...regions.flat()]];
  await prepare(f.host, f.binding);
  const results = [];
  for (let i = 0; i < questions.length; i++) {
    const started = performance.now(),
      g = await acquire(f, questions[i]),
      acquisitionMs = performance.now() - started;
    const fullScores = compileComposition(g.seeds.length, g.edges, [], { propagation: 0.65 })
      .solve(g.seeds)
      .scores();
    const ingress = g.seeds
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score);
    const top8 = ingress.slice(0, 8).map((x) => x.index);
    const goldIds = gold[i].map((ref) => f.atomId(ref));
    const goldSeedRecall =
      top8.filter((index) => goldIds.includes(g.state.nodes[index].revision.atomId)).length /
      goldIds.length;
    for (const variant of ['full', 'top64-seeds', 'top8-seeds', 'top8-graph', 'missed-topic']) {
      let graph = g;
      if (variant === 'top64-seeds') {
        const top64 = ingress.slice(0, 64).map((x) => x.index);
        graph = { ...g, seeds: g.seeds.map((v, j) => (top64.includes(j) ? v : 0)) };
      }
      if (variant === 'missed-topic') {
        const missed = new Set(regions[i]);
        graph = {
          ...g,
          seeds: g.seeds.map((v, j) => (missed.has(g.state.nodes[j].revision.atomId) ? 0 : v)),
        };
      }
      if (variant === 'top8-seeds')
        graph = { ...g, seeds: g.seeds.map((v, j) => (top8.includes(j) ? v : 0)) };
      if (variant === 'top8-graph') {
        const indices = [...top8].sort((a, b) => a - b),
          mapped = new Map(indices.map((old, next) => [old, next]));
        graph = {
          ...g,
          seeds: indices.map((j) => g.seeds[j]),
          state: { ...g.state, nodes: indices.map((j) => g.state.nodes[j]) },
          regions: g.regions.map((r) => r.filter((j) => mapped.has(j)).map((j) => mapped.get(j))),
          edges: g.edges
            .filter((e) => mapped.has(e.from) && mapped.has(e.to))
            .map((e) => ({ ...e, from: mapped.get(e.from), to: mapped.get(e.to) })),
        };
      }
      const scoped = compileComposition(graph.seeds.length, graph.edges, [], { propagation: 0.65 })
        .solve(graph.seeds)
        .scores();
      const scopedById = new Map(graph.state.nodes.map((c, j) => [c.revision.atomId, scoped[j]]));
      const wholeGraphScoreDifference = Math.max(
        ...fullScores.map((v, j) =>
          Math.abs(v - (scopedById.get(g.state.nodes[j].revision.atomId) ?? 0)),
        ),
      );
      for (const method of ['composition', 'block', 'flat', 'push']) {
        const start = performance.now(),
          prepared = prepareEvaluator(graph, method, 0.65),
          prepareMs = performance.now() - start;
        const reader = createResearchRead(f, graph, {
          prepared,
          maxWork: 2000000,
          tokens: 8192,
          limit: 8,
          coverage: {
            candidates: variant === 'full' ? 'exhaustive-this-fixture' : `controlled-${variant}`,
            graph:
              variant === 'top8-graph'
                ? 'controlled-truncation-renormalized'
                : 'complete-this-fixture',
          },
        });
        const begin = performance.now();
        reader.advance();
        const out = reader.finish(),
          readMs = performance.now() - begin;
        const refs = out.items.map((x) => x.ref);
        const spans = out.sources
          .filter((s) => s.ref === evidence[i].source)
          .sort((a, b) => a.start - b.start);
        const covered = ([start, end]) => {
          let position = start;
          for (const s of spans) {
            if (s.start > position) break;
            if (s.end > position) position = s.end;
          }
          return position >= end;
        };
        const evidenceRecall =
          evidence[i].ranges.filter(covered).length / evidence[i].ranges.length;
        let conditionOmissions = 0;
        for (const item of out.items)
          for (const link of item.links)
            if (link.required && !refs.includes(link.ref)) conditionOmissions++;
        assert.equal(conditionOmissions, 0);
        results.push({
          question: i,
          variant,
          method,
          nodes: graph.seeds.length,
          goldSeedRecall,
          goldAtomRecall: gold[i].filter((ref) => refs.includes(ref)).length / gold[i].length,
          goldEvidenceRecall: evidenceRecall,
          fullGoldEvidenceReturned: evidenceRecall === 1,
          conditionOmissions,
          wholeGraphScoreDifference,
          acquisitionMs,
          prepareMs,
          readMs,
          work: out.evaluation.work,
          completeWithinSelectedGraph: out.evaluation.complete,
          outputTokens: out.tokenCount,
          outputAtomIds: out.items.map((x) => f.atomId(x.ref)),
          outputTexts: out.items.map((x) => x.text),
          coverage: out.evaluation.coverage,
          globalCoverageCertified: false,
        });
      }
    }
  }
  const record = {
    at: new Date().toISOString(),
    model: vectors.model,
    revision: vectors.revision,
    runtime: vectors.runtime,
    dtype: vectors.dtype,
    embeddingMs: vectors.embeddingMs,
    vectorSha256: createHash('sha256')
      .update(readFileSync(new URL('semantic-vectors.json.gz', import.meta.url)))
      .digest('hex'),
    sourceSha256: Object.fromEntries(
      [
        'semantic-corpus.mjs',
        'embed-semantic.mjs',
        'evaluate-semantic.mjs',
        'reader.mjs',
        'evaluator.mjs',
        'linear.mjs',
        '../../src/client/retrieval.ts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(new URL(file, import.meta.url)))
          .digest('hex'),
      ]),
    ),
    corpus:
      '97 synthetic Japanese community records including 72 chronological activity messages; deterministic policy structure built before queries; six fixed evaluation paraphrases; not an independently authored blind benchmark',
    results,
    limitations: [
      'Small synthetic corpus, not a real Discord history or a Writer quality evaluation',
      'Controlled top-8 restriction is a sensitivity test, not an ANN implementation',
      'Gold evidence checks both original-source spans; returning their containing source also counts, separate from exact Atom-ID recall',
      'No LLM response or paid inference calls; model ran locally on CPU',
      'Condition closure may fetch evidence outside the numerical graph; graph approximation remains explicit',
    ],
  };
  if (process.argv.includes('--record'))
    writeFileSync(
      new URL('semantic-results.json', import.meta.url),
      JSON.stringify(record, null, 2) + '\n',
    );
  console.log(JSON.stringify(record, null, 2));
} finally {
  storage.close();
}
