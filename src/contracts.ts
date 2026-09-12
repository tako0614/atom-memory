/**
 * Atom Memory v1.0 — public contracts, not a kernel implementation.
 * All bounds, IDs, trust labels, policies and graph/transaction invariants
 * require runtime enforcement. A readonly type is not a security boundary.
 */
export type Id = string;
export type Json = null | boolean | number | string | readonly Json[] |
  { readonly [key: string]: Json };

export interface PinnedRef {
  readonly kind: 'pinned';
  readonly atomId: Id;
  readonly revisionId: Id;
}
export interface LogicalRef {
  readonly kind: 'logical';
  readonly atomId: Id;
}
export type Ref = PinnedRef | LogicalRef;

export type Slot = {
  readonly role: string;
  readonly required?: boolean; // Host-known companion dependency for context packing.
  readonly orderKey?: string; // Display/declared sequence order, not causal proof.
} & (
  | { readonly mode: 'include'; readonly target: PinnedRef }
  | { readonly mode: 'refer'; readonly target: Ref }
);

export interface Origin {
  readonly source: PinnedRef;
  readonly selector: {
    readonly kind: 'utf8';
    readonly start: number;
    readonly end: number; // Half-open; validate UTF-8 boundaries at runtime.
    readonly quoteDigest: string;
  };
}

export type Body =
  | { readonly kind: 'inline'; readonly value: Json }
  | { readonly kind: 'blob'; readonly blobId: Id;
      readonly digest: string; readonly mediaType: string; readonly bytes: number };

export interface Provenance {
  readonly kind: 'source' | 'extraction' | 'organization' | 'derived' | 'hypothesis';
  readonly producerId: Id;
  readonly runId?: Id;
  /** Host-created inputs-read manifest; not an LLM-authored citation list. */
  readonly inputReceiptId?: Id;
}

export interface AtomContent {
  readonly schema: string; // Data interpretation, NEVER arbitrary executable code.
  readonly state: 'active' | 'retired';
  readonly body: Body;
  readonly slots: readonly Slot[]; // Bounded; large membership is independent Atoms.
  readonly origins: readonly Origin[];
  readonly provenance: Provenance; // Host validates/stamps, including kind='source'.
  readonly policyId: Id; // A policy request/reference, never a grant from the model.
  readonly validTime?: {
    readonly status: 'known' | 'partial' | 'unknown';
    readonly from?: string;
    readonly until?: string;
  };
}

/** One immutable revision. Same schema for content, groups and relationships. */
export interface AtomRevision extends AtomContent {
  readonly atomId: Id;
  readonly revisionId: Id;
  readonly previousRevisionId?: Id;
  readonly recordedAt: string; // Host-stamped; not a global commit ordering.
}

export interface AuthContext {
  readonly authorizationHandle: Id; // Trusted host-issued identity/capabilities.
}

export type Consistency =
  | { readonly mode: 'snapshot'; readonly snapshotToken?: Id }
  | { readonly mode: 'version-pinned'; readonly receiptId?: Id };


export interface Budget {
  readonly maxAtoms: number;
  readonly maxCandidates: number;
  readonly maxBytes: number;
  readonly maxNetworkCalls: number;
  readonly maxModelCalls: number;
  readonly maxModelInputTokens: number;
  readonly maxModelOutputTokens: number;
  readonly maxContextTokens: number;
  readonly maxHops: number;
  readonly deadline?: string;
}

export type Selector =
  | { readonly kind: 'refs'; readonly refs: readonly Ref[] }
  | { readonly kind: 'relations'; readonly target: Ref;
      readonly role?: string; readonly schema?: string }
  | { readonly kind: 'search'; readonly query: string;
      readonly context?: string; readonly reasoningState?: string;
      readonly schemaFilter?: readonly string[] };




export interface ReadReceipt {
  readonly receiptId: Id; // Host-managed trace, possibly paged internally.
  readonly consistency: Consistency['mode'];
  readonly snapshotToken?: Id;
  readonly policyValidationToken: Id;
  // Identifies versions, head resolutions, query ranges, empty searches,
  // index watermarks and operator/model versions in the host-held manifest.
}


export interface ProposedRevision {
  readonly atomId: Id;
  readonly revisionId: Id; // Unique candidate ID; kernel validates/preallocates.
  readonly expectedHead: Id | null; // null=create-if-absent; otherwise exact CAS.
  readonly content: AtomContent;
}

export type Guard =
  | { readonly kind: 'head'; readonly atomId: Id; readonly revisionId: Id }
  | { readonly kind: 'query-observation'; readonly observationId: Id };

export interface WriteRequest {
  readonly idempotencyKey: string;
  readonly revisions: readonly ProposedRevision[]; // Finite all-or-nothing batch.
  readonly guards: readonly Guard[];
  readonly actorInputReceiptId?: Id;
  // Unsupported atomicity/guard validation must fail BEFORE applying changes.
}

export interface WriteResult {
  readonly operationId: Id;
  readonly committed: readonly PinnedRef[];
  readonly repeatedInput: boolean;
  readonly indexState: 'ready' | 'pending'; // Commit success is not index readiness.
}

/** Central semantic API. Administration and trusted runtime setup are separate. */

/** Internal replaceable access representation, not an independent memory kind. */

export type ErrorCode =
  | 'ACCESS_DENIED' | 'REFERENCE_UNAVAILABLE' | 'INVALID_SOURCE_SPAN'
  | 'INVALID_SCHEMA' | 'LIMIT_EXCEEDED' | 'PINNED_INCLUDE_REQUIRED'
  | 'INCLUDE_CYCLE' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT'
  | 'ATOMICITY_UNAVAILABLE' | 'CONSISTENCY_UNAVAILABLE'
  | 'GUARD_VALIDATION_UNAVAILABLE' | 'INDEX_NOT_READY'
  | 'CURSOR_EXPIRED' | 'MODEL_SPACE_MISMATCH' | 'BUDGET_EXHAUSTED'
  | 'INVALID_INPUT' | 'INVALID_REF' | 'ABORTED' | 'HISTORY_INCOMPLETE' | 'HISTORY_PLAN_REQUIRED'
  | 'HISTORY_EXPIRED' | 'SUCCESSOR_CONFLICT' | 'SUCCESSOR_CYCLE'
  | 'CONTEXT_WINDOW_EXCEEDED' | 'STATE_INVALIDATED';

/** A common host loop; Writer and answer runs differ by task and capabilities. */
