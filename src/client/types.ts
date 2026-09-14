import type { AuthContext, AtomRevision, Budget, Json, PinnedRef } from '../contracts.js';
import type { Authorizer } from '../core/authority.js';
import type { BudgetLedger, Resource, Tokenizer } from '../core/budget.js';
import type { StorageAdapter } from '../adapters/storage.js';

/** Host-supplied text encoding for retrieval and indexing, outside atomic storage. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly tokenizer: Tokenizer;
  readonly networkCallsPerCall: number;
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    purpose?: 'query' | 'document',
  ): Promise<readonly (readonly number[])[]>;
}

declare const referenceBrand: unique symbol;
/** A host-registered observed reference. The brand is not authorization. */
export type AtomRef = string & { readonly [referenceBrand]: true };
declare const inputBrand: unique symbol;
/** Host-issued, scope-bound generation input. Never expose in model tool schemas. */
export type InputToken = string & { readonly [inputBrand]: true };
export interface HostInput {
  readonly presentations?: readonly {
    readonly receipt: MemoryReceipt;
    readonly refs?: readonly AtomRef[];
  }[];
  readonly sources?: readonly SourceCitation[];
  readonly inherit?: readonly InputToken[];
  readonly watches?: readonly MemoryReceipt[];
  readonly basis?: 'current' | 'historical';
  /** SHA-256 of the final host payload. Host attestation, not model introspection. */
  readonly payloadDigest: string;
}
export interface LocalLinkTarget {
  /** Batch-local change id. It is never a durable or independently resolvable reference. */
  readonly local: string;
  readonly at?: 'logical' | 'observed';
  readonly required?: boolean;
  readonly orderKey?: string;
}
export type LinkTarget =
  | AtomRef
  | {
      readonly ref: AtomRef;
      readonly at?: 'logical' | 'observed';
      readonly required?: boolean;
      readonly orderKey?: string;
    }
  | LocalLinkTarget;
export type Links =
  | Readonly<Record<string, LinkTarget | readonly LinkTarget[]>>
  | readonly { readonly role: string; readonly target: LinkTarget }[];
