import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from './fixtures.mjs';
import { prepareFixture, ampleBudget } from './setup.mjs';
import { checkNumeric } from './reference.mjs';
import { runVariant } from './harness.mjs';
import { MemoryHost, MemoryStorage, LocalAuthority } from '../../dist/index.js';
import { create, revise, fixture as standardFixture } from '../../test/fixtures.mjs';
import {
  createCollector,
  stepCollector,
  finishCollector,
  assertCollectorInvariants,
  COLLECTOR_MODES,
} from './collector.mjs';

async function collect(prepared, variant, mode, options = {}) {
  const session = variant.engine.session(variant.binding, { budget: ampleBudget });
  session.at = variant.storage.watermark();
  const ingress = await variant.engine.candidates({ context: prepared.fixture.context }, session);
  const rootLedger = session.ledger;
  session.ledger = rootLedger.window({
    maxCandidates: Math.floor(rootLedger.remaining('maxCandidates') / 2),
    maxBytes: Math.floor(rootLedger.remaining('maxBytes') / 2),
    maxEvaluationWork: rootLedger.remaining('maxEvaluationWork'),
  });
  const state = createCollector({
    engine: variant.engine,
    session,
    candidates: ingress.candidates,
    signals: ingress.signals,
    depth: prepared.fixture.depth,
    mode,
    evaluatedAt: prepared.evaluatedAt,
    rootLedger,
    ...options,
  });
  let steps = 0;
  for (;;) {
    const event = stepCollector(state);
    assertCollectorInvariants(state);
    options.onStep?.(state, event);
    assert.ok(++steps < 10000, 'a finite fixture must terminate');
    if (event.complete) break;
  }
  const final = finishCollector(state);
  return { state, final, signals: ingress.signals };
}

test('a late shorter route reopens a depth-capped node and discovers its descendant', async () => {
  const fixture = {
    id: 'late-shortcut',
    nodes: [
      {
        id: 'strong',
        text: 'Alpha record',
        vector: [1, 0, 0, 0],
        links: [{ to: 'long', role: 'path' }],
      },
      {
        id: 'quiet',
        text: 'Beta record',
        vector: [0.0001, 1, 0, 0],
        links: [{ to: 'shared', role: 'path' }],
      },
      {
        id: 'long',
        text: 'Gamma record',
        vector: [0, 1, 0, 0],
        links: [{ to: 'shared', role: 'path' }],
      },
      {
        id: 'shared',
        text: 'Delta record',
        vector: [0, 0, 1, 0],
        links: [{ to: 'descendant', role: 'path' }],
      },
      { id: 'descendant', text: 'Epsilon record', vector: [0, 0, 0, 1] },
    ],
    seeds: ['strong', 'quiet'],
    context: 'focus',
    contextVector: [1, 0, 0, 0],
    depth: 2,
    relations: { path: { forward: 1, reverse: 0 } },
  };
  const prepared = await prepareFixture(fixture);
  const variant = prepared.makeVariant();
  const depths = [];
  try {
    const { state } = await collect(prepared, variant, 'priority-only', {
      onStep(state) {
        if (state.depths.has('v010-shared')) depths.push(state.depths.get('v010-shared'));
      },
    });
    assert.equal(depths[0], 2, 'the longer path must actually be encountered first');
    assert.equal(depths.at(-1), 1, 'the later shortcut must lower the known distance');
    assert.ok(state.nodes.some(({ revision }) => revision.atomId === 'descendant'));
    assert.equal(state.depths.get('v010-descendant'), 2);
  } finally {
    variant.close();
  }
});

test('alternate traversal excludes inaccessible required targets and blocks their parent', async (t) => {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'owner',
    readPolicies: ['p', 'q'],
    writePolicies: ['p', 'q'],
    canIngestSource: true,
  });
  const storage = new MemoryStorage();
  t.after(() => storage.close());
  let candidates = [];
  const host = new MemoryHost({
    authority,
    storage,
    cacheMaxEntries: 0,
    candidateProvider: {
      id: 'scoped-ingress',
      async retrieve() {
        return {
          candidates,
          scanned: candidates.length,
          complete: true,
          pending: false,
          approximate: true,
        };
      },
    },
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const privateAtom = await create(
    host.connect({ ...binding, writePolicy: 'q' }),
    'needle private condition',
  );
  const root = await create(host.connect(binding), {
    text: 'needle public claim',
    links: { condition: { ref: privateAtom.ref, required: true } },
  });
  candidates = [storage.metaGet(`sdk:ref:${root.ref}`).target];
  for (const mode of ['fair-only', 'fair-evaluated', 'active-fair']) {
    host.engine.evaluations.clear();
    const result = await runVariant({
      engine: host.engine,
      binding: { ...binding, readPolicies: ['p'] },
      input: { context: 'needle' },
      mode,
      budget: ampleBudget,
      tokens: 8000,
      depth: 2,
      evaluatedAt: Date.now(),
    });
    assert.ok(result.graph.nodes.every(({ revision }) => revision.policyId === 'p'));
    assert.equal(result.items.length, 0, 'a required private body may not be silently omitted');
    assert.ok(!result.text.includes('private condition'));
  }
});

