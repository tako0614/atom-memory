import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryHost, LocalAuthority, MemoryStorage, utf8Tokenizer } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { canonical, digest } from '../dist/core/util.js';

// Published v0.4/v0.3 identities for this fixture's test-space encoder.
// Keep these independent of the current v3 Engine getters so migration cannot
// silently pass by manufacturing the fixture from the implementation under test.
// PREVIOUS_INDEX_CONFIG = sha256({dimensions:2,encoder:'test-space',representationVersion:2})
const PREVIOUS_INDEX_CONFIG = 'b89cacf3eba1e89c2b50db14fffc1fba89052dca5272efaf81320901223d9fd1';
// LEGACY_CONFIG additionally includes provider:'local-exact-lexical-vector-v1' and tokenizer:'utf8-bytes-v1'.
const LEGACY_CONFIG = '8b849b506f6e4668f06cc487b1894c3b64041dca4ac7bbbff258a4dc56a9a8c0';
const OTHER_ENCODER_CONFIG = 'd22afd0b459422d3ab4f37823c924c8fafa2ea9f5cfe9ead27b42f8094f58408';
const bodyHash = (text) => digest(text);
const progressKey = (config, policies = ['p']) =>
  `sdk:index-progress:${digest(canonical([config, 'p', policies]))}`;

