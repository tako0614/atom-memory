import type { AtomRevision, Ref } from '../contracts.js';
export interface StoredRevision {
  revision: AtomRevision;
  sequence: number;
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
  append(revisions: readonly AtomRevision[]): void;
  metaGet<T>(key: string): T | undefined;
  metaSet(key: string, value: unknown): void;
  metaEntries<T>(prefix: string): [string, T][];
  metaDelete(key: string): void;
  isPurged(atomId: string): boolean;
  erase(atomIds: readonly string[]): void;
  blobRange?(blobId: string, start: number, length: number): Uint8Array | undefined;
  close(): void;
}