test('alternate traversal excludes stale generated conditions after their source changes', async (t) => {
  let candidates = [];
  const f = standardFixture({
    cacheMaxEntries: 0,
    candidateProvider: {
      id: 'stale-ingress',
      async retrieve() {
        return {
          candidates,
          scanned: candidates.length,
          complete: true,
          pending: false,
          approximate: true,
        };
      },
    },
  });
  t.after(() => f.storage.close());
  const source = await create(f.memory, 'old approval source');
  const observed = await f.writer.inspect(source.ref);
  const input = f.host.observe(
    { presentations: [{ receipt: observed.receipt }], payloadDigest: 'a'.repeat(64) },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const derived = await create(f.writer, 'needle approval condition', { input });
  const root = await create(f.memory, {
    text: 'needle claim',
    links: { condition: { ref: derived.ref, required: true } },
  });
  candidates = [f.storage.metaGet(`sdk:ref:${root.ref}`).target];
  await revise(f.memory, source.ref, 'withdrawn approval source');
  const staleId = f.storage.metaGet(`sdk:ref:${derived.ref}`).target.revisionId;
  for (const mode of ['fair-only', 'fair-evaluated', 'active-fair']) {
    f.host.engine.evaluations.clear();
    const result = await runVariant({
      engine: f.host.engine,
      binding: f.binding,
      input: { context: 'needle' },
      mode,
      budget: ampleBudget,
      tokens: 8000,
      depth: 2,
      evaluatedAt: Date.now(),
    });
    assert.ok(result.graph.nodes.every(({ revision }) => revision.revisionId !== staleId));
    assert.equal(result.items.length, 0, 'stale required generation blocks the parent');
  }
});

for (const adapter of ['memory', 'sqlite']) {
  test(`every complete acquired graph agrees with independent dense evaluation (${adapter})`, async () => {
    for (const fixture of fixtures) {
      const prepared = await prepareFixture(fixture);
      let baseline;
      for (const mode of COLLECTOR_MODES) {
        const variant = prepared.makeVariant(adapter);
        try {
          const { state, final, signals } = await collect(prepared, variant, mode);
          checkNumeric(
            variant,
            state.nodes,
            state.edges,
            final.candidates,
            signals,
            prepared.evaluatedAt,
            final.evaluation.numericErrorL1Upper,
          );
          assert.equal(final.evaluation.evaluatedAt, prepared.evaluatedAt);
          if (mode === 'fifo-v09')
            baseline = new Set(state.nodes.map(({ revision }) => revision.revisionId));
          if (mode === 'fair-only' || mode === 'active-fair')
            assert.deepEqual(
              new Set(state.nodes.map(({ revision }) => revision.revisionId)),
              baseline,
              `${fixture.id}: complete traversal set`,
            );
        } finally {
          variant.close();
        }
      }
    }
  });

  test(`node capacity preserves edges between already admitted nodes (${adapter})`, async () => {
    const fixture = {
      id: 'node-cap',
      nodes: [
        {
          id: 'a',
          text: 'entry a',
          vector: [1, 0, 0, 0],
          links: [
            { to: 'c', role: 'next' },
            { to: 'b', role: 'next' },
          ],
        },
        { id: 'b', text: 'entry b', vector: [1, 0, 0, 0], links: [{ to: 'a', role: 'next' }] },
        { id: 'c', text: 'excluded c', vector: [0, 1, 0, 0] },
      ],
      seeds: ['a', 'b'],
      context: 'entry',
      contextVector: [1, 0, 0, 0],
      depth: 2,
      maxNodes: 2,
    };
    const prepared = await prepareFixture(fixture);
    for (const mode of ['fair-only', 'active-fair']) {
      const variant = prepared.makeVariant(adapter);
      try {
        const { state } = await collect(prepared, variant, mode);
        assert.equal(state.nodes.length, 2);
        assert.equal(state.edges.length, 2);
        assert.ok(state.truncated, 'rejected new node keeps the graph partial');
      } finally {
        variant.close();
      }
    }
  });

  test(`erased required information is never used as a traversal node (${adapter})`, async () => {
    const fixture = fixtures.find((fixture) => fixture.id === 'shared-mandatory-condition');
    const prepared = await prepareFixture(fixture);
    const missing = fixture.conditionPairs[0][1];
    for (const mode of ['fifo-v09', 'fair-only', 'active-fair']) {
      const variant = prepared.makeVariant(adapter);
      try {
        variant.storage.erase([missing]);
        const { state } = await collect(prepared, variant, mode);
        assert.ok(state.nodes.every(({ revision }) => revision.atomId !== missing));
      } finally {
        variant.close();
      }
    }
  });
}
