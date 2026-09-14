// Small behavioral counterexamples for architecture decisions, not quality benchmarks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture, create, revise } from '../../test/fixtures.mjs';
import { MemoryStorage } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';

async function inspectArchitecture(adapter) {
  const opened = [];
  const setup = () => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new MemoryStorage();
    opened.push(storage);
    return fixture({ storage });
  };
  try {
    const deletion = setup();
    const b = await create(deletion.memory, 'shared evidence B');
    const p = await create(deletion.memory, { text: 'group P', links: { related: b.ref } });
    const q = await create(deletion.memory, { text: 'group Q', links: { related: b.ref } });
    const r = await create(deletion.memory, { text: 'group R', links: { related: p.ref } });
    const untouched = await create(deletion.memory, 'independent U');
    const erased = deletion.host.purge(deletion.storage.metaGet(`sdk:ref:${b.ref}`).target.atomId);
    assert.equal(erased.erasedAtomIds.length, 1);
    await assert.rejects(deletion.memory.inspect(b.ref), { code: 'ACCESS_DENIED' });
    for (const atom of [p, q, r, untouched])
      assert.equal((await deletion.memory.inspect(atom.ref, { limit: 0 })).atom.text, atom.text);

    const batch = async (sharedInput) => {
      const f = setup();
      const a = await create(f.memory, 'alpha source');
      const b = await create(f.memory, 'beta source');
      const binding = { ...f.binding, actor: { type: 'agent' } };
      const observe = (sources) =>
        f.host.observe(
          {
            sources: sources.map((ref) => ({ ref })),
            payloadDigest: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
          },
          binding,
        );
      const alphaInput = observe(sharedInput ? [a.ref, b.ref] : [a.ref]);
      const betaInput = sharedInput ? alphaInput : observe([b.ref]);
      // Transaction membership and semantic links do not imply generation input sharing.
      const result = await f.writer.write({
        changes: [
          {
            id: 'alpha',
            op: 'create',
            content: { text: 'alpha conclusion', links: { related: { local: 'beta' } } },
            sources: [],
            input: alphaInput,
          },
          {
            id: 'beta',
            op: 'create',
            content: { text: 'beta conclusion', links: { related: { local: 'alpha' } } },
            sources: [],
            input: betaInput,
          },
        ],
      });
      const outputs = Object.values(result.changes);
      await revise(f.memory, a.ref, 'alpha corrected');
      const page = await f.writer.search('conclusion', { depth: 0 });
      const stale = outputs
        .filter((o) => page.stale.includes(o.ref))
        .map((o) => o.text)
        .sort();
      assert.deepEqual(
        stale,
        sharedInput ? ['alpha conclusion', 'beta conclusion'] : ['alpha conclusion'],
      );
      return { stale, returned: page.items.map((o) => o.text) };
    };

    const observed = setup();
    for (let i = 0; i < 12; i++) await create(observed.memory, `orchard evidence ${i}`);
    const read = await observed.writer.read(
      { query: 'orchard' },
      { depth: 0, limit: 1, tokens: 2048 },
    );
    const agentBinding = { ...observed.binding, actor: { type: 'agent' } };
    const trace = observed.host.manifest(read.receipt, agentBinding);
    const input = observed.host.observe(
      {
        presentations: [{ receipt: read.receipt }],
        payloadDigest: createHash('sha256').update(JSON.stringify(read.items)).digest('hex'),
      },
      agentBinding,
    );
    const generation = observed.host.manifest(input, agentBinding);
    assert.equal(read.items.length, 1);
    assert.equal(trace.acquisition.reads.length, 12);
    assert.equal(generation.generation.presentations.flatMap((p) => p.units).length, 1);

    return {
      adapter,
      ordinaryLinkPurge: { erased: ['B'], surviving: ['P', 'Q', 'R', 'U'] },
      sharedGenerationInput: await batch(true),
      independentGenerationInputsInOneCommit: await batch(false),
      retrievalDependencies: {
        returnedBodies: read.items.length,
        acquiredRevisions: trace.acquisition.reads.length,
        generationPresentedBodies: generation.generation.presentations.flatMap((p) => p.units)
          .length,
        generationAuditRevisions: generation.reads.length,
      },
    };
  } finally {
    for (const storage of opened) storage.close();
  }
}

const results = await Promise.all(['memory', 'sqlite'].map(inspectArchitecture));
const sources = [
  'src/contracts.ts',
  'src/index.ts',
  'src/client/types.ts',
  'src/core/store.ts',
  'src/client/memory.ts',
  'src/client/engine.ts',
  'src/client/retrieval.ts',
  'src/client/ranking.ts',
  'src/core/ranking.ts',
  'src/adapters/memory.ts',
  'src/adapters/sqlite.ts',
  'research/architecture/evaluate.mjs',
  'test/boundary.test.mjs',
];
const report = {
  scope: 'Deterministic local contract examples; no model, embedding, or semantic-quality claim.',
  sourceSha256: Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(new URL(`../../${file}`, import.meta.url)))
        .digest('hex'),
    ]),
  ),
  results,
};
if (process.argv.includes('--record'))
  writeFileSync(
    new URL('results-v0.9.0.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
console.log(JSON.stringify(report, null, 2));
