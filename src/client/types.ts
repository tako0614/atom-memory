import type { AuthContext, AtomRevision, Budget, Json, Origin, PinnedRef } from '../contracts.js';
import type { Authorizer } from '../core/authority.js';
import type { EmbeddingProvider, AtomKernel } from '../core/kernel.js';
import type { BudgetLedger, Resource, Tokenizer } from '../core/budget.js';
import type { StorageAdapter } from '../adapters/storage.js';

declare const referenceBrand: unique symbol;
/** A host-registered observed reference. The brand is not authorization. */
export type AtomRef = string & { readonly [referenceBrand]: true };
export type LinkTarget =
  | AtomRef
  | {
      readonly ref: AtomRef;
      readonly at?: 'logical' | 'observed';
      readonly required?: boolean;
      readonly orderKey?: string;
    };
export type Links =
  | Readonly<Record<string, LinkTarget | readonly LinkTarget[]>>
  | readonly { readonly role: string; readonly target: LinkTarget }[];
export type MemoryContent = string | { readonly text: string; readonly links?: Links };
export interface SourceCitation {
  readonly ref: AtomRef;
  readonly start?: number;
  readonly end?: number;
}
export interface MemoryState {
  readonly query?: string;
  readonly context?: string;
  readonly thought?: string;
  readonly observations?: readonly string[];
  readonly signal?: SearchSignal;
}
export interface SearchSignal {
  readonly encoderId: string;
  readonly dimensions: number;
  readonly transformId: string;
  readonly inputKind: 'text' | 'mapped-state';
  readonly values: readonly number[];
}
export interface OperationOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly deadline?: string;
  readonly budget?: Partial<Budget>;
}
export interface SearchOptions extends OperationOptions {
  readonly historical?: boolean;
}
export interface ReadOptions extends SearchOptions {
  readonly tokens?: number;
  readonly depth?: number;
}
export interface InspectOptions extends OperationOptions {
  readonly depth?: number;
  readonly version?: 'observed' | 'latest';
  readonly successor?: boolean;
  readonly history?: 'retained';
  readonly range?: { readonly start?: number; readonly bytes?: number };
  /** Host-declared composition, separate from bidirectional neighbourhood depth. */
  readonly composition?: CompositionPlan;
}
export interface WriteOptions {
  readonly idempotencyKey?: string;
  readonly sources?: readonly SourceCitation[];
  readonly signal?: AbortSignal;
}
export interface EditOptions extends OperationOptions {
  readonly basis?: 'current' | 'historical';
}
export interface AtomView {
  readonly ref: AtomRef;
  readonly text: string;
  readonly links: readonly {
    readonly role: string;
    readonly ref: AtomRef;
    readonly at: 'logical' | 'observed';
    readonly required: boolean;
    readonly orderKey?: string;
  }[];
  readonly sources: readonly SourceCitation[];
  readonly provenance: {
    readonly origin: 'source' | 'extraction' | 'organization' | 'derived' | 'hypothesis';
    readonly producer: string;
  };
  readonly state: 'active' | 'retired';
}
export interface Diagnostics {
  readonly method: string;
  readonly traversal: 'complete' | 'partial';
  readonly approximate: boolean;
  readonly scanned: number;
  readonly index: 'ready' | 'pending' | 'unavailable';
  readonly derived: 'ready' | 'pending' | 'regenerated' | 'unused';
  readonly derivedReason?:
    'missing-plan' | 'acquisition-incomplete' | 'dependency-stale' | 'unsupported-input' | 'budget';
  readonly stop: 'completed' | 'page-limit' | 'budget' | 'deadline';
  readonly minimumTokens?: number;
  readonly minimumBytes?: number;
  readonly coverageCertified: false;
}
export interface MemoryReceipt {
  readonly id: string;
  readonly state: string;
  readonly signalDigest: string;
}
export interface MemoryPage {
  readonly items: readonly (AtomView & { readonly score?: number })[];
  readonly receipt: MemoryReceipt;
  readonly cursor?: string;
  readonly diagnostics: Diagnostics;
  readonly usage: Readonly<Record<Resource, number>>;
}
export interface Inspection extends MemoryPage {
  readonly atom: AtomView;
  readonly range?: {
    readonly start: number;
    readonly end: number;
    readonly totalBytes: number;
    readonly text?: string;
    readonly base64?: string;
    readonly mediaType: string;
  };
  readonly history?: { readonly retainedUntil: string; readonly ref: AtomRef };
}
export interface RecallResult extends MemoryPage {
  readonly text: string;
  readonly refs: readonly AtomRef[];
  readonly sources: readonly SourceCitation[];
  readonly tokenCount: number;
}
export interface WriteOutcome extends AtomView {
  readonly operationId: string;
  readonly repeated: boolean;
  readonly indexing: 'pending' | 'ready';
}
export interface SupersedeOptions {
  readonly retainForMs?: number;
  readonly composition?: CompositionPlan;
}
/** Roles describe directed external relations. No reserved membership label is required.
 * Fixed include slots are always followed. Recursive rules apply at each selected child. */