export interface MemoryContent {
  readonly text: string;
  /** Links are a full replacement and must be stated, including an empty value. */
  readonly links: Links;
}
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
  readonly version?: 'observed' | 'latest';
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  readonly roles?: readonly string[];
  readonly range?: { readonly start?: number; readonly bytes?: number };
}
export interface WriteOptions {
  readonly idempotencyKey?: string;
  readonly budget?: Partial<Budget>;
  readonly deadline?: string;
  readonly signal?: AbortSignal;
}
export interface CreateChange {
  readonly id: string;
  readonly op: 'create';
  readonly content: MemoryContent;
  /** Citations are a full replacement and must be stated, including an empty array. */
  readonly sources: readonly SourceCitation[];
  readonly input?: InputToken;
}
export interface ReviseChange {
  readonly id: string;
  readonly op: 'revise';
  /** An issued observed revision. It is also the exact compare-and-swap head. */
  readonly target: AtomRef;
  readonly content: MemoryContent;
  readonly sources: readonly SourceCitation[];
  readonly input?: InputToken;
}
export interface RetireChange {
  readonly id: string;
  readonly op: 'retire';
  /** An issued observed revision. Retirement preserves its raw body, slots and origins. */
  readonly target: AtomRef;
  readonly input?: InputToken;
}
export type MemoryChange = CreateChange | ReviseChange | RetireChange;
export interface MemoryWriteRequest {
  readonly changes: readonly MemoryChange[];
}
export type AtomLink = {
  readonly role: string;
  readonly at: 'logical' | 'observed';
  readonly required: boolean;
  readonly orderKey?: string;
} & (
  | { readonly ref: AtomRef; readonly unavailable?: false }
  | { readonly unavailable: true; readonly ref?: never }
);
export interface AtomView {
  readonly ref: AtomRef;
  readonly text: string;
  readonly links: readonly AtomLink[];
  readonly sources: readonly SourceCitation[];
  readonly provenance: {
    readonly origin: 'source' | 'extraction' | 'organization' | 'derived' | 'hypothesis';
    readonly producer: string;
  };
  readonly state: 'active' | 'retired';
}
export interface Diagnostics {
  readonly acquisition?: {
    readonly partial: boolean;
    readonly scanned: number;
    readonly index: string;
  };
  readonly validation?: { readonly stale: number; readonly blocked: number };
  readonly evaluation?: {
    readonly converged: boolean;
    readonly numericErrorL1Upper: number;
    readonly scope: 'acquired-graph';
  };
  readonly selection?: SelectionDiagnostics;
  readonly method: string;
  readonly traversal: 'complete' | 'partial';
  readonly approximate: boolean;
  readonly scanned: number;
  readonly index: 'ready' | 'pending' | 'unavailable';
  readonly derived: 'ready' | 'pending' | 'unused';
  readonly derivedReason?: 'dependency-stale';
  readonly stop: 'completed' | 'page-limit' | 'budget' | 'deadline' | 'numeric-budget';
  readonly evaluatedAt?: number;
  readonly evaluationConverged?: boolean;
  /** Normalized L1 numerical error on the acquired graph only. */
  readonly numericErrorL1Upper?: number;
  readonly minimumTokens?: number;
  readonly minimumBytes?: number;
  readonly coverageCertified: false;
}
export interface SelectionDiagnostics {
  readonly method: 'bounded-marginal-gain';
  readonly complete: boolean;
  readonly baselineComplete: boolean;
  /** Proxy utility only; not answer quality or independent evidence count. */
  readonly utility: number;
  readonly baselineUtility: number;
  readonly work: number;
  readonly minimumTokens?: number;
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
  })[];
  readonly receipt: MemoryReceipt;
  readonly cursor?: string;
  readonly diagnostics: Diagnostics;
  readonly usage: Readonly<Record<Resource, number>>;
}
export interface InspectionVia {
  readonly direction: 'incoming' | 'outgoing';
  readonly role: string;
  readonly at: 'logical' | 'observed';
  readonly required: boolean;
  readonly orderKey?: string;
}
export interface InspectionNeighbor {
  readonly atom: AtomView;
  readonly via: readonly InspectionVia[];
}
export interface Inspection {
  /** Inspect does not certify eligibility for normal read; an unavailable immediate condition is explicit. */
  readonly readEligibility: 'unchecked' | 'blocked';
  readonly atom: AtomView;
  readonly neighbors: readonly InspectionNeighbor[];
  readonly stale: readonly AtomRef[];
  readonly receipt: MemoryReceipt;
  readonly cursor?: string;
  readonly diagnostics: Diagnostics;
  readonly usage: Readonly<Record<Resource, number>>;
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
  readonly formatVersion: 2;
  readonly text: string;
  readonly refs: readonly AtomRef[];
  readonly sources: readonly SourceCitation[];
  readonly tokenCount: number;
}
export interface WriteOutcome {
  readonly operationId: string;
  readonly repeated: boolean;
  readonly indexing: 'pending' | 'ready';
  readonly changes: Readonly<Record<string, AtomView>>;
}
export interface MemoryAPI {
  read(state: MemoryState, options?: ReadOptions): Promise<RecallResult>;
  search(query: string, options?: SearchOptions): Promise<MemoryPage>;
  inspect(ref: AtomRef, options?: InspectOptions): Promise<Inspection>;
  write(request: MemoryWriteRequest, options?: WriteOptions): Promise<WriteOutcome>;
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
  readonly activation?: ActivationOptions;
  readonly retrieval?: RetrievalOptions;
  readonly defaults?: Partial<Budget>;
  readonly cursorTtlMs?: number;
  readonly cacheMaxEntries?: number;
  readonly cacheTtlMs?: number;
  readonly traceTtlMs?: number;
  readonly traceMaxEntries?: number;
  readonly commitRetries?: number;
}
export interface Candidate {
  readonly activation?: number;
  readonly revision: AtomRevision;
  readonly score: number;
}
export type SignalKind = 'query' | 'context' | 'thought' | 'observations' | 'signal';
/** Host-owned, synchronous availability state transition and value model. */
export interface AvailabilityModel<S extends Json = Json> {
  readonly id: string;
  update(previous: S | undefined, acceptedAt: number): S;
  value(state: S | undefined, now: number): number;
}
export type AdaptiveUseState = {
  readonly mass: number;
  readonly updatedAt: number;
  readonly halfLifeMs: number;
};
export interface AdaptiveUseOptions {
  readonly initialHalfLifeMs?: number;
  readonly maxHalfLifeMs?: number;
}
/** Declarative activation inputs plus one host-trusted availability model. */
export interface ActivationOptions {
  readonly model?: AvailabilityModel;
  readonly maxBoost?: number;
  readonly propagation?: number;
  readonly relations?: Readonly<
    Record<string, { readonly forward?: number; readonly reverse?: number }>
  >;
}
/** Bounds on acquisition, independent of use activation. */
export interface RetrievalOptions {
  readonly maxSeeds?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxScan?: number;
  readonly depth?: number;
}
export interface UseResult {
  readonly acceptedAt: number;
  readonly recorded: number;
  readonly repeated: number;
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
    readonly maxScan: number;
    readonly after?: string;
    readonly access: CandidateAccess;
    readonly ledger: BudgetLedger;
    readonly signal: AbortSignal;
  }): Promise<{
    candidates: PinnedRef[];
    scanned: number;
    complete: boolean;
    after?: string;
    pending: boolean;
    approximate: boolean;
  }>;
}
export type Usage = Readonly<Record<Resource, number>>;
export type AuditValue = Json;
