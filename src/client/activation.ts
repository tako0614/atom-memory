import type { AtomRevision } from '../contracts.js';
import type { ClientBinding, AtomRef, UseResult } from './types.js';
import type { Session, Engine, RefEntry } from './engine.js';
import type { Principal } from '../core/authority.js';
import { activationOptions } from '../core/ranking.js';
import { canonical, fail, validId } from '../core/util.js';
import {
  deleteUseState,
  getUseEvent,
  getUseState,
  putUseEvent,
  putUseState,
  type UseEventRecord,
  type UseStateRecord,
  useScopePrefix,
} from '../core/use-state.js';

function stateRecord(value: unknown): UseStateRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') fail('STATE_INVALIDATED');
  const state = value as Partial<UseStateRecord>;
  const halfLifeMs = state.halfLifeMs;
  const updatedAt = state.updatedAt;
  const h = state.h;
  if (
    typeof state.subject !== 'string' ||
    typeof state.policy !== 'string' ||
    typeof state.revisionId !== 'string' ||
    typeof halfLifeMs !== 'number' ||
    !Number.isFinite(halfLifeMs) ||
    halfLifeMs <= 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    typeof h !== 'number' ||
    !Number.isFinite(h) ||
    h < 0
  )
    fail('STATE_INVALIDATED');
  return state as UseStateRecord;
}

function eventRecord(value: unknown): UseEventRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') fail('STATE_INVALIDATED');
  const event = value as Partial<UseEventRecord>;
  const acceptedAt = event.acceptedAt;
  if (
    typeof event.subject !== 'string' ||
    typeof event.policy !== 'string' ||
    typeof event.revisionId !== 'string' ||
    typeof event.eventId !== 'string' ||
    typeof acceptedAt !== 'number' ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt < 0
  )
    fail('STATE_INVALIDATED');
  return event as UseEventRecord;
}

function checkHalfLife(state: UseStateRecord | undefined, halfLifeMs: number): void {
  if (state && state.halfLifeMs !== halfLifeMs) {
    fail('STATE_INVALIDATED', 'Activation half-life changed; resetUse is required');
  }
}

function checkStateScope(
  state: UseStateRecord | undefined,
  subject: string,
  policy: string,
  revisionId: string,
): void {
  if (
    state &&
    (state.subject !== subject || state.policy !== policy || state.revisionId !== revisionId)
  )
    fail('STATE_INVALIDATED');
}

function decay(state: UseStateRecord | undefined, at: number, halfLifeMs: number): number {
  if (!state) return 0;
  checkHalfLife(state, halfLifeMs);
  const elapsed = Math.max(0, at - state.updatedAt);
  const value = state.h * 2 ** (-elapsed / halfLifeMs);
  if (!Number.isFinite(value) || value < 0) fail('STATE_INVALIDATED');
  return value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512;
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
    !validIdentifier(entry.subject) ||
    !validIdentifier(entry.policy) ||
    !entry.target ||
    entry.target.kind !== 'pinned' ||
    !validIdentifier(entry.target.atomId) ||
    !validIdentifier(entry.target.revisionId)
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
  const result = engine.storage.transaction(() => {
    const config = activationOptions(engine.options.activation);
    const acceptedAt = Date.now();
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
    let recorded = 0;
    let repeated = 0;
    for (const target of unique.values()) {
      engine.check(session);
      const current = stateRecord(
        getUseState(engine.storage, target.subject, target.policy, target.revision.revisionId),
      );
      checkStateScope(current, target.subject, target.policy, target.revision.revisionId);
      checkHalfLife(current, config.halfLifeMs);
      const marker = eventRecord(
        getUseEvent(
          engine.storage,
          target.subject,
          target.policy,
          target.revision.revisionId,
          eventId,
        ),
      );
      if (marker) {
        if (
          marker.subject !== target.subject ||
          marker.policy !== target.policy ||
          marker.revisionId !== target.revision.revisionId ||
          marker.eventId !== eventId
        )
          fail('STATE_INVALIDATED');
        repeated++;
        continue;
      }
      const updatedAt = Math.max(acceptedAt, current?.updatedAt ?? acceptedAt);
      const h = decay(current, updatedAt, config.halfLifeMs) + 1;
      if (!Number.isFinite(h)) fail('LIMIT_EXCEEDED');
      const next: UseStateRecord = {
        subject: target.subject,
        policy: target.policy,
        revisionId: target.revision.revisionId,
        halfLifeMs: config.halfLifeMs,
        updatedAt,
        h,
      };
      putUseState(engine.storage, next);
      putUseEvent(engine.storage, {
        subject: target.subject,
        policy: target.policy,
        revisionId: target.revision.revisionId,
        eventId,
        acceptedAt,
      });
      // Charge actual metadata written/read, keeping use recording within the
      // same operation budget and making large hostile batches fail atomically.
      session.ledger.charge({
        maxBytes:
          Buffer.byteLength(canonical(next)) +
          Buffer.byteLength(
            canonical({
              subject: target.subject,
              policy: target.policy,
              revisionId: target.revision.revisionId,
              eventId,
              acceptedAt,
            }),
          ),
      });
      recorded++;
    }
    return { acceptedAt, recorded, repeated };
  });
  return result;
}

/** Clear only the caller's scoped activation aggregates; event deduplication remains. */
export function resetUse(engine: Engine, binding: ClientBinding): void {
  const session = engine.session(binding);
  const policies = engine.policies(binding, session.principal);
  engine.storage.transaction(() => {
    engine.check(session);
    for (const policy of policies) {
      for (const [, raw] of engine.storage.metaEntries<UseStateRecord>(
        useScopePrefix(session.principal.subject, policy),
      )) {
        const state = stateRecord(raw);
        if (!state || state.subject !== session.principal.subject || state.policy !== policy)
          continue;
        deleteUseState(engine.storage, state);
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
  const snapshot = engine.storage.transaction(() => {
    const config = activationOptions(engine.options.activation);
    const at = Date.now();
    engine.check(s);
    const boosts = nodes.map((node) => {
      engine.check(s);
      if (!node || typeof node !== 'object') fail('INVALID_SCHEMA');
      if (!policies.includes(node.policyId) || !s.principal.readPolicies.includes(node.policyId))
        fail('ACCESS_DENIED');
      if (engine.storage.isPurged(node.atomId)) fail('ACCESS_DENIED');
      const current = stateRecord(
        getUseState(engine.storage, s.principal.subject, node.policyId, node.revisionId),
      );
      checkStateScope(current, s.principal.subject, node.policyId, node.revisionId);
      checkHalfLife(current, config.halfLifeMs);
      const metadataBytes = Buffer.byteLength(canonical(current ?? null));
      s.ledger.charge({ maxBytes: metadataBytes });
      const h = decay(current, at, config.halfLifeMs);
      return 1 + config.maxBoost * (h / (1 + h));
    });
    return { at, boosts };
  });
  return snapshot;
}
