import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from './fixtures.mjs';
import { ampleBudget, fixtureId, prepareFixture } from './setup.mjs';
import { assertUsageConservation, compareVariants, runVariant } from './harness.mjs';

function fixtureById(id) {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing fixture ${id}`);
  return fixture;
}

function qualityBudget(fixture) {
  const entry = fixture.budgets.find((candidate) => candidate.name === 'quality');
  assert.ok(entry, `${fixture.id}: missing quality budget`);
  return entry;
}

function selectedIds(result, storage) {
  return result.items.map((item) => fixtureId(item.ref, storage)).sort();
}

function graphSemantics(result) {
  return {
    nodes: result.graph.nodes.map(({ revision }) => revision.revisionId),
    edges: result.graph.edges.map(({ from, to, role }) => ({ from, to, role })),
    epochs: result.metrics.epochs.map(({ epoch, eligible, served }) => ({
      epoch,
      eligible,
      served,
    })),
    provisionalEvaluations: result.metrics.provisionalEvaluations,
  };
}

test('fair-evaluated and active-fair preserve equal-activation epoch and graph semantics', async () => {
  const fixture = fixtureById('order-permutation-a');
  const prepared = await prepareFixture(fixture);
  const window = qualityBudget(fixture);
  const comparison = await compareVariants({
    makeVariant: () => prepared.makeVariant('memory'),
    modes: ['fair-evaluated', 'active-fair'],
    input: { context: fixture.context },
    budget: window.budget,
    depth: fixture.depth,
    tokens: window.tokens ?? fixture.tokens,
    limit: window.budget.maxAtoms,
    evaluatedAt: prepared.evaluatedAt,
  });
  const fair = comparison.results['fair-evaluated'];
  const active = comparison.results['active-fair'];
  assert.deepEqual(graphSemantics(active), graphSemantics(fair));
  const tiedActivations = fair.allScores
    .filter(({ atomId }) => ['route-first', 'route-second', 'route-third'].includes(atomId))
    .map(({ activation }) => activation);
  assert.equal(tiedActivations.length, 3);
  assert.ok(Math.max(...tiedActivations) - Math.min(...tiedActivations) <= 1e-12);
});

test('a provisional window below the fresh minimum stops before mutation and keeps final certificate', async () => {
  const fixture = fixtureById('shared-mandatory-condition');
  const prepared = await prepareFixture(fixture);
  const variant = prepared.makeVariant('memory');
  const window = qualityBudget(fixture);
  try {
    const result = await runVariant({
      engine: variant.engine,
      binding: variant.binding,
      input: { context: fixture.context },
      mode: 'active-fair',
      budget: window.budget,
      depth: fixture.depth,
      tokens: window.tokens ?? fixture.tokens,
      limit: window.budget.maxAtoms,
      evaluatedAt: prepared.evaluatedAt,
      provisionalMaxEvaluationWork: 1,
    });
    assert.equal(result.diagnostics.stop, 'final-reserve');
    assert.equal(result.diagnostics.evaluation.converged, true);
    assert.equal(result.metrics.provisionalEvaluations, 0);
    assert.equal(result.metrics.graphMutations, 0);
    assert.equal(result.metrics.acquiredEdges, 0);
    assert.deepEqual(
      result.graph.nodes.map(({ revision }) => revision.atomId),
      fixture.seeds,
    );
  } finally {
    variant.close();
  }
});

test('quality harness usage is conserved, bounded, and fixed-time across the corpus', async () => {
  for (const fixture of fixtures) {
    const prepared = await prepareFixture(fixture);
    const variant = prepared.makeVariant('memory');
    const window = qualityBudget(fixture);
    try {
      const result = await runVariant({
        engine: variant.engine,
        binding: variant.binding,
        input: { context: fixture.context },
        mode: 'fair-only',
        budget: window.budget,
        depth: fixture.depth,
        tokens: window.tokens ?? fixture.tokens,
        limit: window.budget.maxAtoms,
        evaluatedAt: prepared.evaluatedAt,
      });
      assertUsageConservation(result.usage, result.metrics.phaseUsage);
      assert.equal(result.evaluatedAt, prepared.evaluatedAt);
      assert.equal(result.diagnostics.evaluation.evaluatedAt, prepared.evaluatedAt);
      for (const [resource, value] of Object.entries(result.usage))
        assert.ok(
          value <= result.metrics.limits[resource],
          `${fixture.id}: ${resource} exceeds budget`,
        );
    } finally {
      variant.close();
    }
  }
});

for (const adapter of ['memory', 'sqlite']) {
  test(`erased required condition prevents its root from being packed (${adapter})`, async () => {
    const fixture = fixtureById('shared-mandatory-condition');
    const prepared = await prepareFixture(fixture);
    const variant = prepared.makeVariant(adapter);
    const window = qualityBudget(fixture);
    try {
      const missing = fixture.conditionPairs[0][1];
      variant.storage.erase([missing]);
      const result = await runVariant({
        engine: variant.engine,
        binding: variant.binding,
        input: { context: fixture.context },
        mode: 'fair-only',
        budget: window.budget,
        depth: fixture.depth,
        tokens: window.tokens ?? fixture.tokens,
        limit: window.budget.maxAtoms,
        evaluatedAt: prepared.evaluatedAt,
      });
      const displayed = selectedIds(result, variant.storage);
      for (const [root] of fixture.conditionPairs) assert.ok(!displayed.includes(root));
    } finally {
      variant.close();
    }
  });
}

test('candidate-only public read matches the harness selection on a cold depth-zero clone', async () => {
  const fixture = fixtureById('candidate-only-multi-control');
  const prepared = await prepareFixture(fixture);
  const tokens = fixture.tokens;
  const limit = 8;
  let publicIds;
  let publicTokenCount;
  {
    const variant = prepared.makeVariant('memory');
    try {
      const memory = variant.host.connect(variant.binding);
      const result = await memory.read(
        { context: fixture.context },
        { depth: 0, tokens, limit, budget: ampleBudget },
      );
      publicIds = selectedIds(result, variant.storage);
      publicTokenCount = result.tokenCount;
    } finally {
      variant.close();
    }
  }
  {
    const variant = prepared.makeVariant('memory');
    try {
      const result = await runVariant({
        engine: variant.engine,
        binding: variant.binding,
        input: { context: fixture.context },
        mode: 'candidate-only',
        budget: ampleBudget,
        depth: 0,
        tokens,
        limit,
        evaluatedAt: prepared.evaluatedAt,
      });
      assert.deepEqual(selectedIds(result, variant.storage), publicIds);
      assert.equal(result.tokenCount, publicTokenCount);
    } finally {
      variant.close();
    }
  }
});
