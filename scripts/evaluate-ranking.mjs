import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { MemoryHost, MemoryStorage, LocalAuthority, utf8Tokenizer } from '../dist/index.js';
// Deliberately fixed vectors prevent link text from changing the semantic input.
// No evaluation question is used to create or revise any Atom in these fixtures.
const runs = [];
for (const variant of ['correct', 'none', 'damaged']) {
  const storage = new MemoryStorage();
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'fixture',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  let documentCalls = 0,
    queryCalls = 0;
  const embedding = {
    id: 'causal-fixed-v1',
    dimensions: 2,
    networkCallsPerCall: 0,
    tokenizer: utf8Tokenizer,
    embed: async (texts, _signal, purpose) => {
      purpose === 'document' ? documentCalls++ : queryCalls++;
      return texts.map((t) => (t.startsWith('launch') ? [1, 0] : [0, 1]));
    },
  };
  const host = new MemoryHost({
    storage,
    authority,
    embedding,
    ranking: { semantic: 1, lexical: 0 },
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const memory = host.connect(binding);
  const prerequisite = await memory.write('administrator signature required');
  const unrelated = await memory.write('paint the meeting room');
  const target = variant === 'damaged' ? unrelated : prerequisite;
  for (const text of ['launch procedure', 'launch decision'])
    await memory.write({ text, links: { condition: target.ref } });
  const budget = { maxCandidates: 4000, maxBytes: 4000000, maxAtoms: 100, maxContextTokens: 40000 };
  await host.prepareIndex(binding, { budget });
  const heapBefore = process.memoryUsage().heapUsed,
    start = performance.now();
  const result = await memory.read(
    { query: 'launch' },
    { depth: variant === 'none' ? 0 : 2, tokens: 20000, limit: 20, budget },
  );
  const rank = result.items.findIndex((i) => i.ref === prerequisite.ref);
  runs.push({
    variant,
    atoms: 4,
    edges: 2,
    expansionEnabled: variant !== 'none',
    documentCalls,
    queryCalls,
    sourceRecall: result.refs.includes(prerequisite.ref) ? 1 : 0,
    reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
    memoryBytes: Buffer.byteLength(result.text),
    latencyMs: performance.now() - start,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
  });
  storage.close();
}
assert.deepEqual(
  runs.map((r) => r.sourceRecall),
  [1, 0, 0],
);
assert.equal(new Set(runs.map((r) => r.documentCalls)).size, 1);
assert.equal(new Set(runs.map((r) => r.queryCalls)).size, 1);
const record = {
  at: new Date().toISOString(),
  node: process.version,
  kind: 'deterministic structural retrieval; not LLM quality',
  model: 'fixed 2D encoder, no answer model or Writer',
  tokens: 'UTF-8 bytes; not billed tokens',
  budgets: { maxCandidates: 4000, maxBytes: 4000000, tokens: 20000 },
  runs,
};
if (process.argv.includes('--record'))
  writeFileSync(
    new URL('../validation/ranking-v0.5.0.json', import.meta.url),
    JSON.stringify(record, null, 2) + '\n',
  );
console.log(JSON.stringify(record, null, 2));
