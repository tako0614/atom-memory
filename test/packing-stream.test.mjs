import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, create, revise, retire } from './fixtures.mjs';
import { createPacking, pack } from '../dist/client/retrieval.js';

const budget = { maxCandidates: 1000, maxBytes: 1000000, maxAtoms: 30, maxContextTokens: 100000 };
test('incremental packing keeps shared quotations and required closures atomic at exact output limits', async () => {
  const f = fixture();
  const engine = f.host.engine,
    session = () => engine.session(f.binding, { budget });
  const source = await create(f.memory, 'AAAABBBBCCCC');
  const condition = await create(f.memory, 'Only after approval.');
  const writer = f.host.connect({
    ...f.binding,
    actor: { type: 'agent', generatedOrigin: 'extraction' },
  });
  const left = await create(
    writer,
    { text: 'AAAABBBB', links: { condition: { ref: condition.ref, required: true } } },
    { sources: [{ ref: source.ref, start: 0, end: 8 }] },
  );
  const right = await create(writer, 'BBBBCCCC', {
    sources: [{ ref: source.ref, start: 4, end: 12 }],
  });
  const candidates = [left, right, condition].map((x, i) => ({
    revision: engine.get(engine.resolve(x.ref, session()).target, session()),
    score: 1 / (i + 1),
  }));
  const reference = await pack(engine, session(), candidates, 100000, 10);
  for (const tokens of [reference.tokenCount, reference.tokenCount - 1, 0]) {
    const expected = await pack(engine, session(), candidates, tokens, 10);
    const out = createPacking(
      engine,
      session(),
      (id) => candidates.find((c) => c.revision.revisionId === id),
      tokens,
      10,
    );
    for (const c of candidates) out.offer(c);
    const actual = out.finish();
    assert.deepEqual(actual, expected);
    assert.ok(actual.tokenCount <= tokens);
    if (actual.items.some((i) => i.ref === left.ref))
      assert.ok(actual.items.some((i) => i.ref === condition.ref));
    assert.throws(() => out.offer(candidates[0]), { code: 'INVALID_INPUT' });
  }
  assert.equal((reference.text.match(/BBBB/g) ?? []).length, 1);
  const out = createPacking(engine, session(), () => undefined, 100000, 1);
  assert.equal(out.offer(candidates[0]), 'deferred');
  assert.equal(out.itemCount, 0, 'no half of a required bundle is emitted');
  assert.equal(out.offer(candidates[1]), 'selected');
  assert.equal(out.finish().items[0].ref, right.ref);
});

test('incremental packing rechecks authorization before final emission', async () => {
  const f = fixture(),
    source = await create(f.memory, 'private');
  const engine = f.host.engine,
    s = engine.session(f.binding, { budget });
  const c = { revision: engine.get(engine.resolve(source.ref, s).target, s), score: 1 };
  const out = createPacking(engine, s, () => c, 100000, 2);
  out.offer(c);
  f.authority.update(f.auth, { subject: 'owner', readPolicies: [], writePolicies: [] });
  assert.throws(() => out.finish(), { code: 'STATE_INVALIDATED' });
});
