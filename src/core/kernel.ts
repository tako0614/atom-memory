import type {
  AtomMemory,
  AtomRevision,
  AuthContext,
  Budget,
  ContextPack,
  ContextUnit,
  Embedding,
  Origin,
  PinnedRef,
  ProposedRevision,
  ReadContext,
  ReadReceipt,
  ReadRequest,
  ReadResult,
  Ref,
  Selector,
  WriteRequest,
  WriteResult,
} from '../contracts.js';
import type { Authorizer, Principal } from './authority.js';
import type { StorageAdapter, ScanQuery } from '../adapters/storage.js';
import { MemoryStorage } from '../adapters/memory.js';
import {
  BudgetLedger,
  defaultBudget,
  utf8Tokenizer,
  type Tokenizer,
  type Resource,
} from './budget.js';
import { canonical, clone, digest, fail, textOf, terms, uid, validId } from './util.js';
import {
  defaultLimits,
  validateBatchDag,
  validateContent,
  validateOrigin,
  validateRef,
  type Limits,
} from './validation.js';

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly tokenizer: Tokenizer;
  readonly networkCallsPerCall: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
}
export interface ReceiptManifest {
  receipt: ReadReceipt;
  subject: string;
  authBinding: string;
  generation: string;
  policies: string[];
  watermark: number;
  reads: PinnedRef[];
  /** Optional explicit currentness preconditions, distinct from the complete audit. */
  currentReads?: PinnedRef[];
  /** The SDK commits these outputs as one dependency unit; prevents artificial intra-batch cycles. */
  ownedRevisionIds?: string[];
  historicalInputs?: boolean;
  observations: {
    observationId: string;
    selector: Selector;
    watermark: number;
    query: ScanQuery;
    revisionIds: string[];
  }[];
  expiresAt: number;
  tokenizerId: string;
  encoderConfigId?: string;
  indexWatermark?: number;
  overlayHandle?: string;
}
interface Cursor {
  binding: string;
  authBinding: string;
  generation: string;
  expiresAt: number;
  watermark: number;
  pending: { ref: Ref; hop: number }[];
  seen: string[];
  scanAfter?: string;
  scanned: boolean;
  receiptId: string;
  queryVectors?: readonly (readonly number[])[];
}
interface Overlay {
  authBinding: string;
  watermark: number;
  revisions: readonly ProposedRevision[];
}
interface BlobRecord {
  bytes: string;
  policyId: string;
  digest: string;
  mediaType: string;
}
export interface KernelOptions {
  storage?: StorageAdapter;
  authority: Authorizer;
  tokenizer?: Tokenizer;
  embedding?: EmbeddingProvider;
  limits?: Partial<Limits>;
  receiptTtlMs?: number;
}
const pinned = (r: AtomRevision): PinnedRef => ({
  kind: 'pinned',
  atomId: r.atomId,
  revisionId: r.revisionId,
});
const authBinding = (auth: AuthContext) => digest(auth.authorizationHandle);
const refKey = (r: Ref) => (r.kind === 'pinned' ? `${r.atomId}\0${r.revisionId}` : r.atomId);
const scopeKey = (r: ReadRequest) =>
  digest(canonical({ selector: r.selector, context: r.context, render: r.render }));

