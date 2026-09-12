import type { AuthContext, AtomRevision, Budget, Json } from '../contracts.js';
import type { Authorizer } from '../core/authority.js';
import type { EmbeddingProvider } from '../core/store.js';
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
  readonly inputKind: 'text';
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
  readonly depth?: number;
}
export interface ReadOptions extends SearchOptions {
  readonly tokens?: number;
  readonly depth?: number;
}
export interface InspectOptions extends OperationOptions {
  readonly depth?: number;
  readonly version?: 'observed' | 'latest';
  readonly range?: { readonly start?: number; readonly bytes?: number };
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
  readonly derived: 'ready' | 'pending' | 'unused';
  readonly derivedReason?: 'dependency-stale';
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
  /** Stale Atoms excluded from recall. The host decides whether and when to revise them. */
  readonly stale: readonly AtomRef[];
  readonly items: readonly (AtomView & {
    readonly score?: number;
    readonly scoreBreakdown?: ScoreBreakdown;
  })[];
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
export interface Draft {
  write(content: MemoryContent, options?: WriteOptions): Promise<AtomView>;
  revise(ref: AtomRef, content: MemoryContent, options?: WriteOptions): Promise<AtomView>;
  retire(ref: AtomRef): Promise<AtomView>;
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
export interface HostOptions {
  readonly storage?: StorageAdapter;
  readonly limits?: Partial<import('../core/validation.js').Limits>;
  readonly authority?: Authorizer;
  readonly tokenizer?: Tokenizer;
  readonly embedding?: EmbeddingProvider;
  readonly candidateProvider?: CandidateProvider;
  readonly ranking?: RankingOptions;
  readonly defaults?: Partial<Budget>;
  readonly maxScan?: number;
  readonly cursorTtlMs?: number;
  readonly cacheMaxEntries?: number;
  readonly cacheTtlMs?: number;
  readonly traceTtlMs?: number;
  readonly traceMaxEntries?: number;
  readonly commitRetries?: number;
}
export interface Candidate {
  readonly revision: AtomRevision;
  readonly score: number;
  readonly scoreBreakdown?: ScoreBreakdown;
}
export interface ScoreBreakdown {
  readonly direct: number;
  readonly structural: number;
}
export type SignalKind = 'query' | 'context' | 'thought' | 'observations' | 'signal';
export interface RankingOptions {
  readonly signals?: Partial<Record<SignalKind, number>>;
  readonly semantic?: number;
  readonly lexical?: number;
  readonly propagation?: number;
  readonly relations?: Readonly<
    Record<string, { readonly forward?: number; readonly reverse?: number }>
  >;
  readonly maxSeeds?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxIterations?: number;
  readonly tolerance?: number;
  readonly depth?: number;
}
export interface RetrievalSignal {
  readonly kind: SignalKind;
  readonly text?: string;
  readonly vector?: readonly number[];
}
/** Local access supplied by the host; remote providers must charge every network operation. */
export interface CandidateAccess {
  page(
    after: string | undefined,
    limit: number,
    filter?: { text: readonly string[] },
  ): AtomRevision[];
  representation(revision: AtomRevision): {
    text: string;
    vectors?: readonly (readonly number[])[];
  };
  vectorCandidates?(vectors: readonly (readonly number[])[], limit: number): AtomRevision[];
}
export interface CandidateProvider {
  readonly id: string;
  retrieve(input: {
    readonly texts: readonly string[];
    readonly vectors: readonly (readonly number[])[];
    readonly signals?: readonly RetrievalSignal[];
    readonly ranking?: RankingOptions;
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
export type Usage = Readonly<Record<Resource, number>>;
export type AuditValue = Json;
