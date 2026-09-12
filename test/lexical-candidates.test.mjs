import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryHost,
  LocalAuthority,
  MemoryStorage,
  LexicalCandidateProvider,
  ExactCandidateProvider,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: default ingress reaches a known match beyond the finite exact scan`, async () => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new MemoryStorage();
    try {
      const authority = new LocalAuthority();
      const binding = {
        auth: authority.issue({
          subject: 'owner',
          readPolicies: ['p'],
          writePolicies: ['p'],
          canIngestSource: true,
        }),
        writePolicy: 'p',
        actor: { type: 'human' },
      };
      storage.transaction(() =>
        storage.append(
          Array.from({ length: 6000 }, (_, i) => ({
            atomId: `node-${String(i).padStart(5, '0')}`,
            revisionId: `revision-${i}`,
            recordedAt: '2026-09-12T00:00:00.000Z',
            schema: 'source',
            state: 'active',
            body: { kind: 'inline', value: i === 5999 ? 'unique_needle' : 'background' },
            slots: [],
            origins: [],
            provenance: { kind: 'source', producerId: 'owner' },
            policyId: 'p',
          })),
        ),
      );
      const options = { storage, authority };
      const found = await new MemoryHost(options).connect(binding).search('unique_needle');
      assert.deepEqual(
        found.items.map((atom) => atom.text),
        ['unique_needle'],
      );
      assert.equal(found.diagnostics.scanned, 1);
      const reference = await new MemoryHost({
        ...options,
        candidateProvider: new ExactCandidateProvider(),
      })
        .connect(binding)
        .search('unique_needle');
      assert.deepEqual(reference.items, []);
      assert.equal(reference.diagnostics.scanned, 5000);
      assert.equal(reference.diagnostics.approximate, true);
    } finally {
      storage.close();
    }
  });

test('lexical ingress finds late matches within a small scan budget and preserves scope and deletion', async () => {
  const storage = new SqliteStorage(':memory:');
  try {
    const authority = new LocalAuthority();
    const host = new MemoryHost({
      storage,
      authority,
      maxScan: 2,
      candidateProvider: new LexicalCandidateProvider(),
    });
    const connect = (scope) =>
      host.connect({
        auth: authority.issue({
          subject: scope,
          readPolicies: [scope],
          writePolicies: [scope],
          canIngestSource: true,
        }),
        writePolicy: scope,
        actor: { type: 'input-adapter' },
      });
    const memory = connect('visible'),
      hidden = connect('hidden');
    for (let index = 0; index < 12; index++) await memory.write('unrelated source ' + index);
    const match = await memory.write('NeedleMatch: retained visible fact');
    await hidden.write('NeedleMatch: SECRET');
    const read = await memory.read({ query: 'needleMatch' }, { tokens: 12000 });
    assert.match(read.text, /retained visible fact/);
    assert.doesNotMatch(read.text, /SECRET/);
    assert.equal(read.diagnostics.approximate, true);
    assert.ok(read.diagnostics.scanned <= 2);
    await memory.edit((draft) => draft.retire(match.ref));
    assert.doesNotMatch(
      (await memory.read({ query: 'NeedleMatch' })).text,
      /retained visible fact/,
    );
  } finally {
    storage.close();
  }
});
