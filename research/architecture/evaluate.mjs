// Small behavioral counterexamples for architecture decisions, not quality benchmarks.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture } from '../../test/fixtures.mjs';
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
    const b = await deletion.memory.write('shared evidence B');
    const p = await deletion.memory.write({ text: 'group P', links: { related: b.ref } });
    const q = await deletion.memory.write({ text: 'group Q', links: { related: b.ref } });
    const r = await deletion.memory.write({ text: 'group R', links: { related: p.ref } });
    const untouched = await deletion.memory.write('independent U');
    const erased = deletion.host.purge(deletion.storage.metaGet(`sdk:ref:${b.ref}`).target.atomId);
    assert.equal(erased.erasedAtomIds.length, 4);
    assert.equal((await deletion.memory.inspect(untouched.ref)).atom.text, 'independent U');
    for (const atom of [b, p, q, r])
      await assert.rejects(deletion.memory.inspect(atom.ref), { code: 'ACCESS_DENIED' });

    const batch = async (sharedEdit) => {
      const f = setup();
      const a = await f.memory.write('alpha source');
      const b = await f.memory.write('beta source');
      let outputs;
      if (sharedEdit) {
        outputs = (
          await f.writer.edit(async (draft) => [
            await draft.write('alpha conclusion', { sources: [{ ref: a.ref }] }),
            await draft.write('beta conclusion', { sources: [{ ref: b.ref }] }),
          ])
        ).value;
      } else {
        outputs = [
          await f.writer.write('alpha conclusion', { sources: [{ ref: a.ref }] }),
          await f.writer.write('beta conclusion', { sources: [{ ref: b.ref }] }),
        ];
      }
      await f.memory.edit((draft) => draft.revise(a.ref, 'alpha corrected'));
      const page = await f.writer.search('conclusion', { depth: 0 });
      const stale = outputs
        .filter((o) => page.stale.includes(o.ref))
        .map((o) => o.text)
        .sort();
      assert.deepEqual(
        stale,
        sharedEdit ? ['alpha conclusion', 'beta conclusion'] : ['alpha conclusion'],
      );
      return { stale, returned: page.items.map((o) => o.text) };
    };

    const observed = setup();
    for (let i = 0; i < 12; i++) await observed.memory.write(`orchard evidence ${i}`);
    const read = await observed.writer.read(
      { query: 'orchard' },
      { depth: 0, limit: 1, tokens: 2048 },
    );
    const trace = observed.storage.metaGet(`sdk:trace:${read.receipt.id}`);
    assert.equal(read.items.length, 1);
    assert.equal(trace.reads.length, 12);

    return {
      adapter,
      ordinaryLinkPurge: { erased: ['B', 'P', 'Q', 'R'], surviving: ['U'] },
      oneEdit: await batch(true),
      separateWrites: await batch(false),
      retrievalDependencies: {
        returnedBodies: read.items.length,
        recordedRevisions: trace.reads.length,
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
  writeFileSync(new URL('results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
