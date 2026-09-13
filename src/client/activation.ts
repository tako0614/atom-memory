import type { AtomRevision, Json } from '../contracts.js';
import type { AvailabilityModel, ClientBinding, AtomRef, UseResult } from './types.js';
import type { Session, Engine, RefEntry } from './engine.js';
import type { Principal } from '../core/authority.js';
import { activationOptions } from '../core/ranking.js';
import {
  availabilityState,
  isAdaptiveUse,
  updateAvailability,
  valueAvailability,
} from '../core/availability.js';
import { canonical, fail, validId } from '../core/util.js';
import {
  deleteUseState,
  getUseEvent,
  getUseState,
  putUseEvent,
  putUseState,
  USE_STATE_FORMAT,
  type LegacyUseStateRecord,
  type UseEventRecord,
  type UseStateRecord,
  useScopePrefix,
} from '../core/use-state.js';

type StoredUseState =
  | { readonly kind: 'current'; readonly record: UseStateRecord }
  | { readonly kind: 'legacy'; readonly record: LegacyUseStateRecord };

function invalidState(message = 'Invalid use state'): never {
  return fail('STATE_INVALIDATED', message);
}

/** Copy a metadata record without invoking accessors or `toJSON`. */
function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidState();
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalidState();
  }
  if (prototype !== Object.prototype && prototype !== null) invalidState();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') invalidState();
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidState();
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stateRecord(value: unknown): StoredUseState | undefined {
  if (value === undefined) return undefined;
  const state = dataRecord(value);
  if (Object.hasOwn(state, 'format')) {
    if (
      state.format !== USE_STATE_FORMAT ||
      Reflect.ownKeys(state).some(
        (key) =>
          typeof key !== 'string' ||
          !['format', 'subject', 'policy', 'revisionId', 'modelId', 'state', 'updatedAt'].includes(
            key,
          ),
      ) ||
      !identifier(state.subject) ||
      !identifier(state.policy) ||
      !identifier(state.revisionId) ||
      !identifier(state.modelId) ||
      !Object.hasOwn(state, 'state') ||
      !timestamp(state.updatedAt)
    )
      invalidState();
    return { kind: 'current', record: state as unknown as UseStateRecord };
  }
  if (
    Reflect.ownKeys(state).some(
      (key) =>
        typeof key !== 'string' ||
        !['subject', 'policy', 'revisionId', 'halfLifeMs', 'updatedAt', 'h'].includes(key),
    ) ||
    !identifier(state.subject) ||
    !identifier(state.policy) ||
    !identifier(state.revisionId) ||
    typeof state.halfLifeMs !== 'number' ||
    !Number.isFinite(state.halfLifeMs) ||
    state.halfLifeMs <= 0 ||
    !timestamp(state.updatedAt) ||
    typeof state.h !== 'number' ||
    !Number.isFinite(state.h) ||
    state.h < 0
  )
    invalidState();
  return { kind: 'legacy', record: state as unknown as LegacyUseStateRecord };
}

function eventRecord(value: unknown): UseEventRecord | undefined {
  if (value === undefined) return undefined;
  const event = dataRecord(value);
  if (
    Reflect.ownKeys(event).some(
      (key) =>
        typeof key !== 'string' ||
        !['subject', 'policy', 'revisionId', 'eventId', 'acceptedAt'].includes(key),
    ) ||
    !identifier(event.subject) ||
    !identifier(event.policy) ||
    !identifier(event.revisionId) ||
    !identifier(event.eventId) ||
    !timestamp(event.acceptedAt)
  )
    invalidState();
  return event as unknown as UseEventRecord;
}

function checkStateScope(
  state: StoredUseState | undefined,
  subject: string,
  policy: string,
  revisionId: string,
): void {
  if (
    state &&
    (state.record.subject !== subject ||
      state.record.policy !== policy ||
      state.record.revisionId !== revisionId)
  )
    invalidState();
}

