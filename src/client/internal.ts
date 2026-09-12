import type { PinnedRef } from '../contracts.js';

/** Internal host trace; raw references and policies are never model-supplied authority. */
export interface Trace {
  readonly id: string;
  readonly at: number;
  readonly authBinding: string;
  readonly generation: string;
  readonly policies: readonly string[];
  readonly signalDigest: string;
  reads: PinnedRef[];
  current: PinnedRef[];
  queries: { query: import('../adapters/storage.js').ScanQuery; revisions: string[] }[];
  readonly createdAt: number;
  readonly config: string;
}
