import type { StorageAdapter } from '../adapters/storage.js';
import type { AtomRevision } from '../contracts.js';
import type { ReceiptManifest } from './store.js';
import { canonical, clone, fail, validId } from './util.js';
import { purgeUse } from './use-state.js';

export interface PurgeOptions {
  readonly dryRun?: boolean;
  readonly maxWork?: number;
}
export interface PurgeResult {
  complete: boolean;
  dryRun: boolean;
  affectedAtomIds: string[];
  erasedAtomIds: string[];
  legacyDependencies: boolean;
  work: number;
  minimumWork?: number;
  reason?: 'budget' | 'storage-error';
  physicalStorageReclaimed: false;
}
interface Pending {
  root: string;
  phase: 'dependencies' | 'revisions' | 'erase' | 'metadata';
  ids: string[];
  index: number;
  after?: string;
  sizes: Record<string, number>;
  revisionIds: string[];
  legacy: boolean;
  erased: string[];
}
/** A finite, resumable administrative operation. The global barrier favors erasure safety over availability. */
export function purgeStorage(
  storage: StorageAdapter,
  atomId: string,
  options: PurgeOptions = {},
): PurgeResult {
  validId(atomId);
  if (
    Object.keys(options).some((k) => !['dryRun', 'maxWork'].includes(k)) ||
    (options.dryRun !== undefined && typeof options.dryRun !== 'boolean')
  )
    fail('INVALID_INPUT');
  const max = options.maxWork ?? 16000000;
  if (!Number.isSafeInteger(max) || max < 0) fail('INVALID_INPUT');
  if (!storage.purgeDependents || !storage.purgeRevisions || !storage.metaPage)
    fail('ATOMICITY_UNAVAILABLE', 'Storage lacks bounded erasure pages');
  const previous = options.dryRun ? undefined : storage.metaGet<Pending>('purge:pending');
  if (previous && previous.root !== atomId) fail('INVALID_INPUT', 'Resume the pending purge first');
  let pending: Pending = previous ?? {
    root: atomId,
    phase: 'dependencies',
    ids: [atomId],
    index: 0,
    sizes: {},
    revisionIds: [],
    legacy: false,
    erased: [],
  };
  let work = 0,
    minimumWork: number | undefined;
  const spend = (n: number) => {
    if (work + n > max) {
      minimumWork = n;
      return false;
    }
    work += n;
    return true;
  };
  const save = () => {
    if (!options.dryRun) storage.metaSet('purge:pending', pending);
  };
  const outcome = (complete: boolean, reason?: PurgeResult['reason']): PurgeResult => ({
    complete,
    dryRun: options.dryRun === true,
    affectedAtomIds: [...pending.ids],
    erasedAtomIds: [...pending.erased],
    legacyDependencies: pending.legacy,
    work,
    ...(minimumWork !== undefined ? { minimumWork } : {}),
    ...(reason ? { reason } : {}),
    physicalStorageReclaimed: false,
  });
  // Persist before discovery or destructive I/O; every public read/write checks this barrier.
  if (!options.dryRun) storage.transaction(save);
  try {
    while (true) {
      if (!spend(1)) {
        save();
        return outcome(false, 'budget');
      }
      if (pending.phase === 'dependencies') {
        const target = pending.ids[pending.index];
        if (target === undefined) {
          pending.phase = 'revisions';
          pending.index = 0;
          delete pending.after;
          save();
          continue;
        }
        const page = storage.purgeDependents(target, pending.after, 1);
        if (page.length) {
          const id = page[0]!;
          if (!pending.ids.includes(id)) pending.ids.push(id);
          pending.after = id;
        } else {
          pending.index++;
          delete pending.after;
        }
        save();
      } else if (pending.phase === 'revisions') {
        const target = pending.ids[pending.index];
        if (target === undefined) {
          if (options.dryRun) return outcome(true);
          pending.phase = 'erase';
          pending.index = 0;
          delete pending.after;
          save();
          continue;
        }
        const revision = storage.purgeRevisions(target, pending.after, 1)[0];
        if (!revision) {
          pending.index++;
          delete pending.after;
          save();
          continue;
        }
        const bytes =
          Buffer.byteLength(canonical(revision)) +
          (revision.body.kind === 'blob' ? revision.body.bytes : 0);
        if (!spend(bytes)) {
          save();
          return outcome(false, 'budget');
        }
        pending.sizes[target] = (pending.sizes[target] ?? 0) + bytes;
        pending.revisionIds.push(revision.revisionId);
        pending.legacy ||= !['source-v2', 'observed-v2'].includes(
          revision.provenance.dependencyContract ?? '',
        );
        pending.after = revision.revisionId;
        save();
      } else if (pending.phase === 'erase') {
        const target = pending.ids[pending.index];
        if (target === undefined) {
          pending.phase = 'metadata';
          pending.index = 0;
          delete pending.after;
          save();
          continue;
        }
        // One logical Atom (all immutable versions) is an atomic erase unit.
        if (!spend((pending.sizes[target] ?? 0) + 1)) {
          save();
          return outcome(false, 'budget');
        }
        const revisions: AtomRevision[] = [];
        let after: string | undefined;
        while (true) {
          const page = storage.purgeRevisions(target, after, 128);
          revisions.push(...page);
          if (page.length < 128) break;
          after = page.at(-1)!.revisionId;
        }
        const checkpoint = clone(pending);
        try {
          storage.transaction(() => {
            for (const r of revisions) {
              if (r.body.kind === 'blob') storage.metaDelete(`blob:${r.body.blobId}`);
              storage.metaDelete(`embedding:${r.revisionId}`);
              storage.metaDelete(`sdk:index:${r.revisionId}`);
            }
            purgeUse(storage, revisions);
            storage.erase([target]);
            pending.erased.push(target);
            pending.index++;
            save();
          });
        } catch (error) {
          pending = checkpoint;
          throw error;
        }
      } else {
        const entry = storage.metaPage<unknown>(pending.after, 1)[0];
        if (!entry) {
          storage.transaction(() => {
            storage.metaSet(
              'sdk:index-generation',
              (storage.metaGet<number>('sdk:index-generation') ?? 0) + 1,
            );
            storage.metaDelete('purge:pending');
          });
          return outcome(true);
        }
        const [key, value] = entry;
        if (!spend(Buffer.byteLength(canonical(value)) + Buffer.byteLength(key))) {
          save();
          return outcome(false, 'budget');
        }
        const clear = [
          'cursor:',
          'observation:',
          'sdk:cache:',
          'sdk:cursor:',
          'sdk:trace:',
          'sdk:manifest:',
        ].some((p) => key.startsWith(p));
        let affected = false;
        if (key.startsWith('receipt:')) {
          const m = value as ReceiptManifest;
          affected =
            m.reads.some((r) => pending.ids.includes(r.atomId)) ||
            !!m.acquisition?.reads.some((r) => pending.ids.includes(r.atomId)) ||
            !!m.ownedRevisionIds?.some((id) => pending.revisionIds.includes(id));
        }
        storage.transaction(() => {
          if (clear || affected) storage.metaDelete(key);
          pending.after = key;
          save();
        });
      }
    }
  } catch {
    // The durable barrier remains. A host may fix storage and invoke the same finite operation again.
    return outcome(false, 'storage-error');
  }
}