function checkModel(state: StoredUseState | undefined, model: AvailabilityModel): void {
  if (!state) return;
  if (state.kind === 'current') {
    if (state.record.modelId !== model.id)
      invalidState('Availability model changed; resetUse is required');
  } else if (!isAdaptiveUse(model)) {
    invalidState('Legacy use state requires adaptiveUse; resetUse is required');
  }
}

function previousState(state: StoredUseState | undefined): Json | undefined {
  if (!state) return undefined;
  if (state.kind === 'current') return availabilityState(state.record.state);
  return availabilityState({
    mass: state.record.h,
    updatedAt: state.record.updatedAt,
    halfLifeMs: state.record.halfLifeMs,
  });
}

function stateUpdatedAt(state: StoredUseState | undefined): number | undefined {
  return state?.record.updatedAt;
}

function recordEntry(
  engine: Engine,
  ref: AtomRef,
  subject: string,
  principal: Principal,
  policies: readonly string[],
  at: number,
): { subject: string; policy: string; revision: AtomRevision } {
  if (typeof ref !== 'string') fail('INVALID_REF');
  const entry = engine.storage.metaGet<RefEntry>(`sdk:ref:${ref}`);
  if (
    !entry ||
    !identifier(entry.subject) ||
    !identifier(entry.policy) ||
    !entry.target ||
    entry.target.kind !== 'pinned' ||
    !identifier(entry.target.atomId) ||
    !identifier(entry.target.revisionId)
  )
    fail('INVALID_REF');
  if (entry.overlay) fail('INVALID_REF', 'Tentative references cannot record use');
  if (
    entry.subject !== subject ||
    !policies.includes(entry.policy) ||
    !principal.readPolicies.includes(entry.policy)
  )
    fail('ACCESS_DENIED');
  if (engine.storage.isPurged(entry.target.atomId)) fail('ACCESS_DENIED');
  const revision = engine.storage.get(entry.target, at);
  if (
    !revision ||
    revision.atomId !== entry.target.atomId ||
    revision.revisionId !== entry.target.revisionId
  )
    fail('REFERENCE_UNAVAILABLE');
  if (revision.policyId !== entry.policy) fail('ACCESS_DENIED');
  return { subject, policy: revision.policyId, revision };
}

/** Record one host-accepted use event for the caller's scoped revisions. */
export function recordUse(
  engine: Engine,
  refs: readonly AtomRef[],
  binding: ClientBinding,
  eventId: string,
): UseResult {
  if (!Array.isArray(refs)) fail('INVALID_INPUT');
  if (refs.length > engine.kernel.limits.maxBatch) fail('LIMIT_EXCEEDED');
  validId(eventId);
  const session = engine.session(binding);
  const principal = session.principal;
  const policies = engine.policies(binding, principal);
  return engine.storage.transaction(() => {
    const config = activationOptions(engine.options.activation);
    const observedAt = Date.now();
    if (!timestamp(observedAt)) fail('INVALID_INPUT', 'Invalid accepted-use time');
    engine.check(session);
    const unique = new Map<string, { subject: string; policy: string; revision: AtomRevision }>();
    for (const ref of refs) {
      const target = recordEntry(
        engine,
        ref,
        principal.subject,
        principal,
        policies,
        engine.storage.watermark(),
      );
      unique.set(`${target.policy}\u0000${target.revision.revisionId}`, target);
    }
    let acceptedAt = observedAt;
    const entries = [...unique.values()].map((target) => {
      engine.check(session);
      const current = stateRecord(
        getUseState(engine.storage, target.subject, target.policy, target.revision.revisionId),
      );
      checkStateScope(current, target.subject, target.policy, target.revision.revisionId);
      checkModel(current, config.model);
      acceptedAt = Math.max(acceptedAt, stateUpdatedAt(current) ?? acceptedAt);
      const marker = eventRecord(
        getUseEvent(
          engine.storage,
          target.subject,
          target.policy,
          target.revision.revisionId,
          eventId,
        ),
      );
      if (
        marker &&
        (marker.subject !== target.subject ||
          marker.policy !== target.policy ||
          marker.revisionId !== target.revision.revisionId ||
          marker.eventId !== eventId)
      )
        invalidState();
      return { target, current, marker };
    });
    let recorded = 0;
    let repeated = 0;
    for (const { target, current, marker } of entries) {
      engine.check(session);
      if (marker) {
        repeated++;
        continue;
      }
      session.ledger.charge({ maxEvaluationWork: 1 });
      const state = updateAvailability(config.model, previousState(current), acceptedAt);
      const next: UseStateRecord = {
        format: USE_STATE_FORMAT,
        subject: target.subject,
        policy: target.policy,
        revisionId: target.revision.revisionId,
        modelId: config.model.id,
        state,
        updatedAt: acceptedAt,
      };
      const event: UseEventRecord = {
        subject: target.subject,
        policy: target.policy,
        revisionId: target.revision.revisionId,
        eventId,
        acceptedAt,
      };
      putUseState(engine.storage, next);
      putUseEvent(engine.storage, event);
      // Charge actual bounded metadata output. A late failure rolls back every
      // durable state and marker write in this batch.
      session.ledger.charge({
        maxBytes: Buffer.byteLength(canonical(next)) + Buffer.byteLength(canonical(event)),
      });
      recorded++;
    }
    return { acceptedAt, recorded, repeated };
  });
}

