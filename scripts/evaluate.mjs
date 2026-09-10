import { writeFileSync } from 'node:fs';
import {
  MemoryHost,
  LocalAuthority,
  MemoryHarness,
  content,
  utf8Tokenizer,
} from '../dist/index.js';
import { llamaCppModel } from '../examples/llama-cpp.mjs';
function fixture(options = {}) {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'evaluation',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const host = new MemoryHost({ authority, ...options });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  return { host, binding, memory: host.connect(binding) };
}
async function scale() {
  const results = [];
  for (const size of [10, 100, 1000, 10000]) {
    const { host, binding, memory } = fixture({
      maxScan: 20000,
      defaults: { maxCandidates: 30000, maxBytes: 16 * 1024 * 1024 },
    });
    for (let offset = 0; offset < size; offset += 200) {
      const revisions = Array.from({ length: Math.min(200, size - offset) }, (_, j) => {
        const i = offset + j;
        return {
          atomId: `a-${String(i).padStart(5, '0')}`,
          revisionId: `r-${i}`,
          expectedHead: null,
          content: content('source', 'unrelated weather observation', 'p'),
        };
      });
      await host.engine.kernel.write(
        { idempotencyKey: `seed-${offset}`, guards: [], revisions },
        binding.auth,
      );
    }
    await host.engine.kernel.write(
      {
        idempotencyKey: 'needle',
        guards: [],
        revisions: [
          {
            atomId: 'zz-needle',
            revisionId: 'r-needle',
            expectedHead: null,
            content: content('source', 'cobalt authentication receipt', 'p'),
          },
        ],
      },
      binding.auth,
    );
    const start = performance.now();
    const page = await memory.search('cobalt authentication', { limit: 1 });
    results.push({
      noiseAtoms: size,
      recallAt1: page.items[0]?.text === 'cobalt authentication receipt' ? 1 : 0,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
      scanned: page.diagnostics.scanned,
      usage: page.usage,
      method: page.diagnostics.method,
    });
  }
  return results;
}
async function concurrency() {
  const results = [];
  for (const writers of [2, 8, 32]) {
    const { memory } = fixture();
    const source = await memory.write('initial');
    let release;
    const gate = new Promise((r) => (release = r));
    let ready = 0;
    const attempts = Array.from({ length: writers }, (_, i) =>
      memory.edit(async (draft) => {
        await draft.revise(source.ref, `candidate ${i}`);
        if (++ready === writers) release();
        await gate;
      }),
    );
    const start = performance.now();
    const settled = await Promise.allSettled(attempts);
    results.push({
      writers,
      committed: settled.filter((r) => r.status === 'fulfilled').length,
      conflicts: settled.filter(
        (r) => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT',
      ).length,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    });
  }
  return results;
}
async function degree() {
  const results = [];
  for (const links of [10, 100, 300]) {
    const { memory, host, binding } = fixture();
    const root = await memory.write('root');
    const pin = host.engine.storage.metaGet(`sdk:ref:${root.ref}`).target;
    for (let offset = 0; offset < links; offset += 200) {
      const revisions = Array.from({ length: Math.min(200, links - offset) }, (_, j) => ({
        atomId: `link-${offset + j}`,
        revisionId: `edge-${offset + j}`,
        expectedHead: null,
        content: content('relation', 'adjacent', 'p', {
          slots: [{ role: '理由', mode: 'refer', target: { kind: 'logical', atomId: pin.atomId } }],
        }),
      }));
      await host.engine.kernel.write(
        { idempotencyKey: `edges-${offset}`, guards: [], revisions },
        binding.auth,
      );
    }
    let cursor;
    let pages = 0;
    let scanned = 0;
    const seen = new Set();
    const start = performance.now();
    do {
      const page = await memory.inspect(root.ref, { depth: 1, limit: 20, cursor });
      cursor = page.cursor;
      pages++;
      scanned += page.usage.maxCandidates;
      page.items.forEach((i) => seen.add(i.ref));
    } while (cursor && pages < 100);
    results.push({
      links,
      pages,
      returned: seen.size,
      complete: !cursor,
      scanned,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    });
  }
  return results;
}
async function comparison(mode, live = false) {
  const { host, binding, memory } = fixture();
  const original = await memory.write(
    'harbor permit allowed only after operator approval. obsolete-permit',
  );
  await memory.write('stellar cargo requires officer approval. cargo-evidence');
  const topics = ['harbor permit', 'stellar cargo', 'harbor permit', 'stellar cargo'];
  const expected = ['obsolete-permit', 'cargo-evidence', 'current-permit', 'cargo-evidence'];
  const answers = [];
  let step = 0;
  const model = live
    ? llamaCppModel({
        url: process.env.LLAMA_URL,
        actionKinds: ['finish'],
        id: process.env.LLAMA_MODEL_ID ?? 'llama-cpp-chat-v2',
        contextWindow: Number(process.env.LLAMA_CONTEXT ?? 8192),
      })
    : {
        id: 'deterministic-comparison-v1',
        tokenizer: utf8Tokenizer,
        contextWindow: 32768,
        networkCallsPerCall: 0,
        respond: async (input) => ({ kind: 'finish', output: JSON.stringify(input.memory) }),
      };
  const originalRespond = model.respond.bind(model);
  model.respond = async (input, options) => {
    const response = await originalRespond(input, options);
    answers.push('action' in response ? response.action : response);
    if (step === 0)
      await memory.edit((d) => d.revise(original.ref, 'harbor permit denied. current-permit'));
    step++;
    const action =
      step < topics.length
        ? { kind: 'continue', state: { context: topics[step] } }
        : { kind: 'finish', output: 'comparison completed' };
    // The same model is invoked in every mode. Host-directed topic changes make input comparisons reproducible.
    return 'action' in response
      ? { ...response, action }
      : { action, outputTokens: model.tokenizer.count(JSON.stringify(response)) };
  };
  const wrapped = {
    forExecution(scope) {
      const client = memory.forExecution(scope);
      const selected = [];
      return new Proxy(client, {
        get(target, key) {
          if (key === 'read')
            return async (state, options) => {
              if (mode === 'none') {
                const session = host.engine.session(binding, options, scope.ledger);
                const receipt = host.engine.trace(session);
                scope.traces.push(session.trace);
                return {
                  items: [],
                  text: '',
                  refs: [],
                  sources: [],
                  receipt,
                  tokenCount: 0,
                  usage: scope.ledger.usage(),
                };
              }
              const page = await target.read(state, options);
              if (mode === 'history') {
                if (page.text) selected.push(JSON.parse(page.text));
                return { ...page, text: JSON.stringify({ previousMemory: selected }) };
              }
              return page;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  const harness = new MemoryHarness({
    memory: wrapped,
    model,
    instruction:
      'Answer only the current topic in state.context, using the supplied evidence. Include every approval condition. Return {"kind":"finish","output":"one concise English sentence"}. If evidence is absent, answer "Insufficient evidence". Do not use prior knowledge or describe a plan.',
    maxSteps: 4,
    memoryTokens: 3000,
    maxOutputTokensPerStep: 2000,
  });
  const result = await harness.run({
    input: '調べて',
    context: topics[0],
    budget: {
      maxContextTokens: 20000,
      maxModelInputTokens: 100000,
      maxModelOutputTokens: 8000,
      maxModelCalls: 4,
      maxNetworkCalls: 16,
      deadline: new Date(Date.now() + 300000).toISOString(),
    },
  });
  // Audit authorization uses the bound wrapper too.
  wrapped.assertAuthorized = (receipts) => memory.assertAuthorized(receipts);
  const audit = harness.audit(result.runId);
  const steps = audit.map((entry, i) => {
    const memoryText = JSON.stringify(entry.input.memory);
    return {
      step: i + 1,
      topic: topics[i],
      inputTokens: entry.inputTokens,
      requiredEvidence: memoryText.includes(expected[i]),
      staleInformation: i >= 2 && memoryText.includes('obsolete-permit'),
      conditionMissing:
        i === 0
          ? memoryText.includes('obsolete-permit') && !memoryText.includes('operator approval')
          : i % 2 === 1
            ? memoryText.includes('cargo-evidence') && !memoryText.includes('officer approval')
            : false,
    };
  });
  return {
    mode,
    model: model.id,
    status: result.status,
    error: result.error,
    usage: result.usage,
    steps,
    modelResponses: answers,
    answerQuality: 'Not automatically scored; inspect responses separately from input coverage.',
  };
}
const live = process.argv.includes('--live');
if (live && !process.env.LLAMA_URL)
  throw Error('LLAMA_URL must be set explicitly for real model evaluation');
const report = {
  baseline: '0c5a5aeb29b1a11195cb74d562f00c5dd6edec15',
  runtime: process.version,
  generatedAt: new Date().toISOString(),
  kind: live ? 'real-local-model' : 'deterministic-mock',
  claims:
    'Synthetic fixture coverage and local resource measurements only. No semantic, ANN, distributed, or task-success guarantee.',
  search: live ? [] : await scale(),
  adjacency: live ? [] : await degree(),
  concurrentRevisions: live ? [] : await concurrency(),
  comparison: [],
};
for (const mode of ['none', 'history', 'replacement'])
  report.comparison.push(await comparison(mode, live));
const file = live ? 'validation/live-evaluation.json' : 'validation/local-evaluation.json';
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      file,
      kind: report.kind,
      search: report.search.map((r) => ({
        size: r.noiseAtoms,
        recallAt1: r.recallAt1,
        elapsedMs: r.elapsedMs,
      })),
      comparison: report.comparison.map((r) => ({
        mode: r.mode,
        status: r.status,
        inputTokens: r.usage.maxModelInputTokens,
        evidenceSteps: r.steps.filter((s) => s.requiredEvidence).length,
        staleSteps: r.steps.filter((s) => s.staleInformation).length,
      })),
    },
    null,
    2,
  ),
);
