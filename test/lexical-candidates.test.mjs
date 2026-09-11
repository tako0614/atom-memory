import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, LocalAuthority, LexicalCandidateProvider } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

test('lexical ingress finds late matches within a small scan budget and preserves scope and deletion', async () => {
  const storage = new SqliteStorage(':memory:');
  try {
    const authority = new LocalAuthority();
    const host = new MemoryHost({ storage, authority, maxScan: 2, candidateProvider: new LexicalCandidateProvider() });
    const connect = (scope) => host.connect({ auth: authority.issue({ subject: scope, readPolicies: [scope], writePolicies: [scope], canIngestSource: true }),
      writePolicy: scope, actor: { type: 'input-adapter' } });
    const memory = connect('visible'), hidden = connect('hidden');
    for (let index = 0; index < 12; index++) await memory.write('unrelated source ' + index);
    const match = await memory.write('NeedleMatch: retained visible fact');
    await hidden.write('NeedleMatch: SECRET');
    const read = await memory.read({ query: 'needleMatch' }, { tokens: 12000 });
    assert.match(read.text, /retained visible fact/);
    assert.doesNotMatch(read.text, /SECRET/);
    assert.equal(read.diagnostics.approximate, true);
    assert.ok(read.diagnostics.scanned <= 2);
    await memory.edit((draft) => draft.retire(match.ref));
    assert.doesNotMatch((await memory.read({ query: 'NeedleMatch' })).text, /retained visible fact/);
  } finally { storage.close(); }
});