/** Clear only the caller's scoped activation aggregates; event deduplication remains. */
export function resetUse(engine: Engine, binding: ClientBinding): void {
  const session = engine.session(binding);
  const policies = engine.policies(binding, session.principal);
  engine.storage.transaction(() => {
    engine.check(session);
    for (const policy of policies) {
      for (const [, raw] of engine.storage.metaEntries<unknown>(
        useScopePrefix(session.principal.subject, policy),
      )) {
        const state = stateRecord(raw);
        if (
          !state ||
          state.record.subject !== session.principal.subject ||
          state.record.policy !== policy
        )
          continue;
        deleteUseState(engine.storage, state.record);
      }
    }
  });
}

/**
 * Snapshot finite, already-acquired revisions at one wall-clock instant. The
 * returned boosts are aligned with `nodes`; no history or corpus scan occurs.
 */
export function snapshotUse(
  engine: Engine,
  s: Session,
  nodes: readonly AtomRevision[],
): { at: number; boosts: number[] } {
  if (!Array.isArray(nodes)) fail('INVALID_INPUT');
  const policies = engine.policies(s.binding, s.principal);
  return engine.storage.transaction(() => {
    const config = activationOptions(engine.options.activation);
    const observedAt = Date.now();
    if (!timestamp(observedAt)) fail('INVALID_INPUT', 'Invalid availability evaluation time');
    engine.check(s);
    let at = observedAt;
    const entries = nodes.map((node) => {
      engine.check(s);
      if (!node || typeof node !== 'object') fail('INVALID_SCHEMA');
      if (!policies.includes(node.policyId) || !s.principal.readPolicies.includes(node.policyId))
        fail('ACCESS_DENIED');
      if (engine.storage.isPurged(node.atomId)) fail('ACCESS_DENIED');
      const current = stateRecord(
        getUseState(engine.storage, s.principal.subject, node.policyId, node.revisionId),
      );
      checkStateScope(current, s.principal.subject, node.policyId, node.revisionId);
      checkModel(current, config.model);
      const state = previousState(current);
      at = Math.max(at, stateUpdatedAt(current) ?? at);
      const metadataBytes = Buffer.byteLength(
        canonical(current === undefined ? null : current.record),
      );
      s.ledger.charge({ maxBytes: metadataBytes });
      return state;
    });
    const boosts = entries.map((state) => {
      engine.check(s);
      s.ledger.charge({ maxEvaluationWork: 1 });
      const availability = valueAvailability(config.model, state, at);
      const boost = 1 + config.maxBoost * (availability / (1 + availability));
      if (!Number.isFinite(boost) || boost < 0) fail('INVALID_INPUT', 'Invalid availability boost');
      return boost;
    });
    return { at, boosts };
  });
}
