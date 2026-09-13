import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveUse } from '../dist/index.js';
import {
  availabilityState,
  normalizeAvailabilityModel,
  updateAvailability,
  valueAvailability,
} from '../dist/core/availability.js';

const DAY = 24 * 60 * 60 * 1000;

test('adaptiveUse has deterministic parameter identity and validates its bounds', () => {
  const defaults = adaptiveUse();
  assert.equal(
    defaults.id,
    'adaptive-use-v1:{"initialHalfLifeMs":604800000,"maxHalfLifeMs":31536000000}',
  );
  assert.equal(defaults.id, adaptiveUse({}).id);
  assert.equal(
    adaptiveUse({ initialHalfLifeMs: DAY, maxHalfLifeMs: 10 * DAY }).id,
    adaptiveUse({ maxHalfLifeMs: 10 * DAY, initialHalfLifeMs: DAY }).id,
  );
  assert.notEqual(defaults.id, adaptiveUse({ initialHalfLifeMs: 8 * DAY }).id);
  for (const options of [
    { initialHalfLifeMs: 0 },
    { initialHalfLifeMs: Infinity },
    { maxHalfLifeMs: NaN },
    { initialHalfLifeMs: 2, maxHalfLifeMs: 1 },
    { halfLifeMs: DAY },
  ])
    assert.throws(() => adaptiveUse(options), { code: 'INVALID_INPUT' });
});

test('adaptiveUse updates one bounded O(1) triple and evaluates exponential availability', () => {
  const model = adaptiveUse({ initialHalfLifeMs: 7 * DAY, maxHalfLifeMs: 365 * DAY });
  const first = model.update(undefined, 0);
  assert.deepEqual(first, { mass: 1, updatedAt: 0, halfLifeMs: 7 * DAY });
  assert.equal(model.value(undefined, 100 * DAY), 0);
  assert.equal(model.value(first, 0), 1);
  assert.equal(model.value(first, 7 * DAY), 0.5);

  const second = model.update(first, 7 * DAY);
  assert.deepEqual(second, { mass: 1.5, updatedAt: 7 * DAY, halfLifeMs: 10.5 * DAY });
  assert.equal(model.value(second, 0), second.mass, 'wall-clock rollback does not add decay');

  const capped = model.update({ mass: 2_000_000, updatedAt: 10, halfLifeMs: 400 * DAY }, 10);
  assert.equal(capped.mass, 1_000_000);
  assert.equal(capped.halfLifeMs, 400 * DAY, 'a legacy half-life above max is never shortened');
  assert.throws(() => model.update(first, -1), { code: 'INVALID_INPUT' });
  assert.throws(() => model.update(second, 0), { code: 'INVALID_INPUT' });
});

test('distributed uses retain more long-term availability than a same-count terminal burst', () => {
  const model = adaptiveUse();
  const run = (events) => events.reduce((state, at) => model.update(state, at), undefined);
  const burst = run([0, 21 * DAY, 21 * DAY, 21 * DAY]);
  const distributed = run([0, 7 * DAY, 14 * DAY, 21 * DAY]);
  assert.ok(model.value(distributed, 111 * DAY) > model.value(burst, 111 * DAY));
});

test('custom model state is cloned, deeply frozen, bounded JSON', () => {
  let updateInput;
  let valueInput;
  const model = normalizeAvailabilityModel({
    id: 'custom-use-v1',
    update(previous) {
      updateInput = previous;
      if (previous) {
        assert.ok(Object.isFrozen(previous));
        assert.ok(Object.isFrozen(previous.nested));
      }
      return { uses: (previous?.uses ?? 0) + 1, nested: ['safe'] };
    },
    value(state) {
      valueInput = state;
      assert.ok(Object.isFrozen(state));
      assert.ok(Object.isFrozen(state.nested));
      return state.uses;
    },
  });
  const first = updateAvailability(model, undefined, 1);
  const second = updateAvailability(model, first, 2);
  assert.notEqual(updateInput, first);
  assert.deepEqual(second, { uses: 2, nested: ['safe'] });
  assert.equal(valueAvailability(model, second, 3), 2);
  assert.notEqual(valueInput, second);
  assert.ok(Object.isFrozen(second));

  const original = { nested: { value: 1 } };
  const cloned = availabilityState(original);
  original.nested.value = 2;
  assert.equal(cloned.nested.value, 1);
});

test('callback exceptions, async results, invalid scalars and hostile JSON fail closed', () => {
  const model = (update, value = () => 0) =>
    normalizeAvailabilityModel({ id: 'bad-custom-v1', update, value });
  for (const update of [
    () => {
      throw new Error('boom');
    },
    async () => ({ ok: true }),
    () => ({ value: Infinity }),
    () => ({ value: undefined }),
    () => ({ data: 'x'.repeat(1025) }),
    () => {
      const cyclic = {};
      cyclic.self = cyclic;
      return cyclic;
    },
  ])
    assert.throws(() => updateAvailability(model(update), undefined, 0), {
      code: 'INVALID_INPUT',
    });

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'secret', {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  assert.throws(
    () =>
      updateAvailability(
        model(() => hostile),
        undefined,
        0,
      ),
    {
      code: 'INVALID_INPUT',
    },
  );
  assert.equal(getterCalls, 0);

  let toJSONCalls = 0;
  assert.throws(
    () =>
      updateAvailability(
        model(() => ({
          toJSON() {
            toJSONCalls++;
            return {};
          },
        })),
        undefined,
        0,
      ),
    { code: 'INVALID_INPUT' },
  );
  assert.equal(toJSONCalls, 0);

  for (const value of [
    () => {
      throw new Error('boom');
    },
    async () => 1,
    () => -1,
    () => Infinity,
    () => '1',
  ])
    assert.throws(
      () =>
        valueAvailability(
          model(() => ({}), value),
          {},
          0,
        ),
      { code: 'INVALID_INPUT' },
    );
});

test('model normalization trusts stable id identity and never source-hashes functions', () => {
  const a = normalizeAvailabilityModel({
    id: 'identity-v1',
    update: () => ({ implementation: 'a' }),
    value: () => 1,
  });
  const b = normalizeAvailabilityModel({
    id: 'identity-v1',
    update: () => ({ implementation: 'b' }),
    value: () => 2,
  });
  assert.equal(a.id, b.id);
  assert.notEqual(a.update, b.update);
  for (const invalid of [
    {},
    { id: '', update() {}, value() {} },
    { id: 'x', update: 1, value() {} },
    { id: 'x', update() {}, value: 1 },
  ])
    assert.throws(() => normalizeAvailabilityModel(invalid), { code: 'INVALID_INPUT' });
});
