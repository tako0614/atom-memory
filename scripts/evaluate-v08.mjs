import { create } from '../test/fixtures.mjs';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fixture } from '../test/fixtures.mjs';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { packingMaterials, pack } from '../dist/client/retrieval.js';
import { select } from '../dist/client/selection.js';
const budget = {
  maxCandidates: 50000,
  maxBytes: 64000000,
  maxAtoms: 100,
  maxContextTokens: 100000,
  maxPackingWork: 100000000,
};
const definitions = [
  {
    name: 'long explanation and short facts',
    bodies: ['needle '.repeat(300), 'needle short a', 'needle short b', 'needle short c'],
    tokens: 2500,
    useFirst: true,
    evidence: [1, 2, 3],
  },
  {
    name: 'explanation is answer',
    bodies: ['needle explanation contains the answer', 'unmatched detail'],
    tokens: 1000,
    evidence: [0],
  },
  {
    name: 'shared low-similarity condition',
    bodies: ['unmatched condition', 'needle one', 'needle two'],
    links: [
      [1, 0],
      [2, 0],
    ],
    tokens: 2100,
    evidence: [0, 1, 2],
  },
  {
    name: 'large mandatory condition',
    bodies: ['condition '.repeat(300), 'needle guarded', 'needle small'],
    links: [[1, 0]],
    tokens: 1800,
    evidence: [2],
  },
  {
    name: 'Japanese metadata and low-frequency condition',
    bodies: ['ただし管理者が承認した場合だけ', 'needle 説明', 'needle 仕様'],
    links: [[1, 0]],
    tokens: 1600,
    evidence: [0, 1, 2],
  },
  {
    name: 'ordinary parent can contribute',
    bodies: ['needle fact', 'needle parent explanation'],
    related: [[1, 0]],
    tokens: 1500,
    evidence: [0, 1],
  },
];
const reports = [];
const evaluatedAt = Date.UTC(2026, 8, 13);
for (const adapter of ['memory', 'sqlite'])
  for (const d of definitions) {
    const f = fixture({
      storage: adapter === 'sqlite' ? new SqliteStorage(':memory:') : undefined,
      activation: { propagation: 0 },
    });
    const clock = Date.now;
    Date.now = () => evaluatedAt;
    try {
      const values = [];
      for (let i = 0; i < d.bodies.length; i++) {
        const links = {};
        for (const [from, to] of d.links ?? [])
          if (from === i) links.when = { ref: values[to].ref, required: true };
        for (const [from, to] of d.related ?? []) if (from === i) links.member = values[to].ref;
        values.push(await create(f.memory, { text: d.bodies[i], links }));
      }
      if (d.useFirst)
        f.host.recordUse([values[0].ref], f.binding, { eventId: 'fixed-comparison-event' });
      // Real acquisition/authorization/evaluation, frozen once; the same production renderer is used by all three policies.
      const acquired = await f.memory.retrieve(
        'read',
        { query: 'needle' },
        { depth: 0, budget },
        'v08-comparison',
      );
      const candidates = acquired.state.candidates;
      const session = () =>
        f.host.engine.session(f.binding, { budget }, undefined, undefined, acquired.s.at);
      const weights = new Map(candidates.map((c) => [c.revision.revisionId, c]));
      const baseline = await pack(f.host.engine, session(), candidates, d.tokens, 24);
      const material = packingMaterials(f.host.engine, session(), (id) => weights.get(id));
      const pins = new Map(
        candidates.map((c) => [f.host.engine.issue(c.revision, session()), c.revision]),
      );
      const baselineRevisions = baseline.items.map(
        (v) =>
          pins.get(v.ref) ??
          f.host.engine.get(f.host.engine.resolve(v.ref, session()).target, session()),
      );
      const baselineU = material.evaluate(baselineRevisions).utility;
      const started = performance.now();
      const selected = select(f.host.engine, session(), candidates, d.tokens, 24);
      const latencyMs = performance.now() - started;
      let oracle = 0,
        oracleTokens = 0,
        enumerated = 0;
      for (let mask = 0; mask < 2 ** candidates.length; mask++) {
        let revisions = [];
        let valid = true;
        for (let i = 0; i < candidates.length; i++)
          if (mask & (1 << i)) {
            const closure = material.closure(candidates[i].revision);
            if (!closure) {
              valid = false;
              break;
            }
            revisions.push(...closure);
          }
        if (!valid) continue;
        const solution = material.evaluate(revisions);
        enumerated++;
        if (
          solution.tokenCount <= d.tokens &&
          (solution.utility > oracle ||
            (solution.utility === oracle && solution.tokenCount < oracleTokens))
        ) {
          oracle = solution.utility;
          oracleTokens = solution.tokenCount;
        }
      }
      assert.ok(Math.abs(baselineU - selected.selection.baselineUtility) < 1e-10);
      assert.ok(selected.selection.utility + 1e-10 >= baselineU);
      assert.ok(selected.selection.utility <= oracle + 1e-10);
      assert.ok(selected.tokenCount <= d.tokens);
      const evidence = (items) => {
        const refs = new Set(items.map((i) => i.ref));
        const found = d.evidence.filter((i) => refs.has(values[i].ref)).length;
        return { required: d.evidence.length, found, complete: found === d.evidence.length };
      };
      const missingRequired = (items) => {
        const refs = new Set(items.map((i) => i.ref));
        return items.flatMap((i) => i.links).filter((l) => l.required && !refs.has(l.ref)).length;
      };
      assert.equal(missingRequired(baseline.items), 0);
      assert.equal(missingRequired(selected.items), 0);
      reports.push({
        adapter,
        scenario: d.name,
        candidates: candidates.length,
        budget: d.tokens,
        baselineU,
        selectedU: selected.selection.utility,
        oracleU: oracle,
        oracleGap: oracle - selected.selection.utility,
        baselineTokens: baseline.tokenCount,
        selectedTokens: selected.tokenCount,
        oracleTokens,
        baselineEvidence: evidence(baseline.items),
        selectedEvidence: evidence(selected.items),
        baselineMissingRequired: missingRequired(baseline.items),
        selectedMissingRequired: missingRequired(selected.items),
        enumerated,
        packingWork: selected.selection.work,
        acquisitionCandidates: acquired.s.ledger.usage().maxCandidates,
        latencyMs,
        complete: selected.selection.complete,
        baselineComplete: selected.selection.baselineComplete,
      });
    } finally {
      Date.now = clock;
      f.storage.close();
    }
  }
const output = {
  node: process.version,
  baseline: 'v0.7 rank-order closure policy, v0.8 shared render/cost contract',
  tokenizer: 'utf8-bytes-v1',
  evaluatedAt,
  reports,
  realLLM: false,
  claim:
    'Finite proxy utility comparison only; no semantic quality, optimality, approximation ratio, or novelty claim.',
};
writeFileSync(
  new URL('../validation/selection-v0.9.0.json', import.meta.url),
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    comparisons: reports.length,
    improvements: reports.filter((r) => r.selectedU > r.baselineU + 1e-10).length,
    oracleGaps: reports.filter((r) => r.oracleGap > 1e-10).length,
    realLLM: false,
  }),
);
