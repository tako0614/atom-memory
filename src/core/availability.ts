import type { Json } from '../contracts.js';
import type { AdaptiveUseOptions, AdaptiveUseState, AvailabilityModel } from '../client/types.js';
import { canonical, fail } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_HALF_LIFE_MS = 7 * DAY_MS;
const DEFAULT_MAX_HALF_LIFE_MS = 365 * DAY_MS;
const MAX_MASS = 1_000_000;
export const MAX_AVAILABILITY_STATE_BYTES = 1024;

interface AdaptiveParameters {
  readonly initialHalfLifeMs: number;
  readonly maxHalfLifeMs: number;
}

const adaptiveModels = new WeakMap<object, AdaptiveParameters>();

function invalid(message: string): never {
  return fail('INVALID_INPUT', message);
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    invalid(`${label} must be finite and positive`);
  return value;
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    invalid(`${label} must be finite and nonnegative`);
  return value;
}

function ownOptions(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`Invalid ${label}`);
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid(`Invalid ${label}`);
  }
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)))
    invalid(`Unknown ${label} option`);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) invalid(`Invalid ${label}`);
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function dataProperty(value: object, key: PropertyKey): unknown {
  try {
    let current: object | null = value;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!('value' in descriptor)) invalid('Availability model properties must be data values');
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    invalid('Invalid availability model');
  }
  return undefined;
}

