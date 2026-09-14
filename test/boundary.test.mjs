import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as api from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture, create, revise, retire } from './fixtures.mjs';

const payloadDigest = (value) => createHash('sha256').update(value).digest('hex');
const inputFrom = (host, binding, receipt, value, basis = 'current') =>
  host.observe(
    {
      presentations: [{ receipt }],
      payloadDigest: payloadDigest(value),
      ...(basis === 'historical' ? { basis } : {}),
    },
    { ...binding, actor: { type: 'agent' } },
  );

test('the package exposes memory operations, not a model execution protocol', async () => {
  assert.equal('MemoryHarness' in api, false);
  const { memory } = fixture();
  assert.equal('edit' in memory, false);
  assert.throws(() => fixture({ generator: { generate() {} } }), { code: 'INVALID_INPUT' });
  const atom = await create(memory, 'observed revision');
  await assert.rejects(memory.inspect(atom.ref, { history: 'retained' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(memory.read({ query: 'observed' }, { historical: true }), {
    code: 'INVALID_INPUT',
  });
});

test('host-owned model execution still cannot forge sources, references or revoked access', async () => {
  const { writer, memory, authority, auth } = fixture();
  const source = await create(memory, 'authorized input');
  await assert.rejects(create(writer, { text: 'forged source', provenance: { kind: 'source' } }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(create(writer, { text: 'forged link', links: { source: 'ref:invented' } }), {
    code: 'INVALID_REF',
  });
  const recalled = await writer.read({ query: 'authorized' });
  authority.revoke(auth);
  assert.throws(() => writer.assertAuthorized([recalled.receipt]), { code: 'ACCESS_DENIED' });
  await assert.rejects(writer.inspect(source.ref), { code: 'ACCESS_DENIED' });
  await assert.rejects(writer.read({ query: 'authorized' }), { code: 'ACCESS_DENIED' });
});

for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter}: one durable dependency manifest preserves freshness, conflicts and purge`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new api.MemoryStorage();
    t.after(() => storage.close());
    const { memory, writer, host, binding } = fixture({ storage });
    const source = await create(memory, 'manifest original evidence');
    const receiptsBeforeReadOnlyEdit = storage.metaEntries('receipt:').length;
    const inspected = await writer.inspect(source.ref);
    assert.equal(inspected.atom.text, 'manifest original evidence');
    assert.equal(storage.metaEntries('receipt:').length, receiptsBeforeReadOnlyEdit);
    const inputSnapshot = storage.watermark();
    const input = inputFrom(host, binding, inspected.receipt, 'manifest interpretation');
    const generated = await create(writer, 'manifest interpretation', {
      input,
      sources: [{ ref: source.ref }],
    });
    const sourceEntry = storage.metaGet(`sdk:ref:${source.ref}`);
    const generatedEntry = storage.metaGet(`sdk:ref:${generated.ref}`);
    const revision = storage.get(generatedEntry.target, storage.watermark());
    const key = `receipt:${revision.provenance.inputReceiptId}`;
    const manifest = storage.metaGet(key);
    assert.equal(manifest.watermark, inputSnapshot, 'retain the actual observed storage position');
    assert.ok(manifest.reads.some((r) => r.revisionId === sourceEntry.target.revisionId));
    assert.equal(storage.metaGet(`sdk:trace:${revision.provenance.inputReceiptId}`), undefined);
    assert.ok((await writer.search('interpretation')).items.some((i) => i.ref === generated.ref));

    // Existing stored manifests may still have old descriptive fields. They do
    // not decide currentness; actual observed revisions and ranges do.
    storage.metaSet(key, {
      ...manifest,
      tokenizerId: 'old-tokenizer',
      receipt: {
        ...manifest.receipt,
        consistency: 'snapshot',
        snapshotToken: 'old',
        policyValidationToken: 'old',
      },
    });
    const updated = await revise(memory, source.ref, 'manifest updated evidence');
    const stale = await writer.search('interpretation', { depth: 0 });
    assert.deepEqual(stale.items, []);
    assert.ok(stale.stale.includes(generated.ref));
    const empty = await writer.search('empty_observation', { depth: 0 });
    const absenceInput = host.observe(
      { watches: [empty.receipt], payloadDigest: payloadDigest('conclusion from absence') },
      { ...binding, actor: { type: 'agent' } },
    );
    await create(memory, 'empty_observation appeared');
    await assert.rejects(create(writer, 'conclusion from absence', { input: absenceInput }), {
      code: 'REVISION_CONFLICT',
    });
    assert.equal((await memory.inspect(updated.value.ref)).atom.text, 'manifest updated evidence');
    host.purge(sourceEntry.target.atomId);
    await assert.rejects(writer.inspect(generated.ref), { code: 'ACCESS_DENIED' });
  });

  test(`${adapter}: stale candidates never lend their rank to current sources`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new api.MemoryStorage();
    t.after(() => storage.close());
    const { memory, writer, host, binding } = fixture({ storage });
    const source = await create(memory, 'state_topic original evidence');
    const interpretations = [];
    for (const name of ['one', 'two']) {
      const observed = await writer.inspect(source.ref, { version: 'latest' });
      const result = await create(writer, `state_topic interpreted ${name}`, {
        input: inputFrom(host, binding, observed.receipt, `state_topic interpreted ${name}`),
        sources: [{ ref: source.ref }],
      });
      interpretations.push(result.ref);
    }
    const current = await revise(memory, source.ref, 'state_topic current evidence');
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
    assert.equal((await writer.inspect(interpretations[0], {})).atom.sources[0].ref, source.ref);
  });

  test(`${adapter}: stale memory is reported, and an explicit Writer edit restores it`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new api.MemoryStorage();
    if (adapter === 'sqlite') t.after(() => storage.close());
    const { memory, writer, host, binding } = fixture({ storage });
    const source = await create(memory, 'boundary_topic: old rule');
    const observed = await writer.inspect(source.ref, { version: 'latest' });
    const written = await create(writer, 'boundary_topic: old interpretation', {
      input: inputFrom(host, binding, observed.receipt, 'boundary_topic: old interpretation'),
      sources: [{ ref: source.ref }],
    });
    const before = storage.watermark();
    assert.match(
      (await writer.read({ query: 'boundary_topic' }, { tokens: 10000 })).text,
      /old interpretation/,
    );
    assert.equal(storage.watermark(), before, 'read must not commit new revisions');
    const revised = await revise(memory, source.ref, 'boundary_topic: current rule');
    const read = await writer.read({ query: 'boundary_topic' }, { tokens: 10000 });
    assert.doesNotMatch(read.text, /old interpretation/);
    assert.match(read.text, /current rule/);
    assert.equal(read.diagnostics.derived, 'pending');
    assert.ok(read.stale.includes(written.ref));
    assert.equal(read.usage.maxModelCalls, 0);
    assert.equal(storage.metaEntries('sdk:cache:derived:').length, 0);
    assert.equal('temporary' in JSON.parse(read.text), false);
    const revisedObservation = await writer.inspect(revised.value.ref, { version: 'latest' });
    await revise(writer, written.ref, 'boundary_topic: current interpretation', {
      input: inputFrom(
        host,
        binding,
        revisedObservation.receipt,
        'boundary_topic: current interpretation',
      ),
      sources: [{ ref: revised.value.ref }],
    });
    const current = await writer.read({ query: 'boundary_topic' }, { tokens: 10000 });
    assert.match(current.text, /current interpretation/);
    assert.deepEqual(current.stale, []);
    assert.equal((await memory.inspect(source.ref, {})).atom.text, 'boundary_topic: old rule');
  });
}
