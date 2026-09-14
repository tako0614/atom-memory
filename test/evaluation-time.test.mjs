import test from 'node:test';
import assert from 'node:assert/strict';
import { create, fixture } from './fixtures.mjs';
import { snapshotUse } from '../dist/client/activation.js';
import { startRanking, finishRanking } from '../dist/client/ranking.js';
import { useStateKey } from '../dist/core/use-state.js';

test('internal fixed evaluation time is shared by acquired nodes and final ranking', async (t) => {
  const times = [];
  const f = fixture({
    activation: {
      model: {
        id: 'fixed-evaluation-time-test',
        update: (state) => ({ count: (state?.count ?? 0) + 1 }),
        value: (state, now) => {
          times.push(now);
          return state?.count ?? 0;
        },
      },
    },
  });
  t.after(() => f.storage.close());
  const a = await create(f.memory, 'needle first');
  const b = await create(f.memory, 'needle second');
  const accepted = f.host.recordUse([a.ref], f.binding, { eventId: 'accepted' });
  const at = accepted.acceptedAt + 1000;
  const engine = f.host.engine;
  const session = engine.session(f.binding);
  const nodes = [a, b].map((v) => engine.get(engine.resolve(v.ref, session).target, session));
  times.length = 0;
  assert.equal(snapshotUse(engine, session, [nodes[0]], at).at, at);
  assert.equal(snapshotUse(engine, session, [nodes[1]], at).at, at);
  const state = startRanking(
    nodes.map((revision) => ({ revision, score: 1 })),
    0,
  );
  const final = finishRanking(engine, session, state, [{ kind: 'context', text: 'needle' }], {
    evaluatedAt: at,
  });
  assert.equal(final.evaluation.evaluatedAt, at);
  assert.deepEqual(times, [at, at, at, at]);
  assert.equal(f.storage.metaEntries('sdk:use:event:').length, 1, 'evaluation never records use');
});

test('fixed time rejects newer use state instead of silently mixing evaluation instants', async (t) => {
  const f = fixture();
  t.after(() => f.storage.close());
  const item = await create(f.memory, 'needle');
  const accepted = f.host.recordUse([item.ref], f.binding, { eventId: 'accepted' });
  const engine = f.host.engine;
  const session = engine.session(f.binding);
  const node = engine.get(engine.resolve(item.ref, session).target, session);
  const key = useStateKey('owner', 'p', node.revisionId);
  const record = f.storage.metaGet(key);
  f.storage.metaSet(key, { ...record, updatedAt: accepted.acceptedAt + 1 });
  assert.throws(() => snapshotUse(engine, session, [node], accepted.acceptedAt), {
    code: 'STATE_INVALIDATED',
  });
  for (const invalid of [-1, NaN, Infinity, 1.5])
    assert.throws(() => snapshotUse(engine, session, [node], invalid), { code: 'INVALID_INPUT' });
  const ordinary = snapshotUse(engine, session, [node]);
  assert.ok(ordinary.at >= record.updatedAt + 1, 'ordinary monotonic clock behavior is preserved');
});

test('fixed activation time does not freeze real operation deadlines', async (t) => {
  const f = fixture();
  t.after(() => f.storage.close());
  const item = await create(f.memory, 'needle');
  const engine = f.host.engine;
  const session = engine.session(f.binding);
  const node = engine.get(engine.resolve(item.ref, session).target, session);
  session.ledger.limits.deadline = new Date(Date.now() - 1).toISOString();
  assert.throws(() => snapshotUse(engine, session, [node], 0), { code: 'BUDGET_EXHAUSTED' });
});
