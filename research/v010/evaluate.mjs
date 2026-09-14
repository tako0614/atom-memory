import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { fixtures } from './fixtures.mjs';
import { prepareFixture, fixtureId } from './setup.mjs';
import { checkNumeric } from './reference.mjs';
import { COLLECTOR_MODES } from './collector.mjs';
import { runVariant, assertUsageConservation } from './harness.mjs';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// One-axis cost sweeps keep actual body display feasible. These uniform caps
// are fixed before the comparative run, never selected per mode or fixture.
export function comparisonWindows(fixture) {
  const quality = fixture.budgets.find((window) => window.name === 'quality');
  return [
    ...fixture.budgets,
    ...[8, 16, 32, 64].map((cap) => ({
      name: `candidates-${cap}`,
      budget: { ...quality.budget, maxCandidates: cap },
    })),
    ...[2000, 20000].map((cap) => ({
      name: `evaluation-${cap}`,
      budget: { ...quality.budget, maxEvaluationWork: cap },
    })),
  ];
}

/** Fixed corpus, budgets, and source IDs; real candidate ingress and packing in every mode. */
export async function evaluate({
  adapters = ['memory', 'sqlite'],
  repeat = 3,
  fixtureFilter,
  budgetFilter,
} = {}) {
  const rows = [],
    preparation = [];
  for (const fixture of fixtures.filter(
    (fixture) => !fixtureFilter || fixture.id === fixtureFilter,
  )) {
    const prepared = await prepareFixture(fixture);
    preparation.push({ fixture: fixture.id, ...prepared.preparation });
    for (const adapter of adapters)
      for (const window of comparisonWindows(fixture).filter(
        (window) => !budgetFilter || window.name === budgetFilter,
      )) {
        const byMode = new Map(COLLECTOR_MODES.map((mode) => [mode, []]));
        let commonCandidates, commonIngressCost;
        for (let iteration = 0; iteration < repeat; iteration++) {
          const order = [
            ...COLLECTOR_MODES.slice(iteration % COLLECTOR_MODES.length),
            ...COLLECTOR_MODES.slice(0, iteration % COLLECTOR_MODES.length),
          ];
          for (const mode of order) {
            const variant = prepared.makeVariant(adapter);
            const started = performance.now();
            try {
              const result = await runVariant({
                engine: variant.engine,
                binding: variant.binding,
                input: { context: fixture.context },
                mode,
                budget: window.budget,
                depth: fixture.depth,
                tokens: window.tokens ?? fixture.tokens,
                evaluatedAt: prepared.evaluatedAt,
                limit: window.budget.maxAtoms,
              });
              assertUsageConservation(result.usage, result.metrics.phaseUsage);
              const raw = JSON.stringify(
                result.rawCandidates.map(({ revision, score }) => [revision.revisionId, score]),
              );
              const cost = JSON.stringify(result.metrics.phaseUsage.candidate);
              commonCandidates ??= raw;
              commonIngressCost ??= cost;
              assert.equal(raw, commonCandidates, `${fixture.id}/${window.name}: candidate drift`);
              assert.equal(
                cost,
                commonIngressCost,
                `${fixture.id}/${window.name}: ingress cost drift`,
              );
              const signals = [
                { kind: 'context', text: fixture.context, vector: fixture.contextVector },
              ];
              const errorL1 = checkNumeric(
                variant,
                result.graph.nodes,
                result.graph.edges,
                result.candidates,
                signals,
                prepared.evaluatedAt,
                result.diagnostics.evaluation.numericErrorL1Upper,
              );
              const acquired = new Set(result.graph.nodes.map(({ revision }) => revision.atomId));
              const displayed = new Set(
                result.items.map((item) => fixtureId(item.ref, variant.storage)),
              );
              const evidenceAcquired = fixture.evidence.filter((id) => acquired.has(id));
              const evidenceDisplayed = fixture.evidence.filter((id) => displayed.has(id));
              const missingConditions = (fixture.conditionPairs ?? []).filter(
                ([root, condition]) => displayed.has(root) && !displayed.has(condition),
              );
              assert.equal(
                missingConditions.length,
                0,
                'a displayed root must include its mandatory condition',
              );
              assert.ok(
                result.tokenCount <=
                  Math.min(window.tokens ?? fixture.tokens, window.budget.maxContextTokens),
              );
              for (const [resource, value] of Object.entries(result.usage))
                assert.ok(value <= result.metrics.limits[resource]);
              byMode.get(mode).push({
                status: 'returned',
                stop: result.diagnostics.stop,
                acquired: [...acquired].sort(),
                displayed: [...displayed].sort(),
                evidenceAcquired,
                evidenceDisplayed,
                evidenceCount: fixture.evidence.length,
                missingConditions,
                tokenCount: result.tokenCount,
                errorL1,
                errorBound: result.diagnostics.evaluation.numericErrorL1Upper,
                converged: result.diagnostics.evaluation.converged,
                truncated: result.diagnostics.truncated,
                usage: result.usage,
                phases: result.metrics.phaseUsage,
                acquiredEdges: result.metrics.acquiredEdges,
                provisionalEvaluations: result.metrics.provisionalEvaluations,
                wallMs: result.metrics.wallMs,
                candidateMs: result.metrics.candidateMs,
                packingMs: result.metrics.packingMs,
              });
            } catch (error) {
              if (error.code !== 'BUDGET_EXHAUSTED') throw error;
              byMode.get(mode).push({
                status: 'budget-exhausted',
                error: error.message,
                ...(error.v010 ?? {}),
                wallMs: performance.now() - started,
                evidenceCount: fixture.evidence.length,
                evidenceAcquired: [],
                evidenceDisplayed: [],
                missingConditions: [],
              });
            } finally {
              variant.close();
            }
          }
        }
        for (const [mode, runs] of byMode) {
          const first = runs[0];
          for (const run of runs.slice(1)) {
            assert.equal(run.status, first.status, 'repeat outcome drift');
            assert.deepEqual(run.evidenceDisplayed, first.evidenceDisplayed, 'repeat output drift');
            if (run.usage && first.usage)
              assert.deepEqual(run.usage, first.usage, 'repeat accounting drift');
          }
          rows.push({
            fixture: fixture.id,
            adapter,
            budgetName: window.name,
            budget: window.budget,
            tokens: window.tokens ?? fixture.tokens,
            mode,
            ...first,
            wallMs: median(runs.map((run) => run.wallMs)),
            wallSamplesMs: runs.map((run) => run.wallMs),
          });
        }
      }
    process.stderr.write(`evaluated ${fixture.id}\n`);
  }
  const summary = Object.fromEntries(
    adapters.map((adapter) => [
      adapter,
      Object.fromEntries(
        COLLECTOR_MODES.map((mode) => {
          const all = rows.filter((row) => row.adapter === adapter && row.mode === mode);
          const quality = all.filter((row) => row.budgetName === 'quality');
          return [
            mode,
            {
              cases: all.length,
              returned: all.filter((row) => row.status === 'returned').length,
              qualityCases: quality.length,
              qualityCompleteEvidence: quality.filter(
                (row) => row.evidenceDisplayed.length === row.evidenceCount,
              ).length,
              qualityAcquiredEvidence: quality.filter(
                (row) => row.evidenceAcquired.length === row.evidenceCount,
              ).length,
              conditionOmissions: all.reduce((n, row) => n + row.missingConditions.length, 0),
              qualityEvaluationWork: quality.reduce(
                (n, row) => n + (row.usage?.maxEvaluationWork ?? 0),
                0,
              ),
              qualityWallMs: quality.reduce((n, row) => n + row.wallMs, 0),
            },
          ];
        }),
      ),
    ]),
  );
  const comparisons = [];
  for (const active of rows.filter((row) => row.mode === 'active-fair'))
    for (const baselineMode of ['fifo-v09', 'fair-only', 'fair-evaluated']) {
      const baseline = rows.find(
        (row) =>
          row.fixture === active.fixture &&
          row.adapter === active.adapter &&
          row.budgetName === active.budgetName &&
          row.mode === baselineMode,
      );
      if (!baseline) continue;
      comparisons.push({
        fixture: active.fixture,
        adapter: active.adapter,
        budgetName: active.budgetName,
        baseline: baselineMode,
        acquiredEvidenceDelta: active.evidenceAcquired.length - baseline.evidenceAcquired.length,
        displayedEvidenceDelta: active.evidenceDisplayed.length - baseline.evidenceDisplayed.length,
        evaluationWorkDelta:
          active.usage && baseline.usage
            ? active.usage.maxEvaluationWork - baseline.usage.maxEvaluationWork
            : null,
        wallMsDelta: active.wallMs - baseline.wallMs,
      });
    }
  return {
    sourceSha256: Object.fromEntries(
      [
        'collector.mjs',
        'harness.mjs',
        'fixtures.mjs',
        'setup.mjs',
        'reference.mjs',
        'evaluate.mjs',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(new URL(file, import.meta.url)))
          .digest('hex'),
      ]),
    ),
    kind: 'v010 acquisition research; fixed structural fixtures, not LLM answer quality',
    generatedAt: new Date().toISOString(),
    node: process.version,
    repeat,
    modes: COLLECTOR_MODES,
    preparation,
    summary,
    comparisons,
    rows,
    limitations: [
      'Fixed 4D vectors and fixed candidate provider; ANN recall is not measured.',
      'Read graph and use state are immutable across each synchronous measured retrieval.',
      'Oracle verification and cloning are outside retrieval wall time; initial index preparation is reported separately.',
      'Cold independent engines; within-traversal provisional values are reused, but cross-request warm latency is not measured.',
      'Short fixture timings include transaction and validation work, but are not a general latency benchmark.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const result = await evaluate({
    adapters: value('--adapters')?.split(','),
    repeat: Number(value('--repeat') ?? 3),
    fixtureFilter: value('--fixture'),
    budgetFilter: value('--budget'),
  });
  const output = value('--output') ?? 'research/v010/results.json.gz';
  const serialized = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(output, output.endsWith('.gz') ? gzipSync(serialized) : serialized);
  if (output.endsWith('.gz')) {
    const { rows, comparisons, ...summary } = result;
    writeFileSync(
      output.replace(/\.json\.gz$/, '.summary.json'),
      JSON.stringify({ ...summary, rows: rows.length, raw: output }, null, 2) + '\n',
    );
  }
  console.log(JSON.stringify({ output, summary: result.summary }, null, 2));
}
