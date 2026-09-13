import type { AtomRevision, Json } from '../contracts.js';
import type { StorageAdapter } from '../adapters/storage.js';
import { canonical, digest } from './util.js';

/** Durable metadata for one scoped revision's accepted uses. */
export interface UseStateRecord {
  readonly format: typeof USE_STATE_FORMAT;
  readonly subject: string;
  readonly policy: string;
  readonly revisionId: string;
  readonly modelId: string;
  readonly state: Json;
  /** Host-owned last accepted transition time, independent of custom state. */
  readonly updatedAt: number;
}

/** Published v0.6 fixed-decay aggregate, decoded lazily by adaptiveUse only. */
export interface LegacyUseStateRecord {
  readonly subject: string;
  readonly policy: string;
  readonly revisionId: string;
  readonly halfLifeMs: number;
  readonly updatedAt: number;
  readonly h: number;
}

/** Durable metadata for one accepted event/revision pair. */
export interface UseEventRecord {
  readonly subject: string;
  readonly policy: string;
  readonly revisionId: string;
  readonly eventId: string;
  readonly acceptedAt: number;
}

interface UseIndexRecord {
  readonly kind: 'state' | 'event';
  readonly key: string;
}

/** Prefixes are deliberately private to the host metadata namespace. */
export const USE_STATE_PREFIX = 'sdk:use:state:';
export const USE_EVENT_PREFIX = 'sdk:use:event:';
export const USE_INDEX_PREFIX = 'sdk:use:index:';
export const USE_STATE_FORMAT = 'atom-memory/use-state/v1' as const;

const scopeDigest = (subject: string, policy: string): string =>
  digest(canonical([subject, policy]));
const revisionDigest = (revisionId: string): string => digest(revisionId);

export function useStateKey(subject: string, policy: string, revisionId: string): string {
  return `${USE_STATE_PREFIX}${scopeDigest(subject, policy)}:${revisionDigest(revisionId)}`;
}

export function useEventKey(
  subject: string,
  policy: string,
  revisionId: string,
  eventId: string,
): string {
  return `${USE_EVENT_PREFIX}${digest(canonical([subject, policy, revisionId, eventId]))}`;
}

export function useScopePrefix(subject: string, policy: string): string {
  return `${USE_STATE_PREFIX}${scopeDigest(subject, policy)}:`;
}

function useIndexKey(revisionId: string, kind: UseIndexRecord['kind'], key: string): string {
  return `${USE_INDEX_PREFIX}${revisionDigest(revisionId)}:${kind}:${digest(key)}`;
}

export function useStateIndexKey(revisionId: string, key: string): string {
  return useIndexKey(revisionId, 'state', key);
}

export function useEventIndexKey(revisionId: string, key: string): string {
  return useIndexKey(revisionId, 'event', key);
}

export function putUseState(storage: StorageAdapter, state: UseStateRecord): void {
  const key = useStateKey(state.subject, state.policy, state.revisionId);
  storage.metaSet(key, state);
  storage.metaSet(useStateIndexKey(state.revisionId, key), {
    kind: 'state',
    key,
  } satisfies UseIndexRecord);
}

export function putUseEvent(storage: StorageAdapter, event: UseEventRecord): void {
  const key = useEventKey(event.subject, event.policy, event.revisionId, event.eventId);
  storage.metaSet(key, event);
  storage.metaSet(useEventIndexKey(event.revisionId, key), {
    kind: 'event',
    key,
  } satisfies UseIndexRecord);
}

export function getUseState(
  storage: StorageAdapter,
  subject: string,
  policy: string,
  revisionId: string,
): UseStateRecord | undefined {
  return storage.metaGet<UseStateRecord>(useStateKey(subject, policy, revisionId));
}

export function getUseEvent(
  storage: StorageAdapter,
  subject: string,
  policy: string,
  revisionId: string,
  eventId: string,
): UseEventRecord | undefined {
  return storage.metaGet<UseEventRecord>(useEventKey(subject, policy, revisionId, eventId));
}

export function deleteUseState(
  storage: StorageAdapter,
  state: Pick<UseStateRecord, 'subject' | 'policy' | 'revisionId'>,
): void {
  const key = useStateKey(state.subject, state.policy, state.revisionId);
  storage.metaDelete(key);
  storage.metaDelete(useStateIndexKey(state.revisionId, key));
}

/**
 * Remove every use aggregate, reverse-index entry, and event marker associated
 * with the supplied revisions. The caller must invoke this inside its existing
 * purge transaction so atom and use metadata commit together.
 */
export function purgeUse(
  storage: StorageAdapter,
  revisions: readonly Pick<AtomRevision, 'revisionId'>[],
): void {
  const seen = new Set<string>();
  for (const revision of revisions) {
    if (seen.has(revision.revisionId)) continue;
    seen.add(revision.revisionId);
    const prefix = `${USE_INDEX_PREFIX}${revisionDigest(revision.revisionId)}:`;
    for (const [indexKey, value] of storage.metaEntries<UseIndexRecord>(prefix)) {
      if (value && typeof value.key === 'string') storage.metaDelete(value.key);
      storage.metaDelete(indexKey);
    }
  }
}