function setup(storage, extra = {}) {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'owner',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const calls = [];
  const embedding = {
    id: 'test-space',
    dimensions: 2,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    async embed(texts, signal, purpose) {
      calls.push({ texts, purpose });
      return texts.map((text) => (/orchard|fruit|new/.test(text) ? [1, 0] : [0, 1]));
    },
  };
  const options = { storage, authority, embedding, ...extra };
  const host = new MemoryHost(options);
  const binding = { auth, writePolicy: 'p', actor: { type: 'input-adapter' } };
  return { host, binding, memory: host.connect(binding), calls, options };
}
function targetOf(storage, ref) {
  return storage.metaGet(`sdk:ref:${ref}`).target;
}
function indexKey(storage, ref) {
  return `sdk:index:${targetOf(storage, ref).revisionId}`;
}
async function drain(host, binding, limit = 3) {
  for (let i = 0; i < 300; i++) if (!(await host.updateIndex(binding, { limit })).pending) return;
  throw Error('Index did not drain');
}
for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: committed changes, own-body indexing, retries and restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-index-'));
    let storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'atom.sqlite')) : new MemoryStorage();
    try {
      const f = setup(storage);
      const leaf = await f.memory.write('old source');
      const parent = await f.memory.write({ text: 'collection', links: { member: leaf.ref } });
      const fixed = await f.memory.write({
        text: 'fixed',
        links: { member: { ref: leaf.ref, at: 'observed' } },
      });
      // Multiple revisions share one commit sequence: a one-item page must not skip ties.
      await f.memory.edit(async (draft) => {
        await draft.write('first');
        await draft.write('second');
      });
      await drain(f.host, f.binding, 1);
      assert.equal(f.calls.filter((call) => call.purpose === 'document').length, 5);
      assert.deepEqual(
        f.calls
          .filter((call) => call.purpose === 'document')
          .map((call) => call.texts)
          .sort((a, b) => a[0].localeCompare(b[0])),
        [['collection'], ['first'], ['fixed'], ['old source'], ['second']],
      );
      const before = f.calls.length;
      await f.memory.edit((draft) => draft.revise(leaf.ref, 'new source'));
      const embed = f.options.embedding.embed;
      f.options.embedding.embed = async () => {
        throw Error('encoder unavailable');
      };
      await assert.rejects(f.host.updateIndex(f.binding), /encoder unavailable/);
      f.options.embedding.embed = embed;
      if (adapter === 'sqlite') {
        storage.close();
        storage = new SqliteStorage(join(dir, 'atom.sqlite'));
      }
      const restarted = new MemoryHost({ ...f.options, storage });
      await drain(restarted, f.binding, 1);
      assert.equal(
        f.calls.length - before,
        1,
        'only the changed Atom is re-encoded; linked parents own their body index',
      );
      assert.ok(
        f.calls
          .slice(before)
          .some((call) => call.purpose === 'document' && call.texts[0] === 'new source'),
      );
      assert.ok(!f.calls.slice(before).some((call) => call.texts[0].includes('collection')));
      assert.ok(!f.calls.slice(before).some((call) => call.texts[0].includes('fixed')));
      const done = f.calls.length;
      await drain(restarted, f.binding);
      assert.equal(f.calls.length, done, 'idle maintenance does not call the encoder');
      assert.equal((await restarted.connect(f.binding).inspect(fixed.ref)).atom.text, 'fixed');
      assert.equal(
        (await restarted.connect(f.binding).inspect(parent.ref)).atom.text,
        'collection',
      );
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: zero-weight links do not seed a parent from target body text`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-body-'));
    const storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'atom.sqlite')) : new MemoryStorage();
    try {
      const f = setup(storage, { ranking: { relations: { ignored: { forward: 0, reverse: 0 } } } });
      const target = await f.memory.write('orchard fruit');
      const parent = await f.memory.write({
        text: 'unrelated parent',
        links: { ignored: target.ref },
      });
      const result = await f.memory.search('orchard', { depth: 2 });
      assert.ok(result.items.some((item) => item.ref === target.ref));
      assert.equal(
        result.items.some((item) => item.ref === parent.ref),
        false,
      );
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: published v2 vectors reuse only matching own-body metadata`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-migration-'));
    const storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'atom.sqlite')) : new MemoryStorage();
    try {
      const f = setup(storage);
      const v2 = await f.memory.write('v2 own body');
      const v03 = await f.memory.write('v03 own body');
      const mixedTarget = await f.memory.write('mixed target');
      const mixedParent = await f.memory.write({
        text: 'mixed parent',
        links: { member: mixedTarget.ref },
      });
      const wrongPolicy = await f.memory.write('wrong policy');
      const wrongEncoder = await f.memory.write('wrong encoder');
      const seed = (ref, config, hash, policyId = 'p') =>
        storage.metaSet(indexKey(storage, ref), {
          config,
          hash,
          policyId,
          vectors: [[1, 0]],
        });
      seed(v2.ref, PREVIOUS_INDEX_CONFIG, bodyHash('v2 own body'));
      seed(v03.ref, LEGACY_CONFIG, bodyHash('v03 own body'));
      seed(mixedTarget.ref, PREVIOUS_INDEX_CONFIG, bodyHash('mixed target'));
      seed(
        mixedParent.ref,
        PREVIOUS_INDEX_CONFIG,
        bodyHash('mixed parent\n1. member: mixed target'),
      );
      seed(wrongPolicy.ref, PREVIOUS_INDEX_CONFIG, bodyHash('wrong policy'), 'q');
      seed(wrongEncoder.ref, OTHER_ENCODER_CONFIG, bodyHash('wrong encoder'));
      await drain(f.host, f.binding, 1);
      assert.deepEqual(
        f.calls
          .filter((call) => call.purpose === 'document')
          .map((call) => call.texts)
          .sort((a, b) => a[0].localeCompare(b[0])),
        [['mixed parent'], ['wrong encoder'], ['wrong policy']],
      );
      for (const [ref, text] of [
        [v2.ref, 'v2 own body'],
        [v03.ref, 'v03 own body'],
        [mixedTarget.ref, 'mixed target'],
      ]) {
        const index = storage.metaGet(indexKey(storage, ref));
        assert.equal(index.config, f.host.engine.indexConfig);
        assert.equal(index.hash, bodyHash(text));
      }
      for (const [ref, text] of [
        [mixedParent.ref, 'mixed parent'],
        [wrongPolicy.ref, 'wrong policy'],
        [wrongEncoder.ref, 'wrong encoder'],
      ]) {
        const index = storage.metaGet(indexKey(storage, ref));
        assert.equal(index.config, f.host.engine.indexConfig);
        assert.equal(index.hash, bodyHash(text));
        assert.equal(index.policyId, 'p');
      }
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: v3 progress ignores v2 checkpoints and drains after restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-progress-'));
    let storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'atom.sqlite')) : new MemoryStorage();
    try {
      const f = setup(storage);
      await f.memory.write('first progress item');
      await f.memory.write('second progress item');
      const oldKey = progressKey(PREVIOUS_INDEX_CONFIG);
      const stale = { after: { sequence: Number.MAX_SAFE_INTEGER, revisionId: 'stale-v2' } };
      storage.metaSet(oldKey, stale);
      const first = await f.host.updateIndex(f.binding, { limit: 1 });
      assert.equal(first.indexed, 1);
      assert.equal(first.pending, true);
      const changes = storage.changes(
        ['p'],
        { sequence: 0, revisionId: '' },
        10,
        storage.watermark(),
      );
      const current = storage.metaGet(progressKey(f.host.engine.indexConfig));
      assert.deepEqual(current, {
        after: { sequence: changes[0].sequence, revisionId: changes[0].revision.revisionId },
      });
      assert.notDeepEqual(current, stale);
      if (adapter === 'sqlite') {
        storage.close();
        storage = new SqliteStorage(join(dir, 'atom.sqlite'));
      }
      const restarted = new MemoryHost({ ...f.options, storage });
      await drain(restarted, f.binding, 1);
      assert.equal(f.calls.filter((call) => call.purpose === 'document').length, 2);
      await drain(restarted, f.binding, 1);
      assert.equal(f.calls.filter((call) => call.purpose === 'document').length, 2);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('SQLite default hybrid vectors find a lexical miss without scanning unrelated or private bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-vector-'));
  const storage = new SqliteStorage(join(dir, 'atom.sqlite'));
  try {
    const f = setup(storage, { maxScan: 16 });
    const unrelated = await f.memory.write('unrelated stone 0');
    for (let i = 1; i < 35; i++) await f.memory.write(`unrelated stone ${i}`);
    const foreignAuth = f.options.authority.issue({
      subject: 'foreign',
      readPolicies: ['q'],
      writePolicies: ['q'],
      canIngestSource: true,
    });
    const foreignBinding = {
      auth: foreignAuth,
      writePolicy: 'q',
      actor: { type: 'input-adapter' },
    };
    const foreign = f.host.connect(foreignBinding);
    for (let i = 0; i < 20; i++) await foreign.write(`orchard PRIVATE ${i}`);
    await drain(f.host, foreignBinding, 8);
    const source = await f.memory.write('orchard');
    const parent = await f.memory.write('garden');
    const relation = await f.memory.write({
      text: 'location relation',
      links: { group: parent.ref, member: source.ref },
    });
    await drain(f.host, f.binding, 8);
    const result = await f.memory.read(
      { context: 'fruit', thought: 'fruit season' },
      { depth: 2, tokens: 16000 },
    );
    assert.ok(result.items.some((item) => item.text === 'orchard'));
    assert.ok(result.items.some((item) => item.text === 'location relation'));
    assert.equal(result.diagnostics.approximate, true);
    assert.ok(
      !result.items.some((item) => item.text.includes('PRIVATE')),
      'vector buckets respect current scope before limiting hits',
    );
    assert.ok(
      f.calls.some((call) => call.purpose === 'query' && call.texts.includes('fruit season')),
    );
    const sourceId = storage
      .scan({ policies: ['p'], text: ['orchard'], limit: 100 }, storage.watermark())
      .find((r) => r.body.value === 'orchard').atomId;
    // Vector equality does not identify an unrelated Atom: the dependent
    // relation has the same fixed vector and is correctly removed by purge.
    const unrelatedKey = indexKey(storage, unrelated.ref);
    const relationKey = indexKey(storage, relation.ref);
    const unrelatedIndex = storage.metaGet(unrelatedKey);
    assert.ok(unrelatedIndex);
    f.host.purge(sourceId);
    assert.deepEqual(
      storage.metaGet(unrelatedKey),
      unrelatedIndex,
      'purge preserves unrelated vectors and their maintenance progress',
    );
    assert.equal(storage.metaGet(relationKey), undefined, 'purge removes the dependent relation');
    assert.ok(
      !(await f.memory.read({ context: 'fruit' }, { tokens: 16000 })).items.some(
        (item) => item.text === 'orchard',
      ),
    );
    assert.equal((await f.host.updateIndex(f.binding)).pending, false);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: old index metadata cannot report an unindexed current candidate ready`, async () => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : new MemoryStorage();
    try {
      const f = setup(storage);
      const source = await f.memory.write('orchard');
      const revision = storage.metaGet(`sdk:ref:${source.ref}`).target;
      storage.metaSet(`sdk:index:${revision.revisionId}`, {
        config: PREVIOUS_INDEX_CONFIG,
        hash: bodyHash('orchard'),
        policyId: 'p',
        vectors: [[1, 0]],
      });
      const pending = await f.memory.search('orchard');
      assert.equal(pending.items.length, 1);
      assert.equal(pending.diagnostics.index, 'pending');
      await f.host.prepareIndex(f.binding);
      assert.equal((await f.memory.search('orchard')).diagnostics.index, 'ready');
    } finally {
      storage.close();
    }
  });

test('failed indexing never rolls back committed content and cannot publish a purged vector', async () => {
  const f = setup(new MemoryStorage());
  const source = await f.memory.write('orchard');
  const r = f.options.storage.scan({ policies: ['p'], limit: 1 }, f.options.storage.watermark())[0];
  f.options.embedding.embed = async () => {
    f.host.purge(r.atomId);
    return [[1, 0]];
  };
  await assert.rejects(f.host.indexAtoms([source.ref], f.binding), /ACCESS_DENIED/);
  assert.equal(f.options.storage.metaGet(`sdk:index:${r.revisionId}`), undefined);
  assert.equal((await f.host.updateIndex(f.binding)).pending, false);
});
