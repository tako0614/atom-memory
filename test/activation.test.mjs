import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { create, revise } from './fixtures.mjs';
import { MemoryHost, LocalAuthority, MemoryStorage, adaptiveUse } from '../dist/index.js';
import { useStateKey, useEventKey, putUseState, putUseEvent } from '../dist/core/use-state.js';
import { snapshotUse } from '../dist/client/activation.js';

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
      const item = await create(f.memory, 'unit weight');
      const revision = target(storage, item.ref).revisionId;
      await f.memory.read({ query: 'unit weight' });
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)), undefined);
      const result = f.host.recordUse([item.ref], f.binding, { eventId: 'event-1' });
      assert.equal(typeof result.acceptedAt, 'number');
      assert.equal(result.recorded, 1);
      assert.equal(result.repeated, 0);
      const state = storage.metaGet(useStateKey('owner', 'p', revision));
      assert.equal(state.format, 'atom-memory/use-state/v1');
      assert.equal(state.modelId, adaptiveUse().id);
      assert.deepEqual(state.state, {
        mass: 1,
        updatedAt: result.acceptedAt,
        halfLifeMs: 7 * 24 * 60 * 60 * 1000,
      });
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
      const item = await create(f.memory, 'restartable');
      assert.equal(f.host.recordUse([item.ref], f.binding, { eventId: 'same-event' }).recorded, 1);
      assert.equal(f.host.recordUse([item.ref], f.binding, { eventId: 'same-event' }).repeated, 1);
      const restarted = createFixture(storage, {});
      assert.equal(
        restarted.host.recordUse([item.ref], restarted.binding, { eventId: 'same-event' }).repeated,
        1,
      );
      assert.equal(
        storage.metaGet(useStateKey('owner', 'p', target(storage, item.ref).revisionId)).state.mass,
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
    const item = await create(host.connect(binding), 'same subject');
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
    const first = await create(f.memory, 'first revision');
    const edited = await revise(f.memory, first.ref, 'second revision');
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
    const f = createFixture(storage, {
      model: adaptiveUse({ initialHalfLifeMs: 1000, maxHalfLifeMs: 10_000 }),
      maxBoost: 0.3,
    });
    const item = await create(f.memory, 'clock');
    const revision = target(storage, item.ref).revisionId;
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      f.host.recordUse([item.ref], f.binding, { eventId: 't1' });
      Date.now = () => 0;
      f.host.recordUse([item.ref], f.binding, { eventId: 't2' });
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)).updatedAt, 1000);
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision)).state.mass, 2);
      Date.now = () => 2000;
      f.host.recordUse([item.ref], f.binding, { eventId: 't3' });
      const state = storage.metaGet(useStateKey('owner', 'p', revision));
      assert.ok(Math.abs(state.state.mass - 2) < 1e-12);
      assert.equal(state.updatedAt, 2000);
      assert.equal(state.state.halfLifeMs, 1500);
    } finally {
      Date.now = originalNow;
    }
  },
);