function cloneJson(value: unknown, seen: Set<object>, depth: number): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Availability state must be finite JSON');
    return value;
  }
  if (typeof value !== 'object') invalid('Availability state must be JSON');
  if (depth > MAX_AVAILABILITY_STATE_BYTES || seen.has(value))
    invalid('Availability state must be finite acyclic JSON');

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid('Invalid availability state');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalid('Availability state arrays must be plain');
      const length = dataProperty(value, 'length');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        invalid('Invalid availability state array');
      if (
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length),
        )
      )
        invalid('Availability state arrays cannot have extra properties');
      const output: Json[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          invalid('Availability state arrays cannot be sparse or use accessors');
        output.push(cloneJson(descriptor.value, seen, depth + 1));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null)
      invalid('Availability state objects must be plain');
    const output: Record<string, Json> = {};
    for (const key of keys) {
      if (typeof key !== 'string') invalid('Availability state keys must be strings');
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        invalid('Availability state properties must be enumerable data values');
      Object.defineProperty(output, key, {
        value: cloneJson(descriptor.value, seen, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze<T extends Json>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Clone untrusted callback state without invoking getters or `toJSON`. */
export function availabilityState(value: unknown): Json {
  const state = cloneJson(value, new Set(), 0);
  let encoded: string;
  try {
    encoded = canonical(state);
  } catch {
    return invalid('Availability state must be finite JSON');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_AVAILABILITY_STATE_BYTES)
    invalid(`Availability state exceeds ${MAX_AVAILABILITY_STATE_BYTES} UTF-8 bytes`);
  return deepFreeze(state);
}

function adaptiveState(value: unknown): AdaptiveUseState {
  const state = availabilityState(value);
  if (!state || typeof state !== 'object' || Array.isArray(state))
    invalid('Invalid adaptive-use state');
  if (
    Object.keys(state).length !== 3 ||
    !Object.hasOwn(state, 'mass') ||
    !Object.hasOwn(state, 'updatedAt') ||
    !Object.hasOwn(state, 'halfLifeMs')
  )
    invalid('Invalid adaptive-use state');
  const record = state as { readonly [key: string]: Json };
  const mass = record.mass;
  const updatedAt = record.updatedAt;
  const halfLifeMs = record.halfLifeMs;
  if (typeof mass !== 'number' || !Number.isFinite(mass) || mass < 0)
    invalid('Adaptive-use mass must be finite and nonnegative');
  finiteTime(updatedAt, 'Adaptive-use update time');
  finitePositive(halfLifeMs, 'Adaptive-use half-life');
  return state as AdaptiveUseState;
}

function freezeModel<S extends Json>(
  model: AvailabilityModel<S>,
  parameters?: AdaptiveParameters,
): AvailabilityModel<S> {
  const normalized: AvailabilityModel<S> = {
    id: model.id,
    update: model.update,
    value: model.value,
  };
  if (parameters) adaptiveModels.set(normalized, parameters);
  return Object.freeze(normalized);
}

/** Validate and snapshot a trusted synchronous model without hashing its functions. */
export function normalizeAvailabilityModel(value: unknown): AvailabilityModel {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    invalid('Invalid availability model');
  const id = dataProperty(value, 'id');
  const update = dataProperty(value, 'update');
  const modelValue = dataProperty(value, 'value');
  if (typeof id !== 'string' || !id.length || Buffer.byteLength(id, 'utf8') > 512)
    invalid('Invalid availability model id');
  if (typeof update !== 'function' || typeof modelValue !== 'function')
    invalid('Availability model needs synchronous update and value functions');
  const model: AvailabilityModel = {
    id,
    update: update as AvailabilityModel['update'],
    value: modelValue as AvailabilityModel['value'],
  };
  return freezeModel(model, adaptiveModels.get(value));
}

/** True only for a model produced by this module's `adaptiveUse` factory. */
export function isAdaptiveUse(model: AvailabilityModel): boolean {
  return adaptiveModels.has(model);
}

/**
 * Default O(1) availability model. Repeated use raises both current mass and
 * its half-life, while one stored triple remains sufficient for evaluation.
 */
export function adaptiveUse(options: AdaptiveUseOptions = {}): AvailabilityModel<AdaptiveUseState> {
  const parsed = ownOptions(options, ['initialHalfLifeMs', 'maxHalfLifeMs'], 'adaptive-use');
  const initialHalfLifeMs = finitePositive(
    parsed.initialHalfLifeMs ?? DEFAULT_INITIAL_HALF_LIFE_MS,
    'Initial half-life',
  );
  const maxHalfLifeMs = finitePositive(
    parsed.maxHalfLifeMs ?? DEFAULT_MAX_HALF_LIFE_MS,
    'Maximum half-life',
  );
  if (maxHalfLifeMs < initialHalfLifeMs)
    invalid('Maximum half-life must be at least the initial half-life');
  const parameters = Object.freeze({ initialHalfLifeMs, maxHalfLifeMs });
  const id = `adaptive-use-v1:${canonical(parameters)}`;
  const model: AvailabilityModel<AdaptiveUseState> = {
    id,
    update(previous, acceptedAt) {
      const at = finiteTime(acceptedAt, 'Accepted time');
      if (previous === undefined)
        return Object.freeze({ mass: 1, updatedAt: at, halfLifeMs: initialHalfLifeMs });
      const state = adaptiveState(previous);
      if (at < state.updatedAt) invalid('Accepted time must be monotone');
      const retained = 2 ** (-(at - state.updatedAt) / state.halfLifeMs);
      const mass = Math.min(MAX_MASS, state.mass * retained + 1);
      const halfLifeMs =
        state.halfLifeMs > maxHalfLifeMs
          ? state.halfLifeMs
          : Math.min(maxHalfLifeMs, state.halfLifeMs + initialHalfLifeMs * (1 - retained));
      if (!Number.isFinite(mass) || mass < 0 || !Number.isFinite(halfLifeMs))
        invalid('Invalid adaptive-use arithmetic');
      return Object.freeze({ mass, updatedAt: at, halfLifeMs });
    },
    value(state, now) {
      const at = finiteTime(now, 'Evaluation time');
      if (state === undefined) return 0;
      const parsedState = adaptiveState(state);
      const value =
        parsedState.mass * 2 ** (-Math.max(0, at - parsedState.updatedAt) / parsedState.halfLifeMs);
      if (!Number.isFinite(value) || value < 0) invalid('Invalid adaptive-use value');
      return value;
    },
  };
  adaptiveModels.set(model, parameters);
  return Object.freeze(model);
}

/** Invoke an update as a synchronous, bounded, mutation-isolated transaction step. */
export function updateAvailability(
  model: AvailabilityModel,
  previous: Json | undefined,
  acceptedAt: number,
): Json {
  const input = previous === undefined ? undefined : availabilityState(previous);
  let output: unknown;
  try {
    output = Reflect.apply(model.update, undefined, [input, acceptedAt]);
  } catch {
    return invalid('Availability model update failed');
  }
  return availabilityState(output);
}

/** Invoke a value function as a synchronous, bounded, mutation-isolated step. */
export function valueAvailability(
  model: AvailabilityModel,
  state: Json | undefined,
  now: number,
): number {
  const input = state === undefined ? undefined : availabilityState(state);
  let output: unknown;
  try {
    output = Reflect.apply(model.value, undefined, [input, now]);
  } catch {
    return invalid('Availability model value failed');
  }
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0)
    invalid('Availability model value must be finite and nonnegative');
  return output;
}
