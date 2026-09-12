import type { AtomRevision } from '../contracts.js';
import type { ChangePosition } from '../adapters/storage.js';
import type { ClientBinding, OperationOptions } from './types.js';
import type { Engine, Session } from './engine.js';
import { canonical, digest, fail } from '../core/util.js';

export async function indexRevision(engine: Engine, r: AtomRevision, s: Session): Promise<number> {
  engine.get({ kind: 'pinned', atomId: r.atomId, revisionId: r.revisionId }, s);
  const text = engine.representation(r, s);
  const key = `sdk:index:${r.revisionId}`;
  const old = engine.storage.metaGet<{
    config: string;
    hash: string;
    policyId?: string;
    vectors?: number[][];
  }>(key);
  if (
    old?.config === engine.legacyConfig &&
    old.hash === digest(text) &&
    old.policyId === r.policyId &&
    old.vectors
  ) {
    engine.storage.transaction(() => {
      engine.check(s);
      engine.storage.metaSet(key, { ...old, config: engine.indexConfig });
      engine.storage.metaSet(
        'sdk:index-generation',
        (engine.storage.metaGet<number>('sdk:index-generation') ?? 0) + 1,
      );
    });
    return 0;
  }
  if (
    old?.config === engine.indexConfig &&
    old.hash === digest(text) &&
    old.policyId === r.policyId
  )
    return 0;
  const vectors = await engine.embed([text], s, 'document');
  engine.check(s);
  engine.storage.transaction(() => {
    engine.check(s);
    engine.storage.metaSet(key, {
      config: engine.indexConfig,
      hash: digest(text),
      vectors,
      policyId: r.policyId,
    });
    engine.storage.metaSet(
      'sdk:index-generation',
      (engine.storage.metaGet<number>('sdk:index-generation') ?? 0) + 1,
    );
  });
  return 1;
}

interface Progress {
  after: ChangePosition;
  event?: { atomId: string; position: ChangePosition; indexed: boolean; dependentAfter?: string };
}
/** A durable consumer of committed revisions, independent of model transactions.
 * A failed encoder leaves the event pending; a restart never requires a full scan.
 * Direct logical dependents are refreshed because representations include their
 * direct targets. External membership does not recursively rewrite every parent. */
export async function updateIndex(
  engine: Engine,
  binding: ClientBinding,
  options: OperationOptions = {},
) {
  if (!engine.embedding) fail('INDEX_NOT_READY', 'No embedding provider is configured');
  if (options.cursor) fail('INVALID_INPUT', 'updateIndex uses a durable per-scope checkpoint');
  if (!engine.storage.changes)
    fail('INDEX_NOT_READY', 'This adapter does not provide a revision feed');
  const limit = options.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('INVALID_INPUT');
  const s = engine.session(binding, options);
  const migration = migrateIndex(engine, s, limit);
  if (migration.pending) return { indexed: 0, processed: migration.processed, pending: true };
  let processed = migration.processed,
    indexed = 0,
    pending = false;
  for (const policy of s.trace.policies) {
    const key = `sdk:index-progress:${digest(canonical([engine.indexConfig, policy, s.trace.policies]))}`;
    const save = (before: Progress | undefined, next: Progress) =>
      engine.storage.transaction(() => {
        engine.check(s);
        if (canonical(engine.storage.metaGet(key) ?? null) !== canonical(before ?? null))
          fail('REVISION_CONFLICT', 'Another index worker advanced this scope');
        engine.storage.metaSet(key, next);
      });
    for (;;) {
      const before = engine.storage.metaGet<Progress>(key);
      const state: Progress = structuredClone(before ?? { after: { sequence: 0, revisionId: '' } });
      if (!state.event) {
        s.ledger.charge({ maxCandidates: 1 });
        const changed = engine.storage.changes([policy], state.after, 1, s.at)[0];
        if (!changed) break;
        state.event = {
          atomId: changed.revision.atomId,
          position: { sequence: changed.sequence, revisionId: changed.revision.revisionId },
          indexed: false,
        };
      }
      if (processed >= limit) {
        pending = true;
        break;
      }
      const event = state.event;
      if (!event.indexed) {
        const head = engine.storage.get({ kind: 'logical', atomId: event.atomId }, s.at);
        if (head?.state === 'active') indexed += await indexRevision(engine, head, s);
        event.indexed = true;
      } else {
        const dependent = engine.scan(
          {
            policies: [...s.trace.policies],
            relation: { target: { kind: 'logical', atomId: event.atomId } },
            after: event.dependentAfter,
            limit: 1,
          },
          s,
        )[0];
        if (!dependent) {
          state.after = event.position;
          delete state.event;
        } else {
          if (
            dependent.slots.some(
              (slot) => slot.target.kind === 'logical' && slot.target.atomId === event.atomId,
            )
          )
            indexed += await indexRevision(engine, dependent, s);
          event.dependentAfter = dependent.atomId;
        }
      }
      processed++;
      save(before, state);
    }
  }
  return { indexed, processed, pending };
}

/** One-way 0.3 metadata migration. Compatible vectors are never re-encoded. */
export function migrateIndex(engine: Engine, s: Session, limit: number) {
  const id = `sdk:index-migration:04:${digest(canonical([engine.indexConfig, engine.legacyConfig, s.trace.policies]))}`;
  const saved = engine.storage.metaGet<{ complete?: boolean; after?: string }>(id);
  if (saved?.complete) return { processed: 0, pending: false };
  const page =
    engine.storage.indexEntries?.(s.trace.policies, [engine.legacyConfig], saved?.after, limit) ??
    [];
  engine.storage.transaction(() => {
    engine.check(s);
    for (const [key, value] of page) {
      s.ledger.charge({ maxCandidates: 1, maxBytes: Buffer.byteLength(canonical(value)) });
      engine.storage.metaSet(key, { ...value, config: engine.indexConfig });
    }
    const complete = page.length < limit;
    engine.storage.metaSet(id, { complete, after: page.at(-1)?.[0] ?? saved?.after });
    if (complete)
      for (const policy of s.trace.policies) {
        const oldKey = `sdk:index-progress:${digest(canonical([engine.legacyConfig, policy, s.trace.policies]))}`;
        const newKey = `sdk:index-progress:${digest(canonical([engine.indexConfig, policy, s.trace.policies]))}`;
        const progress = engine.storage.metaGet(oldKey);
        if (progress && !engine.storage.metaGet(newKey)) engine.storage.metaSet(newKey, progress);
        engine.storage.metaDelete(oldKey);
      }
    if (page.length)
      engine.storage.metaSet(
        'sdk:index-generation',
        (engine.storage.metaGet<number>('sdk:index-generation') ?? 0) + 1,
      );
  });
  return { processed: page.length, pending: page.length === limit };
}
