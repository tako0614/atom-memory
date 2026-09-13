import type { AtomRevision, Ref } from '../contracts.js';
import type {
  StorageAdapter,
  ScanQuery,
  StoredRevision,
  StorageCapabilities,
  ChangePosition,
} from './storage.js';
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
  #dependents = new Map<string, Set<string>>();
  #receiptOwners = new Map<string, Set<string>>();
  #edge(target: string, owner: string): void {
    const owners = this.#dependents.get(target) ?? new Set<string>();
    owners.add(owner);
    this.#dependents.set(target, owners);
  }
  watermark(): number {
    return this.#sequence;
  }
  transaction<T>(fn: () => T): T {
    const backup = clone({
      sequence: this.#sequence,
      rows: this.#rows,
      metadata: this.#metadata,
      purged: this.#purged,
      dependents: this.#dependents,
      receiptOwners: this.#receiptOwners,
    });
    try {
      return fn();
    } catch (error) {
      this.#sequence = backup.sequence;
      this.#rows = backup.rows;
      this.#metadata = backup.metadata;
      this.#purged = backup.purged;
      this.#dependents = backup.dependents;
      this.#receiptOwners = backup.receiptOwners;
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
      for (const origin of revision.origins) this.#edge(origin.source.atomId, revision.atomId);
      if (!['source-v2', 'observed-v2'].includes(revision.provenance.dependencyContract ?? ''))
        for (const slot of revision.slots) this.#edge(slot.target.atomId, revision.atomId);
      const id = revision.provenance.inputReceiptId;
      if (id) {
        const owners = this.#receiptOwners.get(id) ?? new Set<string>();
        owners.add(revision.atomId);
        this.#receiptOwners.set(id, owners);
        const m = this.metaGet<import('../core/store.js').ReceiptManifest>(`receipt:${id}`);
        for (const ref of m?.reads ?? []) this.#edge(ref.atomId, revision.atomId);
      }
    }
  }
  changes(
    policies: readonly string[],
    after: ChangePosition,
    limit: number,
    at: number,
  ): StoredRevision[] {
    return clone(
      [...this.#rows.values()]
        .flat()
        .filter(
          (row) =>
            policies.includes(row.revision.policyId) &&
            row.sequence <= at &&
            (row.sequence > after.sequence ||
              (row.sequence === after.sequence && row.revision.revisionId > after.revisionId)),
        )
        .sort(
          (a, b) =>
            a.sequence - b.sequence || (a.revision.revisionId < b.revision.revisionId ? -1 : 1),
        )
        .slice(0, limit),
    );
  }
  metaGet<T>(key: string): T | undefined {
    return clone(this.#metadata.get(key)) as T | undefined;
  }
  metaSet(key: string, value: unknown): void {
    this.#metadata.set(key, clone(value));
    if (key.startsWith('receipt:')) {
      const m = value as import('../core/store.js').ReceiptManifest;
      for (const owner of this.#receiptOwners.get(key.slice(8)) ?? [])
        for (const ref of m.reads) this.#edge(ref.atomId, owner);
    }
  }
  purgeDependents(atomId: string, after: string | undefined, limit: number): string[] {
    return [...(this.#dependents.get(atomId) ?? [])]
      .filter((id) => this.#rows.has(id) && (after === undefined || id > after))
      .sort()
      .slice(0, limit);
  }
  purgeRevisions(atomId: string, after: string | undefined, limit: number): AtomRevision[] {
    return clone(
      (this.#rows.get(atomId) ?? [])
        .map((r) => r.revision)
        .filter((r) => after === undefined || r.revisionId > after)
        .sort((a, b) => (a.revisionId < b.revisionId ? -1 : 1))
        .slice(0, limit),
    );
  }
  metaPage<T>(after: string | undefined, limit: number): [string, T][] {
    return [...this.#metadata.keys()]
      .filter((k) => after === undefined || k > after)
      .sort()
      .slice(0, limit)
      .map((k) => [k, this.metaGet<T>(k)!]);
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
  purgeGeneration(): number {
    return this.metaGet<number>('retention-generation') ?? 0;
  }
  erase(atomIds: readonly string[]): void {
    if (atomIds.length)
      this.metaSet('retention-generation', (this.metaGet<number>('retention-generation') ?? 0) + 1);
    for (const id of atomIds) {
      this.#purged.add(id);
      this.#rows.delete(id);
    }
  }
  blobRange(blobId: string, start: number, length: number): Uint8Array | undefined {
    const blob = this.#metadata.get(`blob:${blobId}`) as { bytes: string } | undefined;
    if (!blob) return;
    const offset = start % 3;
    return Buffer.from(
      blob.bytes.slice(
        Math.floor(start / 3) * 4,
        Math.floor(start / 3) * 4 + Math.ceil((offset + length) / 3) * 4,
      ),
      'base64',
    ).subarray(offset, offset + length);
  }
  close(): void {}
  retainSnapshot(at: number, until: number): string {
    const token = uid('retained');
    // This adapter never garbage-collects immutable versions. Purge always overrides retention.
    this.metaSet(`retained:${token}`, {
      at,
      until,
      generation: this.metaGet<number>('retention-generation') ?? 0,
    });
    return token;
  }
  retainedSnapshot(token: string): { at: number; until: number } | undefined {
    const value = this.metaGet<{ at: number; until: number; generation: number }>(
      `retained:${token}`,
    );
    return value &&
      value.until > Date.now() &&
      value.generation === (this.metaGet<number>('retention-generation') ?? 0)
      ? value
      : undefined;
  }
}
