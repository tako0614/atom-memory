import type { AtomRevision, Ref } from '../contracts.js';
import type { StorageAdapter, ScanQuery, StoredRevision, StorageCapabilities } from './storage.js';
import { canonical, clone, uid } from '../core/util.js';
export class MemoryStorage implements StorageAdapter {
  readonly capabilities: StorageCapabilities = {
    snapshot: true,
    atomicBatch: true,
    queryGuards: true,
  };
  readonly id = uid('memory');
  #sequence = 0;
  #rows = new Map<string, StoredRevision[]>();
  #metadata = new Map<string, unknown>();
  #purged = new Set<string>();
  watermark(): number {
    return this.#sequence;
  }
  transaction<T>(fn: () => T): T {
    const backup = clone({
      sequence: this.#sequence,
      rows: this.#rows,
      metadata: this.#metadata,
      purged: this.#purged,
    });
    try {
      return fn();
    } catch (error) {
      this.#sequence = backup.sequence;
      this.#rows = backup.rows;
      this.#metadata = backup.metadata;
      this.#purged = backup.purged;
      throw error;
    }
  }
  get(ref: Ref, at: number): AtomRevision | undefined {
    if (this.isPurged(ref.atomId)) return;
    const row = this.#rows
      .get(ref.atomId)
      ?.findLast(
        (row) =>
          row.sequence <= at &&
          (ref.kind === 'logical' || row.revision.revisionId === ref.revisionId),
      );
    return row ? clone(row.revision) : undefined;
  }
  scan(query: ScanQuery, at: number): AtomRevision[] {
    const result: AtomRevision[] = [];
    for (const id of [...this.#rows.keys()].sort()) {
      if (query.after !== undefined && id <= query.after) continue;
      const r = this.get({ kind: 'logical', atomId: id }, at);
      if (
        !r ||
        r.state !== 'active' ||
        !query.policies.includes(r.policyId) ||
        (query.schema && !query.schema.includes(r.schema))
      )
        continue;
      if (
        query.relation &&
        !r.slots.some(
          (s) =>
            (!query.relation!.role || s.role === query.relation!.role) &&
            s.target.atomId === query.relation!.target.atomId &&
            (query.relation!.target.kind === 'logical' ||
              s.target.kind === 'logical' ||
              s.target.revisionId === query.relation!.target.revisionId),
        )
      )
        continue;
      if (
        query.text?.length &&
        !query.text.some((t) => canonical(r.body).normalize('NFKC').toLowerCase().includes(t))
      )
        continue;
      result.push(r);
      if (result.length >= query.limit) break;
    }
    return query.limit === 0 ? [] : result;
  }
  history(after: string | undefined, limit: number): AtomRevision[] {
    return clone(
      [...this.#rows.values()]
        .flat()
        .map((row) => row.revision)
        .filter((r) => after === undefined || r.revisionId > after)
        .sort((a, b) => (a.revisionId < b.revisionId ? -1 : 1))
        .slice(0, limit),
    );
  }
  append(revisions: readonly AtomRevision[]): void {
    this.#sequence++;
    for (const revision of revisions) {
      const rows = this.#rows.get(revision.atomId) ?? [];
      rows.push({ revision: clone(revision), sequence: this.#sequence });
      this.#rows.set(revision.atomId, rows);
    }
  }
  metaGet<T>(key: string): T | undefined {
    return clone(this.#metadata.get(key)) as T | undefined;
  }
  metaSet(key: string, value: unknown): void {
    this.#metadata.set(key, clone(value));
  }
  metaEntries<T>(prefix: string): [string, T][] {
    return [...this.#metadata.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k, clone(v) as T]);
  }
  metaDelete(key: string): void {
    this.#metadata.delete(key);
  }
  isPurged(atomId: string): boolean {
    return this.#purged.has(atomId);
  }
  erase(atomIds: readonly string[]): void {
    for (const id of atomIds) {
      this.#purged.add(id);
      this.#rows.delete(id);
    }
  }
  close(): void {}
}
