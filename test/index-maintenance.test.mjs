import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryHost,
  LocalAuthority,
  MemoryStorage,
  HybridCandidateProvider,
  utf8Tokenizer,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

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
async function drain(host, binding, limit = 3) {
  for (let i = 0; i < 300; i++) if (!(await host.updateIndex(binding, { limit })).pending) return;
  throw Error('Index did not drain');
}
for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: committed changes, logical dependencies, retries and restart`, async () => {
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
        2,
        'only the changed leaf and its logical dependent are re-encoded',
      );
      assert.ok(
        f.calls.some(
          (call) => call.texts[0].includes('collection') && call.texts[0].includes('new source'),
        ),
      );
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

test('SQLite hybrid vectors find a lexical miss without scanning unrelated or private bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-vector-'));
  const storage = new SqliteStorage(join(dir, 'atom.sqlite'));
  try {
    const f = setup(storage, { candidateProvider: new HybridCandidateProvider(), maxScan: 16 });
    for (let i = 0; i < 35; i++) await f.memory.write(`unrelated stone ${i}`);
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
    const unrelatedIndex = storage
      .metaEntries('sdk:index:')
      .find(([, index]) => index.vectors[0][1] === 1);
    assert.ok(unrelatedIndex);
    f.host.purge(sourceId);
    assert.deepEqual(
      storage.metaGet(unrelatedIndex[0]),
      unrelatedIndex[1],
      'purge preserves unrelated vectors and their maintenance progress',
    );
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