/** Trusted host service. Expose only read/write through bound model tools. */
export class AtomKernel implements AtomMemory {
  readonly storage: StorageAdapter;
  readonly authority: Authorizer;
  readonly tokenizer: Tokenizer;
  readonly limits: Limits;
  readonly embedding?: EmbeddingProvider;
  readonly receiptTtlMs: number;
  #overlays = new Map<string, Overlay>();
  constructor(options: KernelOptions) {
    this.storage = options.storage ?? new MemoryStorage();
    this.authority = options.authority;
    this.tokenizer = options.tokenizer ?? utf8Tokenizer;
    this.embedding = options.embedding;
    this.limits = { ...defaultLimits, ...options.limits };
    this.receiptTtlMs = options.receiptTtlMs ?? 3600000;
    if (!Number.isSafeInteger(this.receiptTtlMs) || this.receiptTtlMs <= 0) fail('INVALID_SCHEMA');
  }
  #principal(auth: AuthContext): Principal {
    return this.authority.resolve(auth);
  }
  #scope(context: ReadContext, p: Principal): string[] {
    if (!context || !Array.isArray(context.requestedPolicyIds)) fail('INVALID_SCHEMA');
    if (context.requestedPolicyIds.some((id) => !p.readPolicies.includes(id)))
      fail('ACCESS_DENIED');
    if (!['snapshot', 'version-pinned'].includes(context.consistency?.mode)) fail('INVALID_SCHEMA');
    if (context.consistency.mode === 'snapshot' && !this.storage.capabilities.snapshot)
      fail('CONSISTENCY_UNAVAILABLE');
    if (context.validAt !== undefined && !Number.isFinite(Date.parse(context.validAt)))
      fail('INVALID_SCHEMA');
    return [...new Set(context.requestedPolicyIds)].sort();
  }
  #manifest(id: string, auth: AuthContext, p: Principal, allowExpired = false): ReceiptManifest {
    const m = this.storage.metaGet<ReceiptManifest>(`receipt:${id}`);
    if (!m || (!allowExpired && Date.now() > m.expiresAt)) fail('CURSOR_EXPIRED');
    if (
      m.authBinding !== authBinding(auth) ||
      m.subject !== p.subject ||
      m.generation !== p.generation ||
      m.policies.some((id) => !p.readPolicies.includes(id))
    )
      fail('ACCESS_DENIED');
    if (m.reads.some((r) => this.storage.isPurged(r.atomId))) fail('ACCESS_DENIED');
    return m;
  }
  inspectReceipt(id: string, auth: AuthContext): ReceiptManifest {
    return clone(this.#manifest(id, auth, this.#principal(auth)));
  }
  combineReceipts(ids: readonly string[], auth: AuthContext): ReadReceipt {
    const p = this.#principal(auth);
    const manifests = ids.map((id) => this.#manifest(id, auth, p));
    if (!manifests.length) fail('INVALID_SCHEMA');
    const m = clone(manifests[0]!);
    if (manifests.some((x) => x.watermark !== m.watermark)) fail('REVISION_CONFLICT');
    m.receipt = { ...m.receipt, receiptId: uid('receipt') };
    m.reads = [
      ...new Map(manifests.flatMap((x) => x.reads).map((r) => [r.revisionId, r])).values(),
    ];
    m.observations = [
      ...new Map(
        manifests.flatMap((x) => x.observations).map((o) => [o.observationId, o]),
      ).values(),
    ];
    m.policies = [...new Set(manifests.flatMap((x) => x.policies))];
    m.expiresAt = Math.min(...manifests.map((x) => x.expiresAt));
    if (m.reads.length > this.limits.maxReadCandidates) fail('LIMIT_EXCEEDED');
    this.storage.metaSet(`receipt:${m.receipt.receiptId}`, m);
    return m.receipt;
  }
  #overlay(handle: string | undefined, auth: AuthContext): Overlay | undefined {
    if (!handle) return;
    const overlay = this.#overlays.get(handle);
    if (!overlay || overlay.authBinding !== authBinding(auth)) fail('ACCESS_DENIED');
    return overlay;
  }
  #get(ref: Ref, at: number, overlay?: Overlay): AtomRevision | undefined {
    if (this.storage.isPurged(ref.atomId)) return;
    const staged = overlay?.revisions.find(
      (p) => p.atomId === ref.atomId && (ref.kind === 'logical' || p.revisionId === ref.revisionId),
    );
    if (staged)
      return {
        ...clone(staged.content),
        atomId: staged.atomId,
        revisionId: staged.revisionId,
        ...(staged.expectedHead ? { previousRevisionId: staged.expectedHead } : {}),
        recordedAt: new Date(0).toISOString(),
      };
    return this.storage.get(ref, at);
  }
  #allowed(r: AtomRevision, p: Principal, policies: readonly string[]): boolean {
    return (
      policies.includes(r.policyId) &&
      p.readPolicies.includes(r.policyId) &&
      !this.storage.isPurged(r.atomId)
    );
  }
  #currentDependency(m: ReceiptManifest, at: number, overlay?: Overlay): boolean {
    if (
      m.observations.some(
        (o) =>
          canonical(
            this.storage
              .scan({ ...o.query, limit: Math.min(o.query.limit, o.revisionIds.length + 1) }, at)
              .map((r) => r.revisionId),
          ) !== canonical(o.revisionIds),
      )
    )
      return false;
    return (m.currentReads ?? m.reads).every(
      (ref) =>
        this.storage.get({ kind: 'logical', atomId: ref.atomId }, at)?.revisionId ===
          ref.revisionId ||
        overlay?.revisions.some((r) => r.atomId === ref.atomId && r.revisionId === ref.revisionId),
    );
  }
  #derivation(r: AtomRevision, at: number, p: Principal, overlay?: Overlay): boolean {
    const id = r.provenance.inputReceiptId;
    if (!id) return true;
    const m = this.storage.metaGet<ReceiptManifest>(`receipt:${id}`);
    return (
      !!m &&
      m.policies.every((id) => id === r.policyId && p.readPolicies.includes(id)) &&
      this.#currentDependency(m, at, overlay)
    );
  }
  #blob(id: string): BlobRecord | undefined {
    return this.storage.metaGet<BlobRecord>(`blob:${id}`);
  }
  #body(r: AtomRevision): string {
    if (r.body.kind === 'inline') return textOf(r.body.value);
    // read() returns immutable blob metadata, not unbounded bytes.
    return canonical(r.body);
  }
  async write(
    request: WriteRequest,
    auth: AuthContext,
    hooks?: { validate?(): void; committed?(result: WriteResult): void },
  ): Promise<WriteResult> {
    const input = clone(request);
    const p = this.#principal(auth);
    if (!this.storage.capabilities.atomicBatch) fail('ATOMICITY_UNAVAILABLE');
    if (!input || !Array.isArray(input.revisions) || !Array.isArray(input.guards))
      fail('INVALID_SCHEMA');
    validId(input.idempotencyKey);
    if (
      !input.revisions.length ||
      input.revisions.length > this.limits.maxBatch ||
      input.guards.length > this.limits.maxBatch ||
      Buffer.byteLength(canonical(input)) > this.limits.maxWriteBytes
    )
      fail('LIMIT_EXCEEDED');
    if (
      input.guards.some((g) => g.kind === 'query-observation') &&
      !this.storage.capabilities.queryGuards
    )
      fail('GUARD_VALIDATION_UNAVAILABLE');
    const key = `write:${digest(canonical([p.subject, input.idempotencyKey]))}`;
    const fingerprint = digest(canonical(input));
    return this.storage.transaction(() => {
      const previous = this.storage.metaGet<{
        fingerprint: string;
        result: WriteResult;
        policies: string[];
      }>(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        if (
          previous.policies.some((id) => !p.writePolicies.includes(id)) ||
          previous.result.committed.some((r) => this.storage.isPurged(r.atomId))
        )
          fail('ACCESS_DENIED');
        return { ...previous.result, repeatedInput: true };
      }
      hooks?.validate?.();
      const at = this.storage.watermark();
      const manifests = new Map<string, ReceiptManifest>();
      const manifestFor = (id: string): ReceiptManifest => {
        const saved = manifests.get(id);
        if (saved) return saved;
        const manifest = this.#manifest(id, auth, p);
        manifests.set(id, manifest);
        return manifest;
      };
      const validated = new Set<string>();
      const currentDependency = (manifest: ReceiptManifest): boolean => {
        if (validated.has(manifest.receipt.receiptId)) return true;
        const current = this.#currentDependency(manifest, at, {
          authBinding: authBinding(auth),
          watermark: at,
          revisions: input.revisions,
        });
        if (current) validated.add(manifest.receipt.receiptId);
        return current;
      };
      const actor = input.actorInputReceiptId ? manifestFor(input.actorInputReceiptId) : undefined;
      if (actor && !currentDependency(actor))
        fail('REVISION_CONFLICT', 'Read dependencies changed');
      const ids = new Set<string>();
      const revisions = new Set<string>();
      for (const item of input.revisions) {
        validId(item.atomId);
        validId(item.revisionId);
        if (
          ids.has(item.atomId) ||
          revisions.has(item.revisionId) ||
          this.storage.metaGet(`revision-id:${item.revisionId}`)
        )
          fail('REVISION_CONFLICT');
        ids.add(item.atomId);
        revisions.add(item.revisionId);
        if (this.storage.isPurged(item.atomId)) fail('ACCESS_DENIED');
        const old = this.storage.get({ kind: 'logical', atomId: item.atomId }, at);
        if ((old?.revisionId ?? null) !== item.expectedHead) fail('REVISION_CONFLICT');
        if (
          old &&
          (old.policyId !== item.content.policyId || !p.writePolicies.includes(old.policyId))
        )
          fail('ACCESS_DENIED');
        validateContent(item.content, p, this.limits, !!actor);
      }
      const proposed = new Map(input.revisions.map((r) => [r.atomId, r]));
      const resolve = (ref: Ref): AtomRevision => {
        const next = proposed.get(ref.atomId);
        const candidate =
          next && (ref.kind === 'logical' || next.revisionId === ref.revisionId)
            ? {
                ...next.content,
                atomId: next.atomId,
                revisionId: next.revisionId,
                recordedAt: new Date().toISOString(),
              }
            : this.storage.get(ref, at);
        if (!candidate) fail('REFERENCE_UNAVAILABLE');
        if (!p.readPolicies.includes(candidate.policyId) || this.storage.isPurged(ref.atomId))
          fail('ACCESS_DENIED');
        return candidate;
      };
      for (const item of input.revisions) {
        const c = item.content;
        const receiptId = c.provenance.inputReceiptId;
        const receipt = receiptId ? manifestFor(receiptId) : undefined;
        if (actor && receiptId !== actor.receipt.receiptId)
          fail('ACCESS_DENIED', 'All Writer changes must retain the host input receipt');
        if (receipt && receipt.policies.some((id) => id !== c.policyId))
          fail('ACCESS_DENIED', 'Persistent derivation cannot cross policies');
        if (receipt && !currentDependency(receipt)) fail('REVISION_CONFLICT');
        for (const slot of c.slots) {
          const target = resolve(slot.target);
          if (target.policyId !== c.policyId)
            fail('ACCESS_DENIED', 'Persistent references must remain in one policy');
        }
        for (const origin of c.origins) {
          const source = resolve(origin.source);
          if (source.policyId !== c.policyId) fail('ACCESS_DENIED');
          if (
            receipt &&
            !receipt.reads.some(
              (r) => r.atomId === source.atomId && r.revisionId === source.revisionId,
            )
          )
            fail('ACCESS_DENIED', 'Origin was not in the host read trace');
          validateOrigin(origin, source, (id) => {
            const b = this.#blob(id);
            return b ? Buffer.from(b.bytes, 'base64') : undefined;
          });
        }
        if (c.body.kind === 'blob') {
          const b = this.#blob(c.body.blobId);
          if (
            !b ||
            b.policyId !== c.policyId ||
            b.digest !== c.body.digest ||
            b.mediaType !== c.body.mediaType ||
            Buffer.from(b.bytes, 'base64').length !== c.body.bytes
          )
            fail('REFERENCE_UNAVAILABLE');
        }
      }
      validateBatchDag(input.revisions);
      for (const guard of input.guards) {
        if (guard.kind === 'head') {
          const r = resolve({ kind: 'pinned', atomId: guard.atomId, revisionId: guard.revisionId });
          if (
            this.storage.get({ kind: 'logical', atomId: r.atomId }, at)?.revisionId !==
            guard.revisionId
          )
            fail('REVISION_CONFLICT');
        } else if (guard.kind === 'query-observation') {
          const observation = this.storage.metaGet<{ receiptId: string; watermark: number }>(
            `observation:${guard.observationId}`,
          );
          if (!observation) fail('GUARD_VALIDATION_UNAVAILABLE');
          const manifest = this.#manifest(observation.receiptId, auth, p);
          if (!this.#currentDependency(manifest, at))
            fail('REVISION_CONFLICT', 'Query range changed');
        } else fail('INVALID_SCHEMA');
      }
      this.#principal(auth);
      const committed = input.revisions.map((item) => ({
        ...cleanContent(item.content),
        provenance: { ...clone(item.content.provenance), producerId: p.subject },
        atomId: item.atomId,
        revisionId: item.revisionId,
        ...(item.expectedHead === null ? {} : { previousRevisionId: item.expectedHead }),
        recordedAt: new Date().toISOString(),
      }));
      this.storage.append(committed);
      for (const r of committed) this.storage.metaSet(`revision-id:${r.revisionId}`, true);
      const result: WriteResult = {
        operationId: uid('op'),
        committed: committed.map(pinned),
        repeatedInput: false,
        indexState: 'ready',
      };
      this.storage.metaSet(key, {
        fingerprint,
        result,
        policies: [...new Set(committed.map((r) => r.policyId))],
      });
      hooks?.committed?.(result);
      return result;
    });
  }
  async #embed(
    texts: readonly string[],
    ledger: BudgetLedger,
  ): Promise<readonly (readonly number[])[]> {
    const e = this.embedding ?? fail('INDEX_NOT_READY');
    const tokens = texts.reduce((n, t) => n + e.tokenizer.count(t), 0);
    ledger.charge({
      maxModelCalls: 1,
      maxNetworkCalls: e.networkCallsPerCall,
      maxModelInputTokens: tokens,
    });
    const timeout = ledger.limits.deadline
      ? Math.max(1, Date.parse(ledger.limits.deadline) - Date.now())
      : 30000;
    const signal = AbortSignal.timeout(Math.min(timeout, 2147483647));
    const vectors = await Promise.race([
      e.embed(texts, signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Embedding deadline exceeded')), {
          once: true,
        }),
      ),
    ]);
    if (
      vectors.length !== texts.length ||
      vectors.some((v) => v.length !== e.dimensions || v.some((n) => !Number.isFinite(n)))
    )
      fail('MODEL_SPACE_MISMATCH');
    return vectors;
  }
  async index(ref: PinnedRef, auth: AuthContext, budget: Budget = defaultBudget): Promise<void> {
    const p = this.#principal(auth);
    const r = this.storage.get(ref, this.storage.watermark());
    if (!r || !p.readPolicies.includes(r.policyId)) fail('ACCESS_DENIED');
    const ledger = new BudgetLedger(budget);
    const text = this.#body(r);
    ledger.charge({ maxAtoms: 1, maxCandidates: 1, maxBytes: Buffer.byteLength(text) });
    const vectors = await this.#embed([text], ledger);
    const current = this.#principal(auth);
    if (current.generation !== p.generation || this.storage.isPurged(ref.atomId))
      fail('ACCESS_DENIED');
    const receiptId = uid('embedding-input');
    this.storage.metaSet(`receipt:${receiptId}`, {
      receipt: { receiptId, consistency: 'version-pinned', policyValidationToken: p.generation },
      subject: p.subject,
      authBinding: authBinding(auth),
      generation: p.generation,
      policies: [r.policyId],
      watermark: this.storage.watermark(),
      reads: [ref],
      observations: [],
      expiresAt: Date.now() + this.receiptTtlMs,
      tokenizerId: this.embedding!.tokenizer.id,
      encoderConfigId: this.embedding!.id,
    } satisfies ReceiptManifest);
    const embedding: Embedding = {
      owner: ref,
      encoderConfigId: this.embedding!.id,
      dimensions: this.embedding!.dimensions,
      normalized: false,
      vectors,
      inputReceiptId: receiptId,
    };
    this.storage.metaSet(`embedding:${ref.revisionId}`, embedding);
    this.storage.metaSet(
      'embedding-watermark',
      (this.storage.metaGet<number>('embedding-watermark') ?? 0) + 1,
    );
  }
  async read(
    request: ReadRequest,
    auth: AuthContext,
  ): Promise<ReadResult & { usage: Readonly<Record<Resource, number>> }> {
    const input = clone(request);
    const p = this.#principal(auth);
    const policies = this.#scope(input.context, p);
    const ledger = new BudgetLedger(input.budget);
    if (input.budget.maxCandidates > this.limits.maxReadCandidates) fail('LIMIT_EXCEEDED');
    if (!['raw', 'evidence', 'mixed'].includes(input.render)) fail('INVALID_SCHEMA');
    this.#validateSelector(input.selector);
    const overlay = this.#overlay(input.context.overlayHandle, auth);
    let at = overlay?.watermark ?? this.storage.watermark();
    let previousManifest: ReceiptManifest | undefined;
    if (input.context.consistency.mode === 'snapshot' && input.context.consistency.snapshotToken) {
      previousManifest = this.#manifest(input.context.consistency.snapshotToken, auth, p);
      at = previousManifest.watermark;
    } else if (
      input.context.consistency.mode === 'version-pinned' &&
      input.context.consistency.receiptId
    ) {
      previousManifest = this.#manifest(input.context.consistency.receiptId, auth, p);
      at = previousManifest.watermark;
    }
    const indexWatermark = this.storage.metaGet<number>('embedding-watermark') ?? 0;
    let cursor: Cursor | undefined;
    if (input.continuation) {
      cursor = this.storage.metaGet<Cursor>(`cursor:${input.continuation}`);
      if (!cursor || cursor.expiresAt < Date.now() || cursor.binding !== scopeKey(input))
        fail('CURSOR_EXPIRED');
      if (cursor.authBinding !== authBinding(auth) || cursor.generation !== p.generation)
        fail('ACCESS_DENIED');
      previousManifest = this.#manifest(cursor.receiptId, auth, p);
      at = cursor.watermark;
      if (
        previousManifest.encoderConfigId !== this.embedding?.id ||
        (this.embedding && previousManifest.indexWatermark !== indexWatermark)
      )
        fail('CURSOR_EXPIRED', 'Search representation changed');
    }
    const manifest: ReceiptManifest = previousManifest
      ? clone(previousManifest)
      : {
          receipt: {
            receiptId: uid('receipt'),
            consistency: input.context.consistency.mode,
            policyValidationToken: p.generation,
          },
          subject: p.subject,
          authBinding: authBinding(auth),
          generation: p.generation,
          policies,
          watermark: at,
          reads: [],
          observations: [],
          expiresAt: Date.now() + this.receiptTtlMs,
          tokenizerId: this.tokenizer.id,
          ...(this.embedding ? { encoderConfigId: this.embedding.id, indexWatermark } : {}),
          ...(input.context.overlayHandle ? { overlayHandle: input.context.overlayHandle } : {}),
        };
    // Each page gets an immutable trace; a prior receipt never grows after publication.
    if (previousManifest && cursor)
      manifest.receipt = { ...manifest.receipt, receiptId: uid('receipt') };
    // A receipt for another query is a new trace pinned to its read state.
    if (previousManifest && !cursor) {
      manifest.receipt = { ...manifest.receipt, receiptId: uid('receipt') };
      manifest.reads = [];
      manifest.observations = [];
      manifest.policies = policies;
    }
    manifest.receipt = {
      receiptId: manifest.receipt.receiptId,
      consistency: input.context.consistency.mode,
      policyValidationToken: p.generation,
      ...(input.context.consistency.mode === 'snapshot'
        ? { snapshotToken: manifest.receipt.receiptId }
        : {}),
    };
    const pending =
      cursor?.pending ??
      (input.selector.kind === 'refs' ? input.selector.refs.map((ref) => ({ ref, hop: 0 })) : []);
    const seen = new Set(cursor?.seen ?? []);
    let scanAfter = cursor?.scanAfter;
    let scanned = cursor?.scanned ?? input.selector.kind === 'refs';
    let stop: ReadResult['diagnostics']['stopReason'] = 'completed';
    let pendingDerived = false;
    let indexLagging = false;
    const atoms: AtomRevision[] = [];
    const units: ContextUnit[] = [];
    let pack: ContextPack | undefined;
    let queryVectors: readonly (readonly number[])[] = cursor?.queryVectors ?? [];
    if (input.selector.kind === 'search' && this.embedding && !cursor?.queryVectors) {
      const queries = [
        input.selector.query,
        input.selector.context,
        input.selector.reasoningState,
      ].filter((v): v is string => !!v);
      if (
        queries.length &&
        ledger.can({
          maxModelCalls: 1,
          maxNetworkCalls: this.embedding.networkCallsPerCall,
          maxModelInputTokens: queries.reduce((n, t) => n + this.embedding!.tokenizer.count(t), 0),
        })
      )
        queryVectors = await this.#embed(queries, ledger);
      else indexLagging = true;
    }
    if (
      input.selector.kind !== 'refs' &&
      !manifest.observations.some((o) => canonical(o.selector) === canonical(input.selector))
    ) {
      // Record the exact bounded range when it is scanned below, including an empty result.
    }
    // Fetch a bounded candidate window; scans and graph visits share one ledger.
    if (!scanned && ledger.can({ maxCandidates: 1 })) {
      const selector = input.selector;
      const query: ScanQuery = {
        policies,
        after: scanAfter,
        limit: Math.min(ledger.remaining('maxCandidates'), this.limits.maxReadCandidates),
        ...(selector.kind === 'relations'
          ? {
              relation: {
                target: selector.target,
                ...(selector.role ? { role: selector.role } : {}),
              },
              ...(selector.schema ? { schema: [selector.schema] } : {}),
            }
          : selector.kind === 'search'
            ? {
                ...(selector.schemaFilter ? { schema: selector.schemaFilter } : {}),
                ...(this.embedding
                  ? {}
                  : {
                      text: terms(
                        [selector.query, selector.context, selector.reasoningState]
                          .filter(Boolean)
                          .join(' '),
                      ),
                    }),
              }
            : {}),
      };
      let candidates = this.storage.scan(query, at);
      manifest.observations.push({
        observationId: uid('observation'),
        selector: input.selector,
        watermark: at,
        query: clone(query),
        revisionIds: candidates.map((r) => r.revisionId),
      });
      if (overlay) {
        const tentative = new MemoryStorage();
        tentative.append(
          overlay.revisions.map((item) =>
            this.#get(
              { kind: 'pinned', atomId: item.atomId, revisionId: item.revisionId },
              at,
              overlay,
            )!,
          ),
        );
        candidates = [
          ...candidates.filter((r) => !overlay.revisions.some((v) => v.atomId === r.atomId)),
          ...tentative.scan(query, 1),
        ]
          .sort((a, b) => (a.atomId < b.atomId ? -1 : 1))
          .slice(0, query.limit);
      }
      scanned = candidates.length < query.limit;
      if (candidates.length) scanAfter = candidates[candidates.length - 1]!.atomId;
      const scores = new Map<string, number>();
      for (const r of candidates) {
        const representation = this.storage.metaGet<Embedding>(`embedding:${r.revisionId}`);
        if (queryVectors.length && representation) {
          if (
            representation.encoderConfigId !== this.embedding!.id ||
            representation.dimensions !== this.embedding!.dimensions
          ) {
            indexLagging = true;
            scores.set(r.revisionId, 0);
          } else
            scores.set(
              r.revisionId,
              Math.max(
                0,
                ...queryVectors.flatMap((q) => representation.vectors.map((v) => cosine(q, v))),
              ),
            );
        } else {
          if (queryVectors.length) indexLagging = true;
          scores.set(r.revisionId, 0);
        }
      }
      candidates.sort(
        (a, b) =>
          scores.get(b.revisionId)! - scores.get(a.revisionId)! || (a.atomId < b.atomId ? -1 : 1),
      );
      pending.push(...candidates.map((r) => ({ ref: pinned(r), hop: 0 })));
    }
    while (pending.length) {
      if (ledger.expired) {
        stop = 'deadline';
        break;
      }
      if (!ledger.can({ maxCandidates: 1 }) || !ledger.can({ maxAtoms: 1 })) {
        stop = ledger.remaining('maxAtoms') === 0 ? 'page-limit' : 'budget';
        break;
      }
      const next = pending[0]!;
      if (seen.has(refKey(next.ref))) {
        pending.shift();
        continue;
      }
      ledger.charge({ maxCandidates: 1 });
      const r = this.#get(next.ref, at, overlay);
      if (!r) {
        if (this.storage.isPurged(next.ref.atomId)) fail('ACCESS_DENIED');
        if (input.selector.kind === 'refs' && next.hop === 0) fail('REFERENCE_UNAVAILABLE');
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      if (seen.has(refKey(pinned(r)))) {
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      if (!this.#allowed(r, p, policies)) {
        if (input.selector.kind === 'refs' && next.hop === 0) fail('ACCESS_DENIED');
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      const bytes = Buffer.byteLength(canonical(r));
      if (!ledger.can({ maxBytes: bytes })) {
        stop = 'budget';
        break;
      }
      ledger.charge({ maxBytes: bytes });
      if (!manifest.reads.some((ref) => ref.revisionId === r.revisionId))
        manifest.reads.push(pinned(r));
      if (r.state === 'retired' && next.ref.kind === 'logical') {
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      if (
        input.context.validAt &&
        ((r.validTime?.from && Date.parse(r.validTime.from) > Date.parse(input.context.validAt)) ||
          (r.validTime?.until &&
            Date.parse(r.validTime.until) <= Date.parse(input.context.validAt)))
      ) {
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      const dependencies = r.provenance.inputReceiptId
        ? this.storage.metaGet<ReceiptManifest>(`receipt:${r.provenance.inputReceiptId}`)
        : undefined;
      const dependencyCost = dependencies
        ? {
            maxCandidates:
              dependencies.reads.length +
              dependencies.observations.reduce((n, o) => n + o.revisionIds.length + 1, 0),
            maxBytes: Buffer.byteLength(canonical(dependencies)),
          }
        : {};
      if (!ledger.can(dependencyCost)) {
        pendingDerived = true;
        stop = 'budget';
        break;
      }
      ledger.charge(dependencyCost);
      if (!this.#derivation(r, at, p, overlay)) {
        pendingDerived = true;
        pending.shift();
        seen.add(refKey(next.ref));
        continue;
      }
      const unit = input.render === 'raw' ? undefined : this.#unit(r, input.render);
      if (unit) {
        const nextUnits = [...units, unit];
        const serialized = canonical({ units: nextUnits });
        const count = this.tokenizer.count(serialized);
        if (!Number.isSafeInteger(count) || count < 0)
          fail('INVALID_SCHEMA', 'Tokenizer returned invalid count');
        if (count > input.budget.maxContextTokens) {
          stop = 'budget';
          break;
        }
        pack = { units: nextUnits, serialized, tokenCount: count };
        units.push(unit);
      }
      ledger.charge({ maxAtoms: 1 });
      atoms.push(r);
      pending.shift();
      seen.add(refKey(next.ref));
      seen.add(refKey(pinned(r)));
      if (next.hop < input.budget.maxHops) {
        for (const slot of r.slots)
          if (
            slot.mode === 'include' ||
            (input.selector.kind === 'relations' && r.schema === 'membership')
          )
            pending.push({ ref: slot.target, hop: next.hop + 1 });
        // Dynamic reverse expansion is explicit, never mixed into pinned include expansion.
        if (input.selector.kind === 'relations' && ledger.can({ maxCandidates: 1 })) {
          const count = Math.min(ledger.remaining('maxCandidates'), this.limits.maxSlots);
          const neighbors = this.storage.scan(
            { policies, relation: { target: pinned(r) }, limit: count },
            at,
          );
          ledger.charge({ maxCandidates: neighbors.length });
          pending.push(...neighbors.map((n) => ({ ref: pinned(n), hop: next.hop + 1 })));
          if (neighbors.length === count) stop = 'budget';
        }
      }
    }
    if (!pending.length && !scanned) stop = 'budget';
    if (ledger.expired) stop = 'deadline';
    if (
      this.embedding &&
      (this.storage.metaGet<number>('embedding-watermark') ?? 0) !== indexWatermark
    )
      fail('INDEX_NOT_READY', 'Index changed during read; retry with a fresh read');
    if (pack) ledger.charge({ maxContextTokens: pack.tokenCount });
    const current = this.#principal(auth);
    if (
      current.generation !== p.generation ||
      manifest.reads.some((r) => this.storage.isPurged(r.atomId))
    )
      fail('ACCESS_DENIED');
    if (manifest.reads.length > this.limits.maxReadCandidates)
      fail(
        'LIMIT_EXCEEDED',
        'Read context manifest limit reached; start a new bounded read context',
      );
    this.storage.metaSet(`receipt:${manifest.receipt.receiptId}`, manifest);
    for (const o of manifest.observations)
      this.storage.metaSet(`observation:${o.observationId}`, {
        receiptId: manifest.receipt.receiptId,
        watermark: o.watermark,
      });
    let continuation: string | undefined;
    if (pending.length || !scanned) {
      continuation = uid('cursor');
      this.storage.metaSet(`cursor:${continuation}`, {
        binding: scopeKey(input),
        authBinding: authBinding(auth),
        generation: p.generation,
        expiresAt: manifest.expiresAt,
        watermark: at,
        pending,
        seen: [...seen],
        scanAfter,
        scanned,
        receiptId: manifest.receipt.receiptId,
        queryVectors,
      } satisfies Cursor);
    }
    return {
      atoms,
      usage: ledger.usage(),
      ...(pack ? { contextPack: pack } : {}),
      receipt: manifest.receipt,
      ...(continuation ? { continuation } : {}),
      diagnostics: {
        traversal:
          continuation || stop !== 'completed'
            ? 'partial'
            : input.selector.kind === 'search'
              ? 'approximate'
              : 'exhausted-declared-scope',
        indexState: indexLagging ? 'lagging' : 'ready-for-receipt',
        derivedState: pendingDerived
          ? 'pending'
          : atoms.some((r) => !!r.provenance.inputReceiptId)
            ? 'validated-for-receipt'
            : 'unused',
        stopReason: stop,
        semanticCoverageCertified: false,
      },
    };
  }
  #validateSelector(selector: Selector): void {
    if (!selector) fail('INVALID_SCHEMA');
    if (selector.kind === 'refs') {
      if (!Array.isArray(selector.refs) || selector.refs.length > this.limits.maxReadCandidates)
        fail('LIMIT_EXCEEDED');
      selector.refs.forEach(validateRef);
    } else if (selector.kind === 'relations') {
      validateRef(selector.target);
      if (selector.role) validId(selector.role);
      if (selector.schema) validId(selector.schema);
    } else if (selector.kind === 'search') {
      if (
        typeof selector.query !== 'string' ||
        Buffer.byteLength(canonical(selector)) > this.limits.maxAtomBytes
      )
        fail('LIMIT_EXCEEDED');
    } else fail('INVALID_SCHEMA');
  }
  #unit(r: AtomRevision, render: 'evidence' | 'mixed'): ContextUnit | undefined {
    let kind: ContextUnit['kind'];
    if (r.provenance.kind === 'source') kind = 'source';
    else if (r.provenance.kind === 'extraction') kind = 'extract';
    else if (r.schema === 'membership' || r.schema === 'statement') kind = 'relationship';
    else if (render === 'mixed') kind = 'summary';
    else return;
    return {
      unitId: r.revisionId,
      owner: pinned(r),
      kind,
      text: canonical({
        body: this.#body(r),
        schema: r.schema,
        provenance: r.provenance,
        slots: r.slots,
        validTime: r.validTime,
      }),
      citedOrigins: r.origins,
      companionIds: r.slots.map((s) => s.target.atomId),
    };
  }
  /** Store large immutable source bytes through the trusted host. */
  putBlob(
    bytes: Uint8Array,
    policyId: string,
    mediaType: string,
    auth: AuthContext,
  ): { kind: 'blob'; blobId: string; digest: string; mediaType: string; bytes: number } {
    const p = this.#principal(auth);
    if (!p.canIngestSource || !p.writePolicies.includes(policyId)) fail('ACCESS_DENIED');
    validId(mediaType);
    const id = uid('blob');
    const hash = digest(bytes);
    this.storage.metaSet(`blob:${id}`, {
      bytes: Buffer.from(bytes).toString('base64'),
      policyId,
      digest: hash,
      mediaType,
    } satisfies BlobRecord);
    return { kind: 'blob', blobId: id, digest: hash, mediaType, bytes: bytes.length };
  }
  createOverlay(auth: AuthContext): string {
    this.#principal(auth);
    const id = uid('overlay');
    this.#overlays.set(id, {
      authBinding: authBinding(auth),
      watermark: this.storage.watermark(),
      revisions: [],
    });
    return id;
  }
  stage(handle: string, revisions: readonly ProposedRevision[], auth: AuthContext): void {
    const overlay = this.#overlay(handle, auth)!;
    const p = this.#principal(auth);
    if (revisions.length > this.limits.maxBatch) fail('LIMIT_EXCEEDED');
    for (const r of revisions) {
      validId(r.atomId);
      validId(r.revisionId);
      validateContent(r.content, { ...p, canIngestSource: false }, this.limits, true);
    }
    overlay.revisions = clone([...revisions]);
  }
  discardOverlay(handle: string, auth: AuthContext): void {
    this.#overlay(handle, auth);
    this.#overlays.delete(handle);
  }
  /** Deny old reads immediately, then remove transitive derivatives and private execution data. Host-only. */
  purge(atomId: string): { erasedAtomIds: string[]; physicalStorageReclaimed: false } {
    validId(atomId);
    return this.storage.transaction(() => {
      const erased = new Set([atomId]);
      const receipts = this.storage.metaEntries<ReceiptManifest>('receipt:');
      const all: AtomRevision[] = [];
      let after: string | undefined;
      // Purge inspects every historical revision, including retired content and old blobs.
      while (true) {
        const page = this.storage.history(after, 256);
        all.push(...page);
        if (page.length < 256) break;
        after = page.at(-1)!.revisionId;
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const r of all) {
          const m = receipts.find(
            ([, m]) => m.receipt.receiptId === r.provenance.inputReceiptId,
          )?.[1];
          if (
            !erased.has(r.atomId) &&
            (r.origins.some((o) => erased.has(o.source.atomId)) ||
              r.slots.some((s) => erased.has(s.target.atomId)) ||
              m?.reads.some((v) => erased.has(v.atomId)))
          ) {
            erased.add(r.atomId);
            changed = true;
          }
        }
      }
      for (const r of all)
        if (erased.has(r.atomId) && r.body.kind === 'blob')
          this.storage.metaDelete(`blob:${r.body.blobId}`);
      this.storage.erase([...erased]);
      for (const [key] of this.storage.metaEntries('cursor:')) this.storage.metaDelete(key);
      for (const [key] of this.storage.metaEntries('observation:')) this.storage.metaDelete(key);
      for (const [key, m] of receipts)
        if (m.reads.some((r) => erased.has(r.atomId))) this.storage.metaDelete(key);
      for (const [key, e] of this.storage.metaEntries<Embedding>('embedding:'))
        if (erased.has(e.owner.atomId)) this.storage.metaDelete(key);
      for (const [key] of this.storage.metaEntries('sdk:cache:')) this.storage.metaDelete(key);
      for (const [key] of this.storage.metaEntries('sdk:cursor:')) this.storage.metaDelete(key);
      for (const [key] of this.storage.metaEntries('sdk:index:')) this.storage.metaDelete(key);
      this.#overlays.clear();
      return { erasedAtomIds: [...erased], physicalStorageReclaimed: false };
    });
  }
}
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) fail('MODEL_SPACE_MISMATCH');
  const dot = a.reduce((n, v, i) => n + v * b[i]!, 0);
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm === 0 ? 0 : dot / norm;
}

function cleanContent(
  c: import('../contracts.js').AtomContent,
): import('../contracts.js').AtomContent {
  return {
    schema: c.schema,
    state: c.state,
    body: clone(c.body),
    slots: clone(c.slots),
    origins: clone(c.origins),
    provenance: clone(c.provenance),
    policyId: c.policyId,
    ...(c.validTime ? { validTime: clone(c.validTime) } : {}),
  };
}
