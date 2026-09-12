import type { AtomRevision, Ref } from '../contracts.js';
export interface StoredRevision {
  revision: AtomRevision;
  sequence: number;
}
export interface ChangePosition {
  sequence: number;
  revisionId: string;
}
export interface VectorQuery {
  policies: readonly string[];
  config: string;
  vectors: readonly (readonly number[])[];
  limit: number;
}
export interface ScanQuery {
  policies: readonly string[];
  schema?: readonly string[];
  relation?: { target: Ref; role?: string };
  text?: readonly string[];
  after?: string;
  limit: number;
}
export interface StorageCapabilities {
  readonly snapshot: boolean;
  readonly atomicBatch: boolean;
  readonly queryGuards: boolean;
}
/** Synchronous short transactions. Never hold one across a model/network call. */
export interface StorageAdapter {
  readonly capabilities: StorageCapabilities;
  readonly id: string;
  watermark(): number;
  transaction<T>(fn: () => T): T;
  get(ref: Ref, at: number): AtomRevision | undefined;
  scan(query: ScanQuery, at: number): AtomRevision[];
  history(after: string | undefined, limit: number): AtomRevision[];
  /** Stable revision feed; ties within one atomic commit use revisionId. */
  changes?(
    policies: readonly string[],
    after: ChangePosition,
    limit: number,
    at: number,
  ): StoredRevision[];
  /** Approximate vector ingress; results must be authorized current heads at at. */
  vectorCandidates?(query: VectorQuery, at: number): AtomRevision[];
  /** Exact transitive purge closure across historical links, origins and host-read receipts. */
  purgePlan?(atomId: string): { revisions: AtomRevision[]; receiptKeys: string[] };
  append(revisions: readonly AtomRevision[]): void;
  metaGet<T>(key: string): T | undefined;
  metaSet(key: string, value: unknown): void;
  metaEntries<T>(prefix: string): [string, T][];
  /** Filter paired metadata keys before loading values (for example durable versus transient traces). */
  metaUnbackedEntries?<T>(prefix: string, backingPrefix: string): [string, T][];
  metaDelete(key: string): void;
  metaDeletePrefix?(prefix: string): void;
  isPurged(atomId: string): boolean;
  erase(atomIds: readonly string[]): void;
  blobRange?(blobId: string, start: number, length: number): Uint8Array | undefined;
  /** Retain all immutable revisions at this watermark until the deadline, except explicit purge.
   * Must participate in transaction(). Snapshot reads alone do not imply this retention guarantee. */
  retainSnapshot?(at: number, until: number): string;
  retainedSnapshot?(token: string): { at: number; until: number } | undefined;
  close(): void;
}