export interface CompositionPlan {
  readonly relations: readonly {
    readonly parent: string;
    readonly children: readonly string[];
    readonly recursive?: boolean;
  }[];
}
export interface Draft {
  write(content: MemoryContent, options?: WriteOptions): Promise<AtomView>;
  revise(ref: AtomRef, content: MemoryContent, options?: WriteOptions): Promise<AtomView>;
  retire(ref: AtomRef): Promise<AtomView>;
  supersede(oldRef: AtomRef, newRef: AtomRef, options?: SupersedeOptions): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<MemoryPage>;
  inspect(ref: AtomRef, options?: InspectOptions): Promise<Inspection>;
}
export interface EditOutcome<T> {
  readonly value: T;
  readonly changes: readonly AtomView[];
  readonly operationId: string;
  resolve(ref: AtomRef): AtomRef;
}
export interface MemoryAPI {
  read(state: MemoryState, options?: ReadOptions): Promise<RecallResult>;
  search(query: string, options?: SearchOptions): Promise<MemoryPage>;
  inspect(ref: AtomRef, options?: InspectOptions): Promise<Inspection>;
  write(content: MemoryContent, options?: WriteOptions): Promise<WriteOutcome>;
  edit<T>(
    callback: (draft: Draft) => T | Promise<T>,
    options?: EditOptions,
  ): Promise<EditOutcome<T>>;
}
export interface HostActor {
  readonly type: 'human' | 'input-adapter' | 'agent';
  readonly generatedOrigin?: 'extraction' | 'organization' | 'derived' | 'hypothesis';
}
export interface ClientBinding {
  readonly auth: AuthContext;
  readonly writePolicy: string;
  readonly readPolicies?: readonly string[];
  readonly actor: HostActor;
}
export interface Generator {
  readonly id: string;
  readonly tokenizer: Tokenizer;
  readonly maxOutputTokens: number;
  readonly networkCallsPerCall: number;
  generate(
    input: {
      readonly previous: string;
      readonly sources: readonly { ref: PinnedRef; text: string }[];
      /** Current selected Atoms, including ordered roles and exact source ranges. */
      readonly atoms: readonly AtomView[];
      readonly receipt: MemoryReceipt;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
export interface HostOptions {
  readonly kernel?: AtomKernel;
  readonly storage?: StorageAdapter;
  readonly authority?: Authorizer;
  readonly tokenizer?: Tokenizer;
  readonly embedding?: EmbeddingProvider;
  readonly generator?: Generator;
  readonly candidateProvider?: CandidateProvider;
  readonly defaults?: Partial<Budget>;
  readonly maxScan?: number;
  readonly cursorTtlMs?: number;
  readonly historyRetentionMs?: number;
  readonly historyMaxAtoms?: number;
  readonly cacheMaxEntries?: number;
  readonly cacheTtlMs?: number;
  readonly traceTtlMs?: number;
  readonly traceMaxEntries?: number;
  readonly commitRetries?: number;
}
export interface Candidate {
  readonly revision: AtomRevision;
  readonly score: number;
}
/** Local access supplied by the host; remote providers must charge every network operation. */
export interface CandidateAccess {
  page(after: string | undefined, limit: number): AtomRevision[];
  representation(revision: AtomRevision): {
    text: string;
    vectors?: readonly (readonly number[])[];
  };
}
export interface CandidateProvider {
  readonly id: string;
  retrieve(input: {
    readonly texts: readonly string[];
    readonly vectors: readonly (readonly number[])[];
    readonly maxScan: number;
    readonly after?: string;
    readonly access: CandidateAccess;
    readonly ledger: BudgetLedger;
    readonly signal: AbortSignal;
  }): Promise<{
    candidates: Candidate[];
    scanned: number;
    complete: boolean;
    after?: string;
    pending: boolean;
    approximate: boolean;
  }>;
}
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
  /** Declarative acquisition, distinct from the immutable observed reads/pages. */
  plans?: AcquisitionPlan[];
  readonly createdAt: number;
  readonly config: string;
}
/** SDK-owned records, never executable model instructions. Pages are always replayed from the start. */
export type AcquisitionPlan =
  | { kind: 'search'; state: MemoryState; depth: number; historical: boolean }
  | {
      kind: 'inspect';
      target: import('../contracts.js').Ref;
      depth: number;
      composition?: CompositionPlan;
    }
  | { kind: 'source'; target: import('../contracts.js').Ref };
export type Usage = Readonly<Record<Resource, number>>;
export type AuditValue = Json;
