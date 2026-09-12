import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';

test('the package exposes memory operations, not a model execution protocol', async () => {
  assert.equal('MemoryHarness' in api, false);
  const { memory } = fixture();
  await memory.edit((draft) => assert.equal('supersede' in draft, false));
  assert.throws(() => fixture({ generator: { generate() {} } }), { code: 'INVALID_INPUT' });
  const atom = await memory.write('observed revision');
  await assert.rejects(memory.inspect(atom.ref, { history: 'retained' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(memory.read({ query: 'observed' }, { historical: true }), {
    code: 'INVALID_INPUT',
  });
});

test('host-owned model execution still cannot forge sources, references or revoked access', async () => {
  const { writer, memory, authority, auth } = fixture();
  const source = await memory.write('authorized input');
  await assert.rejects(writer.write({ text: 'forged source', provenance: { kind: 'source' } }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(writer.write({ text: 'forged link', links: { source: 'ref:invented' } }), {
    code: 'INVALID_REF',
  });
  const recalled = await writer.read({ query: 'authorized' });
  authority.revoke(auth);
  assert.throws(() => writer.assertAuthorized([recalled.receipt]), { code: 'ACCESS_DENIED' });
  await assert.rejects(writer.inspect(source.ref), { code: 'ACCESS_DENIED' });
  await assert.rejects(writer.read({ query: 'authorized' }), { code: 'ACCESS_DENIED' });
});

for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter}: stale candidates never lend their rank to current sources`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new api.MemoryStorage();
    t.after(() => storage.close());
    const { memory, writer } = fixture({ storage });
    const source = await memory.write('state_topic original evidence');
    const interpretations = [];
    for (const name of ['one', 'two']) {
      const result = await writer.edit(async (draft) => {
        await draft.inspect(source.ref, { version: 'latest', depth: 0 });
        return draft.write(`state_topic interpreted ${name}`, { sources: [{ ref: source.ref }] });
      });
      interpretations.push(result.value.ref);
    }
    const current = await memory.edit((draft) =>
      draft.revise(source.ref, 'state_topic current evidence'),
    );
    const search = await writer.search('interpreted', { depth: 0 });
    assert.deepEqual(search.items, [], 'a source must qualify through its own retrieval path');
    assert.deepEqual(new Set(search.stale), new Set(interpretations));
    const read = await writer.read({ query: 'interpreted' }, { depth: 0 });
    assert.deepEqual(read.items, []);
    assert.equal(read.text, '');
    assert.deepEqual(new Set(read.stale), new Set(interpretations));

    const found = [];
    const stale = new Set();
    let cursor;
    do {
      const page = await writer.search('state_topic', {
        depth: 0,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.items);
      page.stale.forEach((ref) => stale.add(ref));
      cursor = page.cursor;
    } while (cursor);
    assert.deepEqual(
      found.map((atom) => atom.ref),
      [current.value.ref],
    );
    assert.deepEqual(stale, new Set(interpretations));
    assert.equal(
      (await writer.inspect(interpretations[0], { depth: 0 })).atom.sources[0].ref,
      source.ref,
    );
  });

  test(`${adapter}: stale memory is reported, and an explicit Writer edit restores it`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new api.MemoryStorage();
    if (adapter === 'sqlite') t.after(() => storage.close());
    const { memory, writer } = fixture({ storage });
    const source = await memory.write('boundary_topic: old rule');
    const written = await writer.edit(async (draft) => {
      await draft.inspect(source.ref, { version: 'latest', depth: 0 });
      return draft.write('boundary_topic: old interpretation', { sources: [{ ref: source.ref }] });
    });
    const before = storage.watermark();
    assert.match(
      (await writer.read({ query: 'boundary_topic' }, { tokens: 10000 })).text,
      /old interpretation/,
    );
    assert.equal(storage.watermark(), before, 'read must not commit new revisions');
    const revised = await memory.edit((draft) =>
      draft.revise(source.ref, 'boundary_topic: current rule'),
    );
    const read = await writer.read({ query: 'boundary_topic' }, { tokens: 10000 });
    assert.doesNotMatch(read.text, /old interpretation/);
    assert.match(read.text, /current rule/);
    assert.equal(read.diagnostics.derived, 'pending');
    assert.ok(read.stale.includes(written.value.ref));
    assert.equal(read.usage.maxModelCalls, 0);
    assert.equal(storage.metaEntries('sdk:cache:derived:').length, 0);
    assert.equal('temporary' in JSON.parse(read.text), false);
    await writer.edit(async (draft) => {
      await draft.inspect(revised.value.ref, { version: 'latest', depth: 0 });
      await draft.revise(written.value.ref, 'boundary_topic: current interpretation', {
        sources: [{ ref: revised.value.ref }],
      });
    });
    const current = await writer.read({ query: 'boundary_topic' }, { tokens: 10000 });
    assert.match(current.text, /current interpretation/);
    assert.deepEqual(current.stale, []);
    assert.equal(
      (await memory.inspect(source.ref, { depth: 0 })).atom.text,
      'boundary_topic: old rule',
    );
  });
}
