import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { MemoryHost, LocalAuthority, MemoryStorage } from '../dist/index.js';
import { useStateKey, useEventKey } from '../dist/core/use-state.js';

const error = (code) => (value) => value?.code === code;

function createFixture(storage, activation = {}) {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'owner',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const host = new MemoryHost({ authority, storage, activation });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  return { authority, auth, host, binding, memory: host.connect(binding) };
}

function target(storage, ref) {
  return storage.metaGet(`sdk:ref:${ref}`).target;
}

function eachStorage(name, make) {
  return { name, make };
}

const stores = [
  eachStorage('memory', () => ({ storage: new MemoryStorage(), close() {} })),
  eachStorage('sqlite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-use-'));
    const storage = new SqliteStorage(join(dir, 'memory.sqlite'));
    return {
      storage,
      close: () => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }),
];

for (const { name, make } of stores) {
  test(`scoped unit use and read alone do not activate (${name})`, async () => {
    const { storage, close } = make();
    try {
      const f = createFixture(storage);
      const item = await f.memory.write('unit weight');
      const revision = target(storage, item.ref).revisionId;
      await f.memory.read({ query: 'unit weight' });
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)), undefined);
      const result = f.host.recordUse([item.ref], f.binding, { eventId: 'event-1' });
      assert.equal(typeof result.acceptedAt, 'number');
      assert.equal(result.recorded, 1);
      assert.equal(result.repeated, 0);
      const state = storage.metaGet(useStateKey('owner', 'p', revision));
      assert.equal(state.h, 1);
      assert.equal(
        storage.metaGet(useEventKey('owner', 'p', revision, 'event-1')).eventId,
        'event-1',
      );
    } finally {
      close();
    }
  });

  test(`duplicate use is durable and restart-safe (${name})`, async () => {
    const { storage, close } = make();
    try {
      const f = createFixture(storage);
      const item = await f.memory.write('restartable');
      assert.equal(f.host.recordUse([item.ref], f.binding, { eventId: 'same-event' }).recorded, 1);
      assert.equal(f.host.recordUse([item.ref], f.binding, { eventId: 'same-event' }).repeated, 1);
      const restarted = createFixture(storage, {});
      assert.equal(
        restarted.host.recordUse([item.ref], restarted.binding, { eventId: 'same-event' }).repeated,
        1,
      );
      assert.equal(
        storage.metaGet(useStateKey('owner', 'p', target(storage, item.ref).revisionId)).h,
        1,
      );
    } finally {
      close();
    }
  });
}

function storageTest(description, run) {
  for (const { name, make } of stores)
    test(`${name}: ${description}`, async (t) => {
      const { storage, close } = make();
      t.after(close);
      await run(storage);
    });
}

storageTest(
  'renewed handles preserve subject scope while other subjects and policies are denied',
  async (storage) => {
    const authority = new LocalAuthority();
    const auth = authority.issue({
      subject: 'owner',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const host = new MemoryHost({ authority, storage });
    const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
    const item = await host.connect(binding).write('same subject');
    const renewed = authority.issue({
      subject: 'owner',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const renewedBinding = { auth: renewed, writePolicy: 'p', actor: { type: 'human' } };
    assert.equal(host.recordUse([item.ref], renewedBinding, { eventId: 'renewed' }).recorded, 1);
    await assert.rejects(host.connect(renewedBinding).inspect(item.ref), error('ACCESS_DENIED'));
    assert.throws(
      () =>
        host.recordUse(
          [item.ref],
          { ...renewedBinding, readPolicies: [] },
          { eventId: 'excluded' },
        ),
      error('ACCESS_DENIED'),
    );
    authority.revoke(renewed);
    assert.throws(
      () => host.recordUse([item.ref], renewedBinding, { eventId: 'revoked' }),
      error('ACCESS_DENIED'),
    );
    const other = authority.issue({
      subject: 'other',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const otherBinding = { auth: other, writePolicy: 'p', actor: { type: 'human' } };
    assert.throws(
      () => host.recordUse([item.ref], otherBinding, { eventId: 'other' }),
      error('ACCESS_DENIED'),
    );
  },
);

storageTest(
  'revision use does not inherit and rollback invalid batches atomically',
  async (storage) => {
    const f = createFixture(storage);
    const first = await f.memory.write('first revision');
    const edited = await f.memory.edit((draft) => draft.revise(first.ref, 'second revision'));
    const oldRevision = target(storage, first.ref).revisionId;
    const newRevision = target(storage, edited.value.ref).revisionId;
    assert.equal(f.host.recordUse([first.ref], f.binding, { eventId: 'old' }).recorded, 1);
    assert.ok(storage.metaGet(useStateKey('owner', 'p', oldRevision)));
    assert.equal(storage.metaGet(useStateKey('owner', 'p', newRevision)), undefined);
    assert.throws(
      () => f.host.recordUse([edited.value.ref, 'forged-ref'], f.binding, { eventId: 'atomic' }),
      error('INVALID_REF'),
    );
    assert.equal(
      f.host.recordUse([edited.value.ref], f.binding, { eventId: 'atomic' }).recorded,
      1,
    );
  },
);

storageTest(
  'clock rollback does not decay, then elapsed time decays exponentially',
  async (storage) => {
    const f = createFixture(storage, { halfLifeMs: 1000, maxBoost: 0.3 });
    const item = await f.memory.write('clock');
    const revision = target(storage, item.ref).revisionId;
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      f.host.recordUse([item.ref], f.binding, { eventId: 't1' });
      Date.now = () => 0;
      f.host.recordUse([item.ref], f.binding, { eventId: 't2' });
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)).updatedAt, 1000);
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)).h, 2);
      Date.now = () => 2000;
      f.host.recordUse([item.ref], f.binding, { eventId: 't3' });
      const state = storage.metaGet(useStateKey('owner', 'p', revision));
      assert.ok(Math.abs(state.h - 2) < 1e-12);
      assert.equal(state.updatedAt, 2000);
    } finally {
      Date.now = originalNow;
    }
  },
);

storageTest(
  'reset invalidated half-life, keeps dedup markers, and purge removes all use metadata',
  async (storage) => {
    const f = createFixture(storage, { halfLifeMs: 1000 });
    const item = await f.memory.write('reset and purge');
    const revision = target(storage, item.ref).revisionId;
    f.host.recordUse([item.ref], f.binding, { eventId: 'keep-marker' });
    const changed = new MemoryHost({
      authority: f.authority,
      storage,
      activation: { halfLifeMs: 2000 },
    });
    assert.throws(
      () => changed.recordUse([item.ref], f.binding, { eventId: 'new-half-life' }),
      error('STATE_INVALIDATED'),
    );
    changed.resetUse(f.binding);
    assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)), undefined);
    assert.ok(storage.metaGet(useEventKey('owner', 'p', revision, 'keep-marker')));
    assert.equal(changed.recordUse([item.ref], f.binding, { eventId: 'keep-marker' }).repeated, 1);
    f.host.purge(target(storage, item.ref).atomId);
    assert.equal(storage.metaGet(useEventKey('owner', 'p', revision, 'keep-marker')), undefined);
  },
);

storageTest('overlay references cannot record use', async (storage) => {
  const f = createFixture(storage);
  await f.memory.edit(async (draft) => {
    const staged = await draft.write('overlay');
    assert.throws(
      () => f.host.recordUse([staged.ref], f.binding, { eventId: 'overlay' }),
      error('INVALID_REF'),
    );
  });
});