storageTest(
  'reset invalidated half-life, keeps dedup markers, and purge removes all use metadata',
  async (storage) => {
    const f = createFixture(storage, {
      model: adaptiveUse({ initialHalfLifeMs: 1000, maxHalfLifeMs: 10_000 }),
    });
    const item = await create(f.memory, 'reset and purge');
    const revision = target(storage, item.ref).revisionId;
    f.host.recordUse([item.ref], f.binding, { eventId: 'keep-marker' });
    const changed = new MemoryHost({
      authority: f.authority,
      storage,
      activation: {
        model: adaptiveUse({ initialHalfLifeMs: 2000, maxHalfLifeMs: 10_000 }),
      },
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

storageTest(
  'batch-local ids cannot record use before a committed AtomRef is returned',
  async (storage) => {
    const f = createFixture(storage);
    assert.throws(
      () => f.host.recordUse(['local:pending'], f.binding, { eventId: 'pending' }),
      error('INVALID_REF'),
    );
    const committed = await create(f.memory, 'committed batch output');
    assert.equal(
      f.host.recordUse([committed.ref], f.binding, { eventId: 'committed' }).recorded,
      1,
    );
  },
);

storageTest(
  'custom state is isolated, replay is inert, and the fixed boost stays bounded',
  async (storage) => {
    let updates = 0;
    let values = 0;
    const accepted = [];
    const model = {
      id: 'counted-use-v1',
      update(previous, acceptedAt) {
        updates++;
        accepted.push(acceptedAt);
        if (previous) {
          assert.ok(Object.isFrozen(previous));
          assert.ok(Object.isFrozen(previous.nested));
        }
        return { uses: (previous?.uses ?? 0) + 1, nested: { retained: true } };
      },
      value(state, now) {
        values++;
        if (!state) return 0;
        assert.ok(Object.isFrozen(state));
        assert.ok(Object.isFrozen(state.nested));
        assert.ok(now >= accepted.at(-1));
        return state.uses;
      },
    };
    const f = createFixture(storage, { model, maxBoost: 0.3, propagation: 0 });
    const used = await create(f.memory, 'custom used');
    const unused = await create(f.memory, 'custom unused');
    const originalNow = Date.now;
    try {
      Date.now = () => 100;
      assert.equal(f.host.recordUse([used.ref], f.binding, { eventId: 'one' }).recorded, 1);
      Date.now = () => 0;
      assert.equal(f.host.recordUse([used.ref], f.binding, { eventId: 'one' }).repeated, 1);
      assert.equal(updates, 1, 'idempotent replay never calls update');
      assert.equal(f.host.recordUse([used.ref], f.binding, { eventId: 'two' }).recorded, 1);
      assert.deepEqual(accepted, [100, 100], 'host-owned time remains monotone');

      const session = f.host.engine.session(f.binding, { budget: { maxBytes: 100_000 } });
      const revisions = [used, unused].map((item) =>
        f.host.engine.get(target(storage, item.ref), session),
      );
      const result = snapshotUse(f.host.engine, session, revisions);
      assert.equal(result.at, 100);
      assert.ok(values >= 2);
      assert.ok(Math.abs(result.boosts[0] - 1.2) < 1e-15);
      assert.equal(result.boosts[1], 1);
      assert.ok(result.boosts.every((boost) => boost >= 1 && boost <= 1.3));
      const stored = storage.metaGet(
        useStateKey('owner', 'p', target(storage, used.ref).revisionId),
      );
      assert.deepEqual(stored.state, { uses: 2, nested: { retained: true } });
    } finally {
      Date.now = originalNow;
    }
  },
);

storageTest('batch updates and snapshots use one host-owned monotonic time', async (storage) => {
  const updateTimes = [];
  const valueTimes = [];
  const f = createFixture(storage, {
    model: {
      id: 'common-clock-v1',
      update(previous, acceptedAt) {
        updateTimes.push(acceptedAt);
        return { uses: (previous?.uses ?? 0) + 1 };
      },
      value(state, now) {
        valueTimes.push(now);
        return state?.uses ?? 0;
      },
    },
  });
  const first = await create(f.memory, 'common clock first');
  const second = await create(f.memory, 'common clock second');
  const firstRevision = target(storage, first.ref).revisionId;
  const secondRevision = target(storage, second.ref).revisionId;
  const originalNow = Date.now;
  try {
    Date.now = () => 100;
    f.host.recordUse([first.ref], f.binding, { eventId: 'first-only' });
    Date.now = () => 200;
    f.host.recordUse([second.ref], f.binding, { eventId: 'second-only' });

    Date.now = () => 0;
    updateTimes.length = 0;
    valueTimes.length = 0;
    const session = f.host.engine.session(f.binding, { budget: { maxBytes: 100_000 } });
    const revisions = [first, second].map((item) =>
      f.host.engine.get(target(storage, item.ref), session),
    );
    const snapshot = snapshotUse(f.host.engine, session, revisions);
    assert.equal(snapshot.at, 200);
    assert.deepEqual(valueTimes, [200, 200]);

    const result = f.host.recordUse([first.ref, second.ref], f.binding, { eventId: 'batch' });
    assert.equal(result.acceptedAt, 200);
    assert.equal(result.recorded, 2);
    assert.deepEqual(updateTimes, [200, 200]);
    for (const revisionId of [firstRevision, secondRevision]) {
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revisionId)).updatedAt, 200);
      assert.equal(storage.metaGet(useEventKey('owner', 'p', revisionId, 'batch')).acceptedAt, 200);
    }
    const replay = f.host.recordUse([first.ref, second.ref], f.binding, { eventId: 'batch' });
    assert.equal(replay.acceptedAt, 200);
    assert.equal(replay.repeated, 2);
    assert.deepEqual(updateTimes, [200, 200], 'replay does not invoke update');
  } finally {
    Date.now = originalNow;
  }
});

storageTest('a late custom callback failure rolls back every state and marker', async (storage) => {
  let calls = 0;
  const f = createFixture(storage, {
    model: {
      id: 'atomic-custom-v1',
      update() {
        calls++;
        if (calls === 2) throw new Error('late failure');
        return { uses: 1 };
      },
      value: () => 0,
    },
  });
  const first = await create(f.memory, 'atomic custom first');
  const second = await create(f.memory, 'atomic custom second');
  assert.throws(
    () => f.host.recordUse([first.ref, second.ref], f.binding, { eventId: 'atomic-custom' }),
    error('INVALID_INPUT'),
  );
  assert.equal(calls, 2);
  assert.equal(storage.metaEntries('sdk:use:').length, 0);
});

storageTest('new-format state requires the host-owned monotonic timestamp', async (storage) => {
  const f = createFixture(storage);
  const item = await create(f.memory, 'required host timestamp');
  const revision = target(storage, item.ref).revisionId;
  f.host.recordUse([item.ref], f.binding, { eventId: 'initial' });
  const key = useStateKey('owner', 'p', revision);
  const { updatedAt: _, ...withoutTimestamp } = storage.metaGet(key);
  storage.metaSet(key, withoutTimestamp);
  assert.throws(
    () => f.host.recordUse([item.ref], f.binding, { eventId: 'must-not-update' }),
    error('STATE_INVALIDATED'),
  );
  assert.equal(storage.metaGet(useEventKey('owner', 'p', revision, 'must-not-update')), undefined);
});

storageTest(
  'async or oversized custom state fails atomically and callback work is budgeted',
  async (storage) => {
    const f = createFixture(storage);
    const item = await create(f.memory, 'bounded custom');
    for (const [id, update] of [
      ['async-custom-v1', async () => ({ uses: 1 })],
      ['large-custom-v1', () => ({ value: 'x'.repeat(1025) })],
    ]) {
      const host = new MemoryHost({
        ...f.host.engine.options,
        storage,
        activation: { model: { id, update, value: () => 0 } },
      });
      assert.throws(
        () => host.recordUse([item.ref], f.binding, { eventId: id }),
        error('INVALID_INPUT'),
      );
      assert.equal(storage.metaEntries('sdk:use:').length, 0);
    }
    let calls = 0;
    const noWork = new MemoryHost({
      ...f.host.engine.options,
      storage,
      activation: {
        model: {
          id: 'work-custom-v1',
          update() {
            calls++;
            return {};
          },
          value: () => 0,
        },
      },
      defaults: { maxEvaluationWork: 0 },
    });
    assert.throws(
      () => noWork.recordUse([item.ref], f.binding, { eventId: 'no-work' }),
      error('BUDGET_EXHAUSTED'),
    );
    assert.equal(calls, 0);
    assert.equal(storage.metaEntries('sdk:use:').length, 0);
  },
);

storageTest(
  'legacy aggregates preserve exact value, migrate on use, and never replay after reset',
  async (storage) => {
    const f = createFixture(storage, { propagation: 0, maxBoost: 0.3 });
    const item = await create(f.memory, 'legacy aggregate');
    const revision = target(storage, item.ref);
    const legacy = {
      subject: 'owner',
      policy: 'p',
      revisionId: revision.revisionId,
      halfLifeMs: 400 * 24 * 60 * 60 * 1000,
      updatedAt: 0,
      h: 2_000_000,
    };
    putUseState(storage, legacy);
    const originalNow = Date.now;
    try {
      Date.now = () => 100 * 24 * 60 * 60 * 1000;
      const session = f.host.engine.session(f.binding, { budget: { maxBytes: 100_000 } });
      const node = f.host.engine.get(revision, session);
      const snapshot = snapshotUse(f.host.engine, session, [node]);
      const expected = legacy.h * 2 ** (-100 / 400);
      assert.ok(Math.abs(snapshot.boosts[0] - (1 + 0.3 * (expected / (1 + expected)))) < 1e-15);
      assert.deepEqual(storage.metaGet(useStateKey('owner', 'p', revision.revisionId)), legacy);

      putUseEvent(storage, {
        subject: 'owner',
        policy: 'p',
        revisionId: revision.revisionId,
        eventId: 'already-used',
        acceptedAt: 0,
      });
      f.host.resetUse(f.binding);
      assert.equal(storage.metaGet(useStateKey('owner', 'p', revision.revisionId)), undefined);
      assert.equal(
        f.host.recordUse([item.ref], f.binding, { eventId: 'already-used' }).repeated,
        1,
      );
      assert.equal(
        storage.metaGet(useStateKey('owner', 'p', revision.revisionId)),
        undefined,
        'an old marker never reconstructs an absent aggregate',
      );

      putUseState(storage, legacy);
      assert.equal(f.host.recordUse([item.ref], f.binding, { eventId: 'migrate' }).recorded, 1);
      const migrated = storage.metaGet(useStateKey('owner', 'p', revision.revisionId));
      assert.equal(migrated.format, 'atom-memory/use-state/v1');
      assert.equal(migrated.state.mass, 1_000_000);
      assert.equal(migrated.state.halfLifeMs, legacy.halfLifeMs);
    } finally {
      Date.now = originalNow;
    }
  },
);
