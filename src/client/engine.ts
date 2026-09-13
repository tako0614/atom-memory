import type { Trace } from './internal.js';
import { activationOptions, retrievalOptions, seedScore } from '../core/ranking.js';
import type { RetrievalSignal } from './types.js';
import { indexRevision } from './indexing.js';
import type {
  AtomRevision,
  AuthContext,
  PinnedRef,
  ProposedRevision,
  Ref,
  WriteRequest,
  WriteResult,
} from '../contracts.js';
import { AtomicStore, type ReceiptManifest } from '../core/store.js';
import type { Principal } from '../core/authority.js';
import { BudgetLedger, utf8Tokenizer } from '../core/budget.js';
import { HybridCandidateProvider, LexicalCandidateProvider } from '../core/candidates.js';
import { canonical, clone, digest, fail, textOf, uid, AtomMemoryError } from '../core/util.js';
import type { ScanQuery } from '../adapters/storage.js';
import type {
  AtomRef,
  AtomView,
  Candidate,
  ClientBinding,
  Diagnostics,
  HostOptions,
  MemoryReceipt,
  MemoryState,
  OperationOptions,
} from './types.js';
import { cancellable, cancellation, operationBudget } from './control.js';
export const pinRevision = (r: AtomRevision): PinnedRef => ({
  kind: 'pinned',
  atomId: r.atomId,
  revisionId: r.revisionId,
});
export const bindingKey = (auth: AuthContext) => digest(auth.authorizationHandle);
export interface RefEntry {
  target: PinnedRef;
  at: number;
  authBinding: string;
  subject: string;
  policy: string;
  overlay?: string;
}
export interface OverlayState {
  id: string;
  at: number;
  authBinding: string;
  active: boolean;
  revisions: Map<string, ProposedRevision>;
  refs: Set<AtomRef>;
  traces: Trace[];
  inputs?: Map<string, import('./types.js').InputToken>;
}
export interface Session {
  binding: ClientBinding;
  principal: Principal;
  at: number;
  overlay?: OverlayState;
  ledger: BudgetLedger;
  signal: AbortSignal;
  trace: Trace;
  charged: Set<string>;
  derived: Diagnostics['derived'];
  derivedReason?: Diagnostics['derivedReason'];
  pendingDerived?: boolean;
  stale: Set<AtomRef>;
  blocked?: Set<AtomRef>;
  validated: Map<string, boolean>;
  purgeEpoch?: number;
  recording?: { trace: Trace; reads: Set<string>; current: Set<string> };
}
export interface QueryState {
  id: string;
  kind: 'search' | 'read' | 'inspect' | 'index';
  binding: string;
  generation: string;
  at: number;
  signalDigest: string;
  index: number;
  config: string;
  expires: number;
  overlay?: string;
  candidates: Candidate[];
  evaluatedCandidates?: Candidate[];
  offset: number;
  complete: boolean;
  scanned: number;
  pending: boolean;
  approximate: boolean;
  trace: Trace;
  scanAfter?: string;
  graph?: GraphState;
  root?: PinnedRef;
  blobOffset?: number;
  evaluation?: { evaluatedAt: number; evaluationConverged: boolean; numericErrorL1Upper: number };
}
export interface GraphTask {
  ref: PinnedRef;
  depth: number;
  phase: 'emit' | 'forward' | 'reverse';
  slot: number;
  after?: string;
}
export interface GraphState {
  tasks: GraphTask[];
  seen: string[];
  maxDepth: number;
}
export class RetryableCommitError extends Error {}
export class Engine {
  readonly kernel: AtomicStore;
  readonly options: HostOptions;
  readonly provider: NonNullable<HostOptions['candidateProvider']>;
  readonly overlays = new Map<string, OverlayState>();
  readonly signals = new WeakSet<object>();
  /** Disposable, process-local numeric starting points. Never authority or knowledge. */
  readonly evaluations = new Map<
    string,
    {
      expires: number;
      values: Map<string, { atomId: string; value: number }>;
    }
  >();
  constructor(options: HostOptions) {
    if (['generator', 'historyRetentionMs', 'historyMaxAtoms'].some((key) => key in options))
      fail('INVALID_INPUT', 'Generation and history retention belong to the host application');
    for (const key of ['cacheMaxEntries', 'cacheTtlMs'] as const)
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! < 0))
        fail('INVALID_INPUT', `Invalid ${key}`);
    if ('ranking' in options || 'maxScan' in options)
      fail('INVALID_INPUT', 'Use activation and retrieval options');
    this.options = {
      ...options,
      activation: activationOptions(options.activation),
      retrieval: retrievalOptions(options.retrieval),
    };
    if (!options.authority) fail('INVALID_INPUT', 'A trusted authorizer is required');
    this.kernel = new AtomicStore({
      authority: options.authority!,
      storage: options.storage,
      limits: options.limits,
    });
    this.provider =
      options.candidateProvider ??
      (options.embedding ? new HybridCandidateProvider() : new LexicalCandidateProvider());
  }
  get storage() {
    return this.kernel.storage;
  }
  get tokenizer() {
    return this.options.tokenizer ?? utf8Tokenizer;
  }
  get embedding() {
    return this.options.embedding;
  }
  get legacyConfig() {
    return digest(
      canonical({
        provider: 'local-exact-lexical-vector-v1',
        representationVersion: 2,
        encoder: this.embedding?.id,
        dimensions: this.embedding?.dimensions,
        tokenizer: this.tokenizer.id,
      }),
    );
  }
  get indexConfig() {
    return digest(
      canonical({
        representationVersion: 3,
        encoder: this.embedding?.id,
        dimensions: this.embedding?.dimensions,
      }),
    );
  }
  /** Published 0.4 used neighbor-expanded text with this index identity. */
  get previousIndexConfig() {
    return digest(
      canonical({
        representationVersion: 2,
        encoder: this.embedding?.id,
        dimensions: this.embedding?.dimensions,
      }),
    );
  }
  get config() {
    const activation = activationOptions(this.options.activation);
    return digest(
      canonical({
        index: this.indexConfig,
        provider: this.provider.id,
        tokenizer: this.tokenizer.id,
        activation: {
          model: activation.model.id,
          maxBoost: activation.maxBoost,
          propagation: activation.propagation,
          relations: activation.relations,
        },
        retrieval: this.options.retrieval,
        version: 8,
      }),
    );
  }
  principal(binding: ClientBinding): Principal {
    const p = this.kernel.authority.resolve(binding.auth);
    if (binding.readPolicies?.some((id) => !p.readPolicies.includes(id))) fail('ACCESS_DENIED');
    return p;
  }
  policies(binding: ClientBinding, p: Principal): string[] {
    return [...new Set(binding.readPolicies ?? p.readPolicies)].sort();
  }
  session(
    binding: ClientBinding,
    options: OperationOptions = {},
    shared?: BudgetLedger,
    overlay?: OverlayState,
    at?: number,
    signalDigest = '',
  ): Session {
    if (this.storage.metaGet('purge:pending')) fail('ACCESS_DENIED', 'Erasure is incomplete');
    const p = this.principal(binding);
    const ledger = operationBudget(this.options.defaults ?? {}, options, shared);
    if (!this.storage.capabilities.snapshot) fail('CONSISTENCY_UNAVAILABLE');
    if (overlay && (!overlay.active || overlay.authBinding !== bindingKey(binding.auth)))
      fail('INVALID_REF');
    const state = at ?? overlay?.at ?? this.storage.watermark();
    return {
      binding,
      principal: p,
      at: state,
      overlay,
      ledger,
      signal: cancellation(ledger, options.signal),
      charged: new Set(),
      derived: 'unused',
      stale: new Set(),
      validated: new Map(),
      trace: {
        id: uid('trace'),
        at: state,
        authBinding: bindingKey(binding.auth),
        generation: p.generation,
        policies: this.policies(binding, p),
        signalDigest,
        reads: [],
        current: [],
        queries: [],
        createdAt: Date.now(),
        config: this.config,
      },
    };
  }
  check(s: Session): void {
    if (this.storage.metaGet('purge:pending')) fail('ACCESS_DENIED', 'Erasure is incomplete');
    if (s.signal.aborted) fail('ABORTED');
    if (s.ledger.expired) fail('BUDGET_EXHAUSTED');
    const current = this.principal(s.binding);
    if (current.generation !== s.principal.generation)
      fail('STATE_INVALIDATED', 'Authorization changed during operation');
    const epoch = this.storage.purgeGeneration?.();
    if (epoch === undefined || s.purgeEpoch !== epoch) {
      if (s.trace.reads.some((r) => this.storage.isPurged(r.atomId))) fail('ACCESS_DENIED');
      s.purgeEpoch = epoch;
    }
    if (s.overlay && !s.overlay.active) fail('INVALID_REF');
  }
  raw(ref: Ref, s: Session): AtomRevision | undefined {
    if (this.storage.isPurged(ref.atomId)) fail('ACCESS_DENIED');
    const staged = s.overlay?.revisions.get(ref.atomId);
    const r =
      staged && (ref.kind === 'logical' || staged.revisionId === ref.revisionId)
        ? {
            ...clone(staged.content),
            atomId: staged.atomId,
            revisionId: staged.revisionId,
            recordedAt: new Date().toISOString(),
            ...(staged.expectedHead ? { previousRevisionId: staged.expectedHead } : {}),
          }
        : this.storage.get(ref, s.at);
    if (
      r &&
      (!s.trace.policies.includes(r.policyId) || !s.principal.readPolicies.includes(r.policyId))
    )
      fail('ACCESS_DENIED');
    return r;
  }
  get(ref: Ref, s: Session, current = false, record = true): AtomRevision {
    this.check(s);
    const r = this.raw(ref, s) ?? fail('REFERENCE_UNAVAILABLE');
    if (!s.charged.has(r.revisionId)) {
      s.ledger.charge({ maxCandidates: 1, maxBytes: Buffer.byteLength(canonical(r)) });
      s.charged.add(r.revisionId);
    }
    if (record) this.record(r, s, current);
    return r;
  }
  /** Missing or unauthorized neighbors are opaque; session invalidation still fails. */
  neighbor(ref: Ref, s: Session, current = false): AtomRevision | undefined {
    this.check(s);
    try {
      return this.get(ref, s, current);
    } catch (error) {
      if (
        error instanceof AtomMemoryError &&
        ['ACCESS_DENIED', 'REFERENCE_UNAVAILABLE'].includes(error.code)
      )
        return;
      throw error;
    }
  }
  record(r: AtomRevision, s: Session, current = false): void {
    if (s.recording?.trace !== s.trace)
      s.recording = {
        trace: s.trace,
        reads: new Set(s.trace.reads.map((r) => r.revisionId)),
        current: new Set(s.trace.current.map((r) => r.revisionId)),
      };
    if (!s.recording.reads.has(r.revisionId)) {
      s.trace.reads.push(pinRevision(r));
      s.recording.reads.add(r.revisionId);
    }
    if (current && !s.recording.current.has(r.revisionId)) {
      s.trace.current.push(pinRevision(r));
      s.recording.current.add(r.revisionId);
    }
  }
  scan(query: ScanQuery, s: Session, observe = false): AtomRevision[] {
    this.check(s);
    let base = this.storage.scan(query, s.at);
    if (s.overlay) {
      // Fetch through replaced/retired rows so they cannot erase a later posting from a page.
      let after = query.after;
      const retained: AtomRevision[] = [];
      while (retained.length < query.limit) {
        const requested = query.limit - retained.length;
        const page = this.storage.scan({ ...query, after, limit: requested }, s.at);
        retained.push(...page.filter((r) => !s.overlay!.revisions.has(r.atomId)));
        if (page.length < requested || !page.length) break;
        after = page.at(-1)!.atomId;
        if (retained.length >= query.limit) break;
        s.ledger.charge({ maxCandidates: page.length });
      }
      const extra = [...s.overlay.revisions.values()]
        .map((p) => this.raw({ kind: 'pinned', atomId: p.atomId, revisionId: p.revisionId }, s)!)
        .filter((r) => {
          if (
            r.state !== 'active' ||
            !query.policies.includes(r.policyId) ||
            (query.after !== undefined && r.atomId <= query.after)
          )
            return false;
          if (
            query.relation &&
            !r.slots.some(
              (slot) =>
                slot.target.atomId === query.relation!.target.atomId &&
                (!query.relation!.role || slot.role === query.relation!.role),
            )
          )
            return false;
          return true;
        });
      base = [...retained, ...extra]
        .sort((a, b) => (a.atomId < b.atomId ? -1 : 1))
        .slice(0, query.limit);
    }
    if (observe) {
      const observed = s.overlay ? this.storage.scan(query, s.at) : base;
      s.trace.queries.push({ query: clone(query), revisions: observed.map((r) => r.revisionId) });
    }
    return base;
  }
  issue(r: AtomRevision, s: Session): AtomRef {
    const refKey = `sdk:ref-key:${digest(canonical([bindingKey(s.binding.auth), r.revisionId, s.overlay?.revisions.has(r.atomId) ? s.overlay.id : null]))}`;
    const existing = this.storage.metaGet<AtomRef>(refKey);
    if (existing && this.storage.metaGet(`sdk:ref:${existing}`)) return existing;
    const ref = uid('ref') as AtomRef;
    const overlay = s.overlay?.revisions.has(r.atomId) ? s.overlay.id : undefined;
    this.storage.metaSet(`sdk:ref:${ref}`, {
      target: pinRevision(r),
      at: s.at,
      authBinding: bindingKey(s.binding.auth),
      subject: s.principal.subject,
      policy: r.policyId,
      ...(overlay ? { overlay } : {}),
    } satisfies RefEntry);
    this.storage.metaSet(refKey, ref);
    if (overlay) s.overlay!.refs.add(ref);
    return ref;
  }
  resolve(ref: AtomRef, s: Session): RefEntry {
    if (typeof ref !== 'string') fail('INVALID_REF');
    const entry = this.storage.metaGet<RefEntry>(`sdk:ref:${ref}`);
    if (!entry) fail('INVALID_REF', 'Reference was not issued by this host');
    if (
      entry.authBinding !== bindingKey(s.binding.auth) ||
      entry.subject !== s.principal.subject ||
      !s.principal.readPolicies.includes(entry.policy) ||
      !s.trace.policies.includes(entry.policy)
    )
      fail('ACCESS_DENIED');
    if (this.storage.isPurged(entry.target.atomId)) fail('ACCESS_DENIED');
    if (entry.overlay && (s.overlay?.id !== entry.overlay || !s.overlay.active))
      fail('INVALID_REF', 'Tentative reference is outside its active edit');
    return entry;
  }
  view(r: AtomRevision, s: Session, current = false): AtomView {
    this.record(r, s, current);
    const links: AtomView['links'][number][] = [];
    for (const slot of r.slots) {
      const target = this.neighbor(slot.target, s, slot.target.kind === 'logical' && current);
      links.push({
        role: slot.role,
        ...(target ? { ref: this.issue(target, s) } : { unavailable: true as const }),
        at: slot.target.kind === 'logical' ? 'logical' : 'observed',
        required: slot.mode === 'include' || slot.required === true,
        ...(slot.orderKey ? { orderKey: slot.orderKey } : {}),
      });
    }
    const sources: AtomView['sources'][number][] = [];
    for (const o of r.origins) {
      const source = this.get(o.source, s);
      sources.push({ ref: this.issue(source, s), start: o.selector.start, end: o.selector.end });
    }
    if (r.provenance.kind === 'source' && !sources.length)
      sources.push({
        ref: this.issue(r, s),
        start: 0,
        end: r.body.kind === 'blob' ? r.body.bytes : Buffer.byteLength(this.text(r)),
      });
    return {
      ref: this.issue(r, s),
      text: r.body.kind === 'inline' ? textOf(r.body.value) : '',
      links,
      sources,
      provenance: { origin: r.provenance.kind, producer: r.provenance.producerId },
      state: r.state,
    };
  }
  text(r: AtomRevision): string {
    return r.body.kind === 'inline' ? textOf(r.body.value) : '';
  }
  indexedBody(r: AtomRevision): {
    text: string;
    vectors?: readonly (readonly number[])[];
  } {
    const text = this.text(r);
    const index = this.storage.metaGet<{
      config: string;
      hash: string;
      policyId: string;
      vectors?: readonly (readonly number[])[];
    }>(`sdk:index:${r.revisionId}`);
    return {
      text,
      ...(index?.config === this.indexConfig &&
      index.hash === digest(text) &&
      index.policyId === r.policyId &&
      index.vectors?.length
        ? { vectors: index.vectors }
        : {}),
    };
  }

  trace(s: Session): MemoryReceipt {
    this.check(s);
    if (s.trace.reads.length > this.kernel.limits.maxReadCandidates) fail('LIMIT_EXCEEDED');
    this.storage.metaSet(`sdk:manifest:${s.trace.id}`, this.traceManifest(s.trace, s.binding));
    if (s.overlay) s.overlay.traces.push(clone(s.trace));
    this.trimTransientMetadata();
    return {
      id: s.trace.id,
      state: `${this.storage.id}:${s.at}`,
      signalDigest: s.trace.signalDigest,
    };
  }
  trimTransientMetadata(): void {
    const manifests = this.storage.metaEntries<ReceiptManifest>('sdk:manifest:');
    const maximum = this.options.traceMaxEntries ?? 1024;
    for (let i = 0; i < manifests.length; i++) {
      const [key, m] = manifests[i]!;
      if (m.expiresAt < Date.now() || i < manifests.length - maximum) this.storage.metaDelete(key);
    }
    const traces = this.storage.metaUnbackedEntries
      ? this.storage.metaUnbackedEntries<Trace>('sdk:trace:', 'receipt:')
      : this.storage
          .metaEntries<Trace>('sdk:trace:')
          .filter(([, t]) => !this.storage.metaGet(`receipt:${t.id}`));
    const max = this.options.traceMaxEntries ?? 1024;
    for (let i = 0; i < traces.length; i++) {
      const [key, t] = traces[i]!;
      if (
        Date.now() - t.createdAt > (this.options.traceTtlMs ?? 3600000) ||
        i < traces.length - max
      ) {
        this.storage.metaDelete(key);
        this.storage.metaDelete(`sdk:manifest:${t.id}`);
      }
    }
    for (const [key, c] of this.storage.metaEntries<QueryState>('sdk:cursor:'))
      if (c.expires < Date.now()) this.storage.metaDelete(key);
  }
  async commit(
    request: WriteRequest,
    s: Session,
    hooks?: { validate?(): void; committed?(result: WriteResult): void },
  ): Promise<WriteResult> {
    const retries = this.options.commitRetries ?? 1;
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) fail('INVALID_INPUT');
    for (let attempt = 0; ; attempt++) {
      this.check(s);
      const receipts = [
        ...new Set(
          request.revisions
            .map((r) => r.content.provenance.inputReceiptId)
            .filter((v): v is string => !!v),
        ),
      ]
        .map((id) => this.storage.metaGet<ReceiptManifest>(`receipt:${id}`))
        .filter((m): m is ReceiptManifest => !!m);
      if (!this.storage.capabilities.queryGuards && receipts.some((m) => m.observations.length))
        fail('GUARD_VALIDATION_UNAVAILABLE');
      s.ledger.charge({
        maxCandidates:
          request.revisions.length +
          receipts.reduce(
            (n, m) =>
              n + m.reads.length + m.observations.reduce((v, o) => v + o.revisionIds.length + 1, 0),
            0,
          ),
        maxBytes:
          Buffer.byteLength(canonical(request)) +
          receipts.reduce((n, m) => n + Buffer.byteLength(canonical(m)), 0),
      });
      try {
        return await this.kernel.write(request, s.binding.auth, hooks);
      } catch (e) {
        if (!(e instanceof RetryableCommitError) || attempt >= retries) throw e;
      }
    }
  }
  traceManifest(trace: Trace, binding: ClientBinding, forceHistorical = false): ReceiptManifest {
    const p = this.principal(binding);
    const observations = trace.queries.map((q) => ({
      observationId: digest(canonical(q)),
      watermark: trace.at,
      query: q.query,
      revisionIds: q.revisions,
    }));
    return {
      contractVersion: 2,
      dependencyContract: 'legacy',
      receipt: {
        receiptId: trace.id,
      },
      subject: p.subject,
      authBinding: bindingKey(binding.auth),
      authorityGeneration: p.generation,
      policies: [...trace.policies],
      watermark: trace.at,
      reads: trace.reads,
      currentReads: forceHistorical ? [] : trace.current,
      historicalInputs: forceHistorical,
      observations: forceHistorical ? [] : observations,
      expiresAt: Date.now() + (this.options.traceTtlMs ?? 3600000),
      acquisition: {
        reads: trace.reads,
        ranges: [],
        observations,
        index: this.storage.metaGet<number>('sdk:index-generation') ?? 0,
      },
      watches: {
        reads: forceHistorical ? [] : trace.current,
        observations: forceHistorical ? [] : observations,
      },
    };
  }
  bridge(trace: Trace, binding: ClientBinding, historical = false): string {
    this.storage.metaSet(`receipt:${trace.id}`, this.traceManifest(trace, binding, historical));
    return trace.id;
  }
  merge(traces: readonly Trace[], binding: ClientBinding, at: number): Trace {
    const p = this.principal(binding);
    const policies = new Set<string>();
    const reads = new Map<string, PinnedRef>();
    const current = new Map<string, PinnedRef>();
    for (const t of traces) {
      if (t.authBinding !== bindingKey(binding.auth) || t.generation !== p.generation)
        fail('STATE_INVALIDATED');
      t.policies.forEach((x) => policies.add(x));
      t.reads.forEach((r) => reads.set(r.revisionId, r));
      t.current.forEach((r) => current.set(r.revisionId, r));
    }
    return {
      id: uid('trace'),
      at,
      authBinding: bindingKey(binding.auth),
      generation: p.generation,
      policies: [...policies],
      reads: [...reads.values()],
      current: [...current.values()],
      queries: traces.flatMap((t) => t.queries),
      createdAt: Date.now(),
      config: this.config,
      signalDigest: digest(canonical(traces.map((t) => t.signalDigest))),
    };
  }
  auditCurrent(trace: Trace, s: Session): void {
    if (
      trace.authBinding !== bindingKey(s.binding.auth) ||
      trace.generation !== s.principal.generation
    )
      fail('STATE_INVALIDATED');
    for (const ref of trace.reads) this.get(ref, s, false, false);
  }
  async signalsFor(
    state: MemoryState,
    s: Session,
  ): Promise<{
    texts: string[];
    vectors: readonly (readonly number[])[];
    signals: RetrievalSignal[];
    digest: string;
  }> {
    const signals: RetrievalSignal[] = [
      ...(['query', 'context', 'thought'] as const).flatMap((kind) =>
        state[kind]?.trim() ? [{ kind, text: state[kind] }] : [],
      ),
      ...[...new Set(state.observations ?? [])]
        .filter((text) => text.trim())
        .map((text) => ({ kind: 'observations' as const, text })),
    ];
    const texts = signals.map((signal) => signal.text!);
    if (!texts.length && !state.signal)
      fail('INVALID_INPUT', 'read needs context, query, observations or a compatible host signal');
    if (Buffer.byteLength(canonical(texts)) > this.kernel.limits.maxWriteBytes)
      fail('LIMIT_EXCEEDED');
    const vectors: (readonly number[])[] = [];
    if (state.signal) {
      const e = this.embedding;
      if (
        !e ||
        !this.signals.has(state.signal) ||
        state.signal.encoderId !== e.id ||
        state.signal.dimensions !== e.dimensions ||
        state.signal.transformId !== 'identity' ||
        state.signal.inputKind !== 'text'
      )
        fail('MODEL_SPACE_MISMATCH');
      vectors.push(state.signal.values);
    }
    if (this.embedding && texts.length) {
      const encoded = await this.embed(texts, s);
      for (let i = 0; i < signals.length; i++) signals[i] = { ...signals[i]!, vector: encoded[i]! };
      vectors.push(...encoded);
    }
    if (state.signal) signals.push({ kind: 'signal', vector: state.signal.values });
    return {
      texts,
      vectors,
      signals,
      digest: digest(canonical({ texts, signal: state.signal, config: this.config })),
    };
  }
  async embed(
    texts: readonly string[],
    s: Session,
    purpose: 'query' | 'document' = 'query',
  ): Promise<readonly (readonly number[])[]> {
    const e = this.embedding ?? fail('INDEX_NOT_READY');
    const output: (readonly number[])[] = [];
    const missing = new Map<string, { text: string; positions: number[] }>();
    for (const [position, text] of texts.entries()) {
      this.check(s);
      const key = `sdk:cache:vector:${digest(canonical([bindingKey(s.binding.auth), s.principal.generation, s.trace.policies, e.id, e.dimensions, purpose, text]))}`;
      const cached = this.storage.metaGet<{ vector: number[]; until: number }>(key);
      if (cached && cached.until > Date.now()) output[position] = cached.vector;
      else {
        const entry = missing.get(key) ?? { text, positions: [] };
        entry.positions.push(position);
        missing.set(key, entry);
      }
    }
    if (missing.size) {
      const entries = [...missing.entries()];
      s.ledger.charge({
        maxModelCalls: 1,
        maxNetworkCalls: e.networkCallsPerCall,
        maxModelInputTokens: entries.reduce(
          (sum, [, entry]) => sum + e.tokenizer.count(entry.text),
          0,
        ),
      });
      const result = await cancellable(
        (signal) =>
          e.embed(
            entries.map(([, entry]) => entry.text),
            signal,
            purpose,
          ),
        s.signal,
      );
      this.check(s);
      if (
        result.length !== entries.length ||
        result.some(
          (vector) => vector.length !== e.dimensions || vector.some((n) => !Number.isFinite(n)),
        )
      )
        fail('MODEL_SPACE_MISMATCH');
      entries.forEach(([key, entry], i) => {
        const vector = result[i]!;
        entry.positions.forEach((position) => {
          output[position] = vector;
        });
        this.storage.metaSet(key, {
          vector,
          until: Date.now() + (this.options.cacheTtlMs ?? 300000),
        });
      });
    }
    this.trimCaches();
    return output;
  }
  trimCaches(): void {
    const entries = this.storage.metaEntries<{ until?: number }>('sdk:cache:');
    for (const [key, value] of entries)
      if ((value.until ?? 0) < Date.now()) this.storage.metaDelete(key);
    const remaining = this.storage.metaEntries('sdk:cache:');
    for (const [key] of remaining.slice(
      0,
      Math.max(0, remaining.length - (this.options.cacheMaxEntries ?? 512)),
    ))
      this.storage.metaDelete(key);
  }
  async candidates(
    state: MemoryState,
    s: Session,
    after?: string,
    maxScan = this.options.retrieval!.maxScan!,
  ): Promise<{
    candidates: Candidate[];
    scanned: number;
    complete: boolean;
    pending: boolean;
    approximate: boolean;
    signalDigest: string;
    signals: readonly RetrievalSignal[];
    after?: string;
  }> {
    const signals = await this.signalsFor(state, s);
    s.trace = { ...s.trace, signalDigest: signals.digest };
    const result = await this.provider.retrieve({
      texts: signals.texts,
      vectors: signals.vectors,
      signals: signals.signals,
      maxScan,
      after,
      ledger: s.ledger,
      signal: s.signal,
      access: {
        ...(this.storage.vectorCandidates
          ? {
              vectorCandidates: (vectors: readonly (readonly number[])[], limit: number) => {
                this.check(s);
                const revisions = this.storage.vectorCandidates!(
                  { policies: s.trace.policies, config: this.indexConfig, vectors, limit },
                  s.at,
                );
                for (const r of revisions) this.get(pinRevision(r), s);
                return revisions;
              },
            }
          : {}),
        page: (after, limit, filter) => {
          const revisions = this.scan(
            {
              policies: [...s.trace.policies],
              after,
              limit,
              ...(filter ? { text: [...filter.text] } : {}),
            },
            s,
            true,
          );
          for (const r of revisions) this.get(pinRevision(r), s);
          return revisions;
        },
        representation: (r) => this.indexedBody(this.get(pinRevision(r), s)),
      },
    });
    this.check(s);
    if (!Array.isArray(result.candidates) || result.candidates.length > maxScan)
      fail('INVALID_INPUT', 'Candidate provider exceeded the acquisition bound');
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let exhausted = false;
    let pending = result.pending;
    for (const ref of result.candidates) {
      if (
        !ref ||
        ref.kind !== 'pinned' ||
        typeof ref.atomId !== 'string' ||
        typeof ref.revisionId !== 'string'
      )
        fail('INVALID_INPUT', 'Candidate providers return pinned references, not scores or bodies');
      if (seen.has(ref.revisionId)) continue;
      seen.add(ref.revisionId);
      try {
        // Always reread the authoritative snapshot. Provider data never sets a score.
        const revision = this.get(ref, s, false, false);
        const current = this.raw({ kind: 'logical', atomId: revision.atomId }, s);
        if (revision.state !== 'active' || current?.revisionId !== revision.revisionId) continue;
        const body = this.indexedBody(revision);
        pending ||= !!this.embedding && !body.vectors;
        const score = seedScore(body.text, body.vectors, signals.signals);
        if (score > 0) candidates.push({ revision, score });
      } catch (error) {
        if (!(error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED')) throw error;
        exhausted = true;
        break;
      }
    }
    return {
      ...result,
      candidates,
      complete: result.complete && !exhausted,
      approximate: result.approximate || exhausted,
      signalDigest: signals.digest,
      signals: signals.signals,
      pending,
    };
  }

  saveCursor(state: Omit<QueryState, 'id' | 'expires'>): string {
    const id = uid('cursor');
    this.storage.metaSet(`sdk:cursor:${id}`, {
      ...state,
      id,
      expires: Date.now() + (this.options.cursorTtlMs ?? 300000),
    } satisfies QueryState);
    return id;
  }
  cursor(
    id: string,
    binding: ClientBinding,
    kind: QueryState['kind'],
    signalDigest: string,
    overlay?: OverlayState,
  ): QueryState {
    const cursor = this.storage.metaGet<QueryState>(`sdk:cursor:${id}`);
    const p = this.principal(binding);
    if (
      !cursor ||
      cursor.expires < Date.now() ||
      cursor.kind !== kind ||
      cursor.signalDigest !== signalDigest ||
      cursor.config !== this.config ||
      cursor.index !== (this.storage.metaGet<number>('sdk:index-generation') ?? 0)
    )
      fail('CURSOR_EXPIRED');
    if (cursor.binding !== bindingKey(binding.auth) || cursor.generation !== p.generation)
      fail('ACCESS_DENIED');
    if (cursor.overlay !== overlay?.id || (overlay && !overlay.active)) fail('CURSOR_EXPIRED');
    if (cursor.trace.reads.some((r) => this.storage.isPurged(r.atomId))) fail('ACCESS_DENIED');
    return cursor;
  }
  async prepare(
    binding: ClientBinding,
    options: OperationOptions = {},
    shared?: BudgetLedger,
  ): Promise<{ indexed: number; pending: boolean; cursor?: string }> {
    if (!this.embedding) fail('INDEX_NOT_READY', 'No embedding provider is configured');
    const saved = options.cursor
      ? this.cursor(options.cursor, binding, 'index', this.config)
      : undefined;
    const s = this.session(binding, options, shared, undefined, saved?.at, this.config);
    let after = saved?.scanAfter;
    let indexed = 0;
    let processed = 0;
    let complete = false;
    const limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('INVALID_INPUT');
    while (processed < limit) {
      const count = Math.min(64, limit - processed);
      const page = this.scan({ policies: [...s.trace.policies], after, limit: count }, s);
      for (const r of page) {
        indexed += await indexRevision(this, r, s);
        processed++;
        after = r.atomId;
      }
      if (page.length < count) {
        complete = true;
        break;
      }
    }
    const cursor = complete
      ? undefined
      : this.saveCursor({
          kind: 'index',
          binding: bindingKey(binding.auth),
          generation: s.principal.generation,
          at: s.at,
          signalDigest: this.config,
          index: this.storage.metaGet<number>('sdk:index-generation') ?? 0,
          config: this.config,
          candidates: [],
          offset: 0,
          complete: false,
          scanned: processed,
          pending: true,
          approximate: false,
          trace: s.trace,
          scanAfter: after,
        });
    return { indexed, pending: !complete, ...(cursor ? { cursor } : {}) };
  }
  diagnostics(scanned = 0, complete = true, pending = false): Diagnostics {
    return {
      method: this.provider.id,
      traversal: complete ? 'complete' : 'partial',
      approximate: !complete,
      scanned,
      index: pending ? 'pending' : 'ready',
      derived: 'unused',
      stop: complete ? 'completed' : 'budget',
      coverageCertified: false,
    };
  }
}
