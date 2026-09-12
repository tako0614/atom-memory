import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, origin } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';
import { AtomicStore } from '../dist/core/store.js';
import { content } from '../dist/core/helpers.js';
// Legacy selectors/harness are replaced by the current client, while atomic
// validation remains tested at the internal store boundary.
for (const adapter of ['memory', 'sqlite']) {
  const setup = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-store-04-'));
    const storage =
      adapter === 'sqlite' ? new SqliteStorage(join(dir, 'db.sqlite')) : new MemoryStorage();
    t.after(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return fixture({ storage });
  };
  test(`${adapter}: independent multi-membership survives another relation's retirement`, async (t) => {
    const { memory: m } = setup(t);
    const child = await m.write('shared child'),
      p = await m.write('P'),
      q = await m.write('Q');
    const a = await m.write({ text: 'membership P', links: { group: p.ref, member: child.ref } });
    const b = await m.write({ text: 'membership Q', links: { group: q.ref, member: child.ref } });
    await m.edit((d) => d.retire(a.ref));
    assert.equal((await m.inspect(b.ref, { depth: 2 })).atom.text, 'membership Q');
    assert.equal((await m.inspect(child.ref)).atom.state, 'active');
  });
  test(`${adapter}: observed references keep their version and logical links follow revisions`, async (t) => {
    const { memory: m } = setup(t);
    const a = await m.write('version one');
    const p = await m.write({ text: 'fixed', links: { member: { ref: a.ref, at: 'observed' } } });
    const q = await m.write({ text: 'current', links: { member: a.ref } });
    await m.edit((d) => d.revise(a.ref, 'version two'));
    assert.ok((await m.inspect(p.ref)).items.some((i) => i.text === 'version one'));
    assert.ok((await m.inspect(q.ref)).items.some((i) => i.text === 'version two'));
  });
  test(`${adapter}: private edits roll back and a stale Writer cannot commit`, async (t) => {
    const f = setup(t),
      input = await f.memory.write('input'),
      before = f.storage.watermark();
    await assert.rejects(
      f.memory.edit(async (d) => {
        await d.write('rollback');
        throw Error('abort');
      }),
      /abort/,
    );
    assert.equal(f.storage.watermark(), before);
    await assert.rejects(
      f.writer.edit(async (d) => {
        await d.inspect(input.ref, { version: 'latest' });
        await d.write('stale result');
        await f.memory.edit((other) => other.revise(input.ref, 'changed'));
      }),
      { code: 'REVISION_CONFLICT' },
    );
    assert.ok(
      !(await f.memory.search('stale result')).items.some((i) => i.text === 'stale result'),
    );
  });
  test(`${adapter}: atomic CAS, idempotency and trusted source ingestion remain enforced`, async (t) => {
    const f = setup(t),
      store = new AtomicStore({ storage: f.storage, authority: f.authority });
    const request = {
      idempotencyKey: 'raw',
      guards: [],
      revisions: [
        {
          atomId: 'raw',
          revisionId: 'raw:1',
          expectedHead: null,
          content: content('source', 'original', 'p'),
        },
      ],
    };
    const first = await store.write(request, f.auth);
    assert.equal((await store.write(request, f.auth)).operationId, first.operationId);
    await assert.rejects(
      store.write(
        {
          ...request,
          revisions: [{ ...request.revisions[0], content: content('source', 'different', 'p') }],
        },
        f.auth,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      store.write(
        {
          ...request,
          idempotencyKey: 'again',
          revisions: [{ ...request.revisions[0], revisionId: 'raw:2' }],
        },
        f.auth,
      ),
      { code: 'REVISION_CONFLICT' },
    );
    const auth = f.authority.issue({ subject: 'agent', readPolicies: ['p'], writePolicies: ['p'] });
    await assert.rejects(
      store.write(
        {
          ...request,
          idempotencyKey: 'forged',
          revisions: [{ ...request.revisions[0], atomId: 'forged', revisionId: 'forged:1' }],
        },
        auth,
      ),
      { code: 'ACCESS_DENIED' },
    );
  });
  test(`${adapter}: semantic labels are generic; logical include remains invalid`, async (t) => {
    const f = setup(t),
      store = new AtomicStore({ storage: f.storage, authority: f.authority });
    await store.write(
      {
        idempotencyKey: 'labels',
        guards: [],
        revisions: ['summary', 'extract', 'membership'].map((schema) => ({
          atomId: schema,
          revisionId: schema + ':1',
          expectedHead: null,
          content: content(schema, schema, 'p'),
        })),
      },
      f.auth,
    );
    await assert.rejects(
      store.write(
        {
          idempotencyKey: 'include',
          guards: [],
          revisions: [
            {
              atomId: 'bad',
              revisionId: 'bad:1',
              expectedHead: null,
              content: content('atom', 'bad', 'p', {
                slots: [
                  {
                    role: 'child',
                    mode: 'include',
                    target: { kind: 'logical', atomId: 'summary' },
                  },
                ],
              }),
            },
          ],
        },
        f.auth,
      ),
      { code: 'PINNED_INCLUDE_REQUIRED' },
    );
  });
  test(`${adapter}: purge erases previous versions, blobs and dependent organizations`, async (t) => {
    const f = setup(t),
      source = await f.host.ingestBlob(Buffer.from('private source'), 'text/plain', f.binding);
    const statement = await f.writer.write('interpretation', { sources: [{ ref: source.ref }] });
    await f.memory.edit((d) => d.retire(statement.ref));
    f.host.purge(f.storage.metaGet(`sdk:ref:${source.ref}`).target.atomId);
    await assert.rejects(f.memory.inspect(source.ref), { code: 'ACCESS_DENIED' });
    await assert.rejects(f.memory.inspect(statement.ref), { code: 'ACCESS_DENIED' });
    assert.equal(f.storage.metaEntries('blob:').length, 0);
  });
}
test('UTF-8 source coordinates reject split code points and remain byte exact', () => {
  const ref = { kind: 'pinned', atomId: 's', revisionId: 's:1' };
  assert.throws(() => origin(ref, 'あ', 1, 3), { code: 'INVALID_SOURCE_SPAN' });
  assert.equal(origin(ref, 'あ').selector.end, 3);
});
