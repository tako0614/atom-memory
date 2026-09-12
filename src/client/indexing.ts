import type { AtomRevision } from '../contracts.js';
import type { ChangePosition } from '../adapters/storage.js';
import type { ClientBinding, OperationOptions } from './types.js';
import type { Engine, Session } from './engine.js';
import { canonical, digest, fail } from '../core/util.js';

export async function indexRevision(engine: Engine, r: AtomRevision, s: Session): Promise<number> {
  engine.get({ kind: 'pinned', atomId: r.atomId, revisionId: r.revisionId }, s);
  const text = engine.text(r);
  const key = `sdk:index:${r.revisionId}`;
  const old = engine.storage.metaGet<{
    config: string;
    hash: string;
    policyId?: string;
    vectors?: number[][];
  }>(key);
  if (
    old &&
    [engine.previousIndexConfig, engine.legacyConfig].includes(old.config) &&
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
}
/** A durable consumer of committed revisions, independent of model transactions.
 * A failed encoder leaves the event pending; a restart never requires a full scan.
 * Only the changed Atom is indexed: relationship traversal is separate from its body. */
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
  let processed = 0,
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
      s.ledger.charge({ maxCandidates: 1 });
      const changed = engine.storage.changes(
        [policy],
        before?.after ?? { sequence: 0, revisionId: '' },
        1,
        s.at,
      )[0];
      if (!changed) break;
      if (processed >= limit) {
        pending = true;
        break;
      }
      const head = engine.storage.get({ kind: 'logical', atomId: changed.revision.atomId }, s.at);
      if (head?.state === 'active') indexed += await indexRevision(engine, head, s);
      processed++;
      save(before, {
        after: { sequence: changed.sequence, revisionId: changed.revision.revisionId },
      });
    }
  }
  return { indexed, processed, pending };
}
