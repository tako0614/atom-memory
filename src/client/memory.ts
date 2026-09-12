import type { Trace } from './internal.js';
import { collectRanking, finishRanking, startRanking } from './ranking.js';
import { updateIndex, indexRevision } from './indexing.js';
import type {
  AtomContent,
  AtomRevision,
  Origin,
  PinnedRef,
  ProposedRevision,
  Slot,
} from '../contracts.js';
import { BudgetLedger } from '../core/budget.js';
import { canonical, clone, digest, fail, uid, AtomMemoryError } from '../core/util.js';
import { validateContent } from '../core/validation.js';
import type {
  AtomRef,
  AtomView,
  ClientBinding,
  Draft,
  EditOptions,
  EditOutcome,
  HostOptions,
  Inspection,
  InspectOptions,
  LinkTarget,
  MemoryAPI,
  MemoryContent,
  MemoryPage,
  MemoryReceipt,
  MemoryState,
  OperationOptions,
  ReadOptions,
  RecallResult,
  SearchOptions,
  SearchSignal,
  WriteOptions,
  WriteOutcome,
  Candidate,
} from './types.js';
import {
  Engine,
  bindingKey,
  pinRevision,
  type OverlayState,
  type QueryState,
  type Session,
} from './engine.js';
import { graph, graphPage, validateMemory, pack } from './retrieval.js';
import { positive, cancellable } from './control.js';
interface Retrieval {
  s: Session;
  state: QueryState;
}
export interface ExecutionScope {
  ledger: BudgetLedger;
  traces?: Trace[];
}
export class MemoryHost {
  private readonly engine: Engine;
  constructor(options: HostOptions) {
    this.engine = new Engine(options);
  }
  connect(binding: ClientBinding): MemoryClient {
    this.engine.principal(binding);
    return new MemoryClient(this.engine, clone(binding));
  }
  reference(ref: PinnedRef, binding: ClientBinding): AtomRef {
    const s = this.engine.session(binding);
    return this.engine.issue(this.engine.get(ref, s), s);
  }
  signal(
    values: readonly number[],
    metadata?: Partial<Omit<SearchSignal, 'values'>>,
  ): SearchSignal {
    const e = this.engine.embedding ?? fail('MODEL_SPACE_MISMATCH');
    const signal: SearchSignal = {
      encoderId: e.id,
      dimensions: e.dimensions,
      transformId: 'identity',
      inputKind: 'text',
      ...metadata,
      values: Object.freeze([...values]),
    };
    if (
      signal.encoderId !== e.id ||
      signal.dimensions !== e.dimensions ||
      signal.values.length !== e.dimensions ||
      signal.values.some((n) => !Number.isFinite(n)) ||
      signal.inputKind !== 'text' ||
      signal.transformId !== 'identity'
    )
      fail('MODEL_SPACE_MISMATCH', 'Signal must use this text encoder and the identity transform');
    this.engine.signals.add(signal);
    return Object.freeze(signal);
  }
  prepareIndex(binding: ClientBinding, options?: OperationOptions) {
    return this.engine.prepare(binding, options);
  }
  /** Drain committed changes and affected representations, resuming after restart. */
  updateIndex(binding: ClientBinding, options?: OperationOptions) {
    return updateIndex(this.engine, binding, options);
  }
  /** Prioritize a finite set of observed revisions, e.g. a just-committed edit. */
  async indexAtoms(
    refs: readonly AtomRef[],
    binding: ClientBinding,
    options: OperationOptions = {},
  ) {
    const limit = options.limit ?? 256;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || options.cursor)
      fail('INVALID_INPUT');
    if (refs.length > limit) fail('LIMIT_EXCEEDED');
    const s = this.engine.session(binding, options);
    let indexed = 0;
    for (const ref of new Set(refs)) {
      const r = this.engine.get(this.engine.resolve(ref, s).target, s);
      if (r.state === 'active') indexed += await indexRevision(this.engine, r, s);
    }
    return { indexed };
  }
  async ingestBlob(
    bytes: Uint8Array,
    mediaType: string,
    binding: ClientBinding,
  ): Promise<WriteOutcome> {
    if (binding.actor.type === 'agent') fail('ACCESS_DENIED');
    const body = this.engine.kernel.putBlob(bytes, binding.writePolicy, mediaType, binding.auth);
    return this.connect(binding).hostWriteBody(body);
  }
  purge(atomId: string) {
    return this.engine.kernel.purge(atomId);
  }
}
export function createMemory(options: HostOptions & ClientBinding): MemoryClient {
  return new MemoryHost(options).connect(options);
}
export class MemoryClient implements MemoryAPI {
  constructor(
    private readonly engine: Engine,
    private readonly binding: ClientBinding,
    private readonly execution?: ExecutionScope,
    private readonly overlay?: OverlayState,
  ) {}
  /** Share a host-owned memory budget and observed inputs across operations. No model loop runs here. */
  forExecution(scope: ExecutionScope): MemoryClient {
    return new MemoryClient(this.engine, this.binding, scope, this.overlay);
  }
  assertAuthorized(receipts: readonly MemoryReceipt[] = []): void {
    const s = this.engine.session(this.binding, {}, this.execution?.ledger, this.overlay);
    for (const receipt of receipts) {
      const trace = this.engine.storage.metaGet<Trace>(`sdk:trace:${receipt.id}`);
      if (!trace) fail('STATE_INVALIDATED');
      this.engine.auditCurrent(trace, s);
    }
  }
  private finish(s: Session): MemoryReceipt {
    const receipt = this.engine.trace(s);
    this.execution?.traces?.push(clone(s.trace));
    return receipt;
  }
  private key(kind: string, value: unknown, options: Record<string, unknown> = {}): string {
    return digest(canonical({ kind, value, options, config: this.engine.config }));
  }
  private async retrieve(
    kind: 'read' | 'search',
    state: MemoryState,
    options: SearchOptions,
    key: string,
  ): Promise<Retrieval> {
    if ('historical' in options)
      fail('INVALID_INPUT', 'Inspect an observed revision for historical content');
    let saved: QueryState | undefined;
    if (options.cursor)
      saved = this.engine.cursor(options.cursor, this.binding, kind, key, this.overlay);
    const s = this.engine.session(
      this.binding,
      options,
      this.execution?.ledger,
      this.overlay,
      saved?.at,
      key,
    );
    if (saved) {
      s.trace = { ...clone(saved.trace), id: uid('trace') };
      return { s, state: saved };
    }
    const q: QueryState = {
      id: uid('query'),
      kind,
      binding: bindingKey(this.binding.auth),
      generation: s.principal.generation,
      at: s.at,
      signalDigest: key,
      index: this.engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
      config: this.engine.config,
      expires: Date.now() + 300000,
      overlay: this.overlay?.id,
      candidates: [],
      offset: 0,
      complete: false,
      scanned: 0,
      pending: false,
      approximate: false,
      trace: s.trace,
    };
    const maximum = this.engine.options.maxScan ?? 10000;
    // Leave resources for relation acquisition and returning memory in this call.
    // A finite acquisition is frozen before pagination; it never scans the full
    // corpus by repeatedly returning empty pages to an automatic caller.
    const ledger = s.ledger;
    s.ledger = ledger.window({
      maxCandidates: Math.max(1, Math.floor(ledger.remaining('maxCandidates') / 2)),
      maxBytes: Math.floor(ledger.remaining('maxBytes') / 2),
    });
    let found;
    try {
      found = await this.engine.candidates(state, s, undefined, maximum);
    } finally {
      s.ledger = ledger;
    }
    if (!found.complete && found.scanned === 0 && found.after === undefined)
      fail('BUDGET_EXHAUSTED', 'Candidate cannot advance: increase byte or candidate budget');
    const seen = new Map<string, Candidate>();
    for (const candidate of found.candidates) {
      let r = candidate.revision;
      const prior = seen.get(r.revisionId);
      if (!prior || prior.score < candidate.score)
        seen.set(r.revisionId, { ...candidate, revision: r });
    }
    const seeds = [...seen.values()].sort(
      (a, b) => b.score - a.score || a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
    );
    const maxSeeds = this.engine.options.ranking!.maxSeeds!;
    q.approximate ||= seeds.length > maxSeeds || found.approximate;
    q.scanned = found.scanned;
    q.pending ||= found.pending;
    q.approximate ||= !found.complete;
    let ranking: ReturnType<typeof startRanking>;
    s.ledger = ledger.window({
      maxCandidates: Math.floor(ledger.remaining('maxCandidates') / 2),
      maxBytes: Math.floor(ledger.remaining('maxBytes') / 2),
    });
    try {
      const eligible: Candidate[] = [];
      let exhausted = false;
      // Invalid memories cannot lend relevance to otherwise current neighbors.
      // Rejected candidates do not consume seed slots. Evidence checks remain
      // bounded by the finite candidate pool and graph acquisition budget.
      for (const candidate of seeds) {
        if (eligible.length >= maxSeeds) break;
        try {
          if (validateMemory(this.engine, candidate.revision, s)) eligible.push(candidate);
        } catch (error) {
          if (!(error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED')) throw error;
          if (!eligible.length) throw error;
          exhausted = true;
          break;
        }
      }
      ranking = startRanking(
        eligible,
        options.depth ?? this.engine.options.ranking!.depth!,
        this.engine.options.ranking,
      );
      ranking.truncated ||= exhausted;
      if (!collectRanking(this.engine, s, ranking)) ranking.truncated = true;
    } finally {
      s.ledger = ledger;
    }
    q.candidates = finishRanking(this.engine, s, ranking);
    q.approximate ||= ranking.truncated || ranking.depth > 0;
    q.complete = true;
    return { s, state: q };
  }
  async search(query: string, options: SearchOptions = {}): Promise<MemoryPage> {
    if (typeof query !== 'string' || !query.trim())
      fail('INVALID_INPUT', 'Search query must not be empty');
    const limit = positive(options.limit, 10);
    const depth = options.depth ?? this.engine.options.ranking!.depth!;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
    const key = this.key('search', query, { depth });
    const { s, state } = await this.retrieve('search', { query }, options, key);
    const initialOffset = state.offset;
    const items: MemoryPage['items'][number][] = [];
    while (state.offset < state.candidates.length && items.length < limit) {
      const candidate = state.candidates[state.offset]!;
      try {
        if (!validateMemory(this.engine, candidate.revision, s)) {
          state.offset++;
          continue;
        }
        if (!s.ledger.can({ maxAtoms: 1 })) break;
        const view = this.engine.view(candidate.revision, s, true);
        s.ledger.charge({ maxAtoms: 1 });
        items.push({ ...view, score: candidate.score, scoreBreakdown: candidate.scoreBreakdown });
        state.offset++;
      } catch (error) {
        if (error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED') break;
        throw error;
      }
    }
    if (!items.length && state.offset === initialOffset && state.offset < state.candidates.length)
      fail('BUDGET_EXHAUSTED', 'Search cannot advance with this budget');
    const receipt = this.finish(s);
    const more = state.offset < state.candidates.length || !state.complete;
    const cursor = more ? this.engine.saveCursor({ ...state, trace: s.trace }) : undefined;
    return {
      items,
      stale: [...s.stale],
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(state.scanned, !more, state.pending),
        approximate: state.approximate,
        derived: s.pendingDerived ? 'pending' : s.derived,
        ...(s.derivedReason ? { derivedReason: s.derivedReason } : {}),
        stop: more ? 'page-limit' : 'completed',
      },
      usage: s.ledger.usage(),
    };
  }
  async read(input: MemoryState, options: ReadOptions = {}): Promise<RecallResult> {
    if (!input || typeof input !== 'object') fail('INVALID_INPUT');
    const limit = positive(options.limit, 24);
    const tokens = positive(options.tokens, 4096, 1000000);
    const depth = options.depth ?? this.engine.options.ranking!.depth!;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
    const key = this.key('read', input, { depth });
    const { s, state } = await this.retrieve(
      'read',
      input,
      { ...options, budget: { maxContextTokens: tokens, ...options.budget } },
      key,
    );
    const seeds = state.candidates.slice(state.offset);
    const packed = await pack(
      this.engine,
      s,
      seeds,
      Math.min(tokens, s.ledger.remaining('maxContextTokens')),
      limit,
    );
    const receipt = this.finish(s);
    const more = packed.deferred.length > 0 || !state.complete;
    const cursor = more
      ? this.engine.saveCursor({
          ...state,
          candidates: packed.deferred,
          offset: 0,
          trace: s.trace,
        })
      : undefined;
    return {
      items: packed.items,
      stale: [...s.stale],
      text: packed.text,
      refs: packed.items.map((i) => i.ref),
      sources: packed.sources,
      tokenCount: packed.tokenCount,
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(state.scanned, !more, state.pending),
        approximate: state.approximate,
        derived: s.pendingDerived ? 'pending' : s.derived,
        ...(s.derivedReason ? { derivedReason: s.derivedReason } : {}),
        stop: more ? 'budget' : 'completed',
        ...(packed.minimumTokens ? { minimumTokens: packed.minimumTokens } : {}),
      },
      usage: s.ledger.usage(),
    };
  }
  async inspect(ref: AtomRef, options: InspectOptions = {}): Promise<Inspection> {
    if (['history', 'successor', 'composition'].some((key) => key in options))
      fail('INVALID_INPUT', 'Use revisions and ordinary links; history policy belongs to the host');
    const limit = positive(options.limit, 20);
    const depth = options.depth ?? 1;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
    const key = this.key('inspect', ref, {
      depth,
      version: options.version ?? 'observed',
      rangeStart: options.range?.start,
    });
    const saved = options.cursor
      ? this.engine.cursor(options.cursor, this.binding, 'inspect', key, this.overlay)
      : undefined;
    let s = this.engine.session(
      this.binding,
      options,
      this.execution?.ledger,
      this.overlay,
      saved?.at,
      key,
    );
    const entry = this.engine.resolve(ref, s);
    let root = entry.target;
    if (options.version === 'latest')
      root = pinRevision(this.engine.get({ kind: 'logical', atomId: root.atomId }, s, true));
    if (saved) s.trace = { ...clone(saved.trace), id: uid('trace') };
    const r = this.engine.get(root, s, options.version === 'latest');
    const atom = this.engine.view(r, s, options.version === 'latest');
    if (r.body.kind === 'blob' || options.range)
      return this.blobInspection(r, atom, s, options, key, saved);
    const graphState = saved?.graph ?? graph(root, depth);
    const { revisions, complete } = graphPage(this.engine, s, graphState, limit);
    if (!complete && !revisions.length)
      fail('BUDGET_EXHAUSTED', 'Adjacency cannot advance with this budget');
    s.ledger.charge({ maxAtoms: revisions.length });
    const items = revisions.map((v) => this.engine.view(v, s, options.version === 'latest'));
    const receipt = this.finish(s);
    const cursor = !complete
      ? this.engine.saveCursor({
          kind: 'inspect',
          binding: bindingKey(this.binding.auth),
          generation: s.principal.generation,
          at: s.at,
          signalDigest: key,
          index: this.engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
          config: this.engine.config,
          overlay: this.overlay?.id,
          candidates: [],
          offset: 0,
          complete,
          scanned: s.ledger.usage().maxCandidates,
          pending: false,
          approximate: false,
          trace: s.trace,
          graph: graphState,
          root,
        })
      : undefined;
    return {
      atom,
      items,
      stale: [...s.stale],
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(s.ledger.usage().maxCandidates, complete),
        stop: complete ? 'completed' : 'page-limit',
      },
      usage: s.ledger.usage(),
    };
  }
  private blobInspection(
    r: AtomRevision,
    atom: AtomView,
    s: Session,
    options: InspectOptions,
    key: string,
    saved?: QueryState,
  ): Inspection {
    const total = r.body.kind === 'blob' ? r.body.bytes : Buffer.byteLength(this.engine.text(r));
    const start = saved?.blobOffset ?? options.range?.start ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > total) fail('INVALID_SOURCE_SPAN');
    const requested = positive(options.range?.bytes, 4096, 1024 * 1024);
    const length = Math.min(requested, total - start, s.ledger.remaining('maxBytes'));
    const bytes =
      r.body.kind === 'blob'
        ? this.engine.storage.blobRange?.(r.body.blobId, start, length)
        : Buffer.from(this.engine.text(r)).subarray(start, start + length);
    if (!bytes)
      fail('REFERENCE_UNAVAILABLE', 'Storage does not implement bounded blob range reads');
    const mediaType = r.body.kind === 'blob' ? r.body.mediaType : 'text/plain';
    const textual = mediaType.startsWith('text/') || /json|xml/.test(mediaType);
    let part = bytes;
    let text: string | undefined;
    let minimumBytes: number | undefined;
    if (textual) {
      if (part.length && (part[0]! & 0xc0) === 0x80) fail('INVALID_SOURCE_SPAN');
      for (let trim = 0; trim <= 3 && trim <= bytes.length; trim++) {
        try {
          part = bytes.subarray(0, bytes.length - trim);
          text = new TextDecoder('utf-8', { fatal: true }).decode(part);
          break;
        } catch {
          if (trim === 3) fail('INVALID_SOURCE_SPAN');
        }
      }
      if (!part.length && start < total) minimumBytes = 4;
    }
    s.ledger.charge({ maxBytes: part.length, maxAtoms: 1 });
    const end = start + part.length;
    const complete = end >= total;
    const receipt = this.finish(s);
    const cursor = !complete
      ? this.engine.saveCursor({
          kind: 'inspect',
          binding: bindingKey(this.binding.auth),
          generation: s.principal.generation,
          at: s.at,
          signalDigest: key,
          index: this.engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
          config: this.engine.config,
          overlay: this.overlay?.id,
          candidates: [],
          offset: 0,
          complete,
          scanned: 1,
          pending: false,
          approximate: false,
          trace: s.trace,
          root: pinRevision(r),
          blobOffset: end,
        })
      : undefined;
    return {
      atom: { ...atom, text: text ?? '' },
      items: [{ ...atom, text: text ?? '' }],
      stale: [],
      range: {
        start,
        end,
        totalBytes: total,
        mediaType,
        ...(text !== undefined ? { text } : { base64: Buffer.from(part).toString('base64') }),
      },
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(1, complete),
        stop: complete ? 'completed' : 'page-limit',
        ...(minimumBytes ? { minimumBytes } : {}),
      },
      usage: s.ledger.usage(),
    };
  }
  private content(
    input: MemoryContent,
    s: Session,
    options: WriteOptions = {},
    body?: AtomContent['body'],
  ): AtomContent {
    const value = typeof input === 'string' ? { text: input } : input;
    if (!value || typeof value.text !== 'string') fail('INVALID_INPUT');
    if (Object.keys(value).some((k) => !['text', 'links'].includes(k)))
      fail('INVALID_INPUT', 'Content cannot set IDs, provenance or authorization');
    if (Buffer.byteLength(value.text) > this.engine.kernel.limits.maxAtomBytes)
      fail('LIMIT_EXCEEDED');
    const links = value.links;
    const slots: Slot[] = [];
    const add = (role: string, target: LinkTarget) => {
      if (typeof role !== 'string' || !role.length) fail('INVALID_INPUT');
      const spec = typeof target === 'string' ? { ref: target } : target;
      if (!spec || !['logical', 'observed', undefined].includes(spec.at)) fail('INVALID_INPUT');
      const entry = this.engine.resolve(spec.ref, s);
      const observed = this.engine.get(entry.target, s, false);
      this.engine.record(
        observed,
        s,
        this.binding.actor.type === 'agent' && spec.at !== 'observed',
      );
      slots.push({
        role,
        mode: 'refer',
        target:
          spec.at === 'observed' ? entry.target : { kind: 'logical', atomId: entry.target.atomId },
        required: spec.required === true,
        orderKey: spec.orderKey ?? String(slots.length),
      });
    };
    if (Array.isArray(links)) {
      for (const link of links) add(link.role, link.target);
    } else if (links) {
      for (const [role, targets] of Object.entries(links)) {
        if (Array.isArray(targets)) for (const target of targets) add(role, target);
        else add(role, targets as LinkTarget);
      }
    }
    const origins: Origin[] = [];
    for (const citation of options.sources ?? []) {
      const entry = this.engine.resolve(citation.ref, s);
      const source = this.engine.get(entry.target, s, this.binding.actor.type === 'agent');
      const start = citation.start ?? 0;
      const end =
        citation.end ??
        (source.body.kind === 'blob'
          ? source.body.bytes
          : Buffer.byteLength(this.engine.text(source)));
      const bytes =
        source.body.kind === 'blob'
          ? this.engine.storage.blobRange?.(source.body.blobId, start, end - start)
          : Buffer.from(this.engine.text(source)).subarray(start, end);
      if (!bytes) fail('REFERENCE_UNAVAILABLE');
      s.ledger.charge({ maxBytes: bytes.length });
      origins.push({
        source: entry.target,
        selector: { kind: 'utf8', start, end, quoteDigest: digest(bytes) },
      });
    }
    const generated = this.binding.actor.type === 'agent';
    const kind = generated ? (this.binding.actor.generatedOrigin ?? 'derived') : 'source';
    const content: AtomContent = {
      schema: kind === 'source' ? 'source' : 'atom',
      state: 'active',
      body: body ?? { kind: 'inline', value: value.text },
      slots,
      origins,
      provenance: {
        kind,
        producerId: s.principal.subject,
        ...(generated ? { inputReceiptId: s.trace.id } : {}),
      },
      policyId: this.binding.writePolicy,
    };
    s.trace = {
      ...s.trace,
      policies: [
        ...new Set([
          this.binding.writePolicy,
          ...s.trace.reads.map(
            (ref) => this.engine.raw(ref, s)?.policyId ?? fail('REFERENCE_UNAVAILABLE'),
          ),
        ]),
      ],
    };
    validateContent(content, s.principal, this.engine.kernel.limits, generated);
    return content;
  }
  async hostWriteBody(body: AtomContent['body']): Promise<WriteOutcome> {
    return this.writeInternal('', {}, body);
  }
  async write(input: MemoryContent, options: WriteOptions = {}): Promise<WriteOutcome> {
    return this.writeInternal(input, options);
  }
  private async writeInternal(
    input: MemoryContent,
    options: WriteOptions,
    body?: AtomContent['body'],
  ): Promise<WriteOutcome> {
    if (this.overlay) {
      const view = await this.stageWrite(input, options, body);
      return {
        ...view,
        operationId: this.overlay.id,
        repeated: false,
        indexing: this.engine.embedding ? 'pending' : 'ready',
      };
    }
    const s = this.engine.session(this.binding, { signal: options.signal }, this.execution?.ledger);
    const signature = digest(canonical({ input, sources: options.sources, body }));
    const opKey = options.idempotencyKey
      ? `sdk:operation:${digest(canonical([s.principal.subject, options.idempotencyKey]))}`
      : undefined;
    const old = opKey
      ? this.engine.storage.metaGet<{ signature: string; ref: AtomRef; operationId: string }>(opKey)
      : undefined;
    if (old) {
      if (old.signature !== signature) fail('IDEMPOTENCY_CONFLICT');
      const entry = this.engine.resolve(old.ref, s);
      const r = this.engine.get(entry.target, s);
      if (!s.principal.writePolicies.includes(r.policyId)) fail('ACCESS_DENIED');
      return {
        ...this.engine.view(r, s),
        ref: old.ref,
        operationId: old.operationId,
        repeated: true,
        indexing: this.engine.embedding ? 'pending' : 'ready',
      };
    }
    const content = this.content(input, s, options, body);
    const traces = [...(this.execution?.traces ?? []), s.trace];
    const combined = this.engine.merge(traces, this.binding, s.at);
    if (!combined.policies.length) (combined.policies as string[]).push(this.binding.writePolicy);
    this.engine.storage.metaSet(`sdk:trace:${combined.id}`, combined);
    this.engine.bridge(combined, this.binding, this.binding.actor.type !== 'agent');
    const withProvenance = {
      ...content,
      provenance: { ...content.provenance, inputReceiptId: combined.id },
    };
    const proposal: ProposedRevision = {
      atomId: uid('atom'),
      revisionId: uid('revision'),
      expectedHead: null,
      content: withProvenance,
    };
    s.ledger.charge({ maxAtoms: 1, maxBytes: Buffer.byteLength(canonical(proposal)) });
    let ref: AtomRef | undefined;
    const result = await this.engine.commit(
      {
        idempotencyKey: options.idempotencyKey ?? uid('operation'),
        guards: [],
        revisions: [proposal],
        ...(this.binding.actor.type === 'agent' ? { actorInputReceiptId: combined.id } : {}),
      },
      s,
      {
        validate: () => this.engine.check(s),
        committed: (result) => {
          const committed = this.engine.storage.get(
            result.committed[0]!,
            this.engine.storage.watermark(),
          )!;
          const manifest = this.engine.storage.metaGet<import('../core/store.js').ReceiptManifest>(
            `receipt:${combined.id}`,
          )!;
          manifest.ownedRevisionIds = result.committed.map((r) => r.revisionId);
          manifest.observations = manifest.observations.map((o) => ({
            ...o,
            watermark: this.engine.storage.watermark(),
            revisionIds: this.engine.storage
              .scan(o.query, this.engine.storage.watermark())
              .map((r) => r.revisionId),
          }));
          this.engine.storage.metaSet(`receipt:${combined.id}`, manifest);
          ref = this.engine.issue(committed, { ...s, at: this.engine.storage.watermark() });
          if (opKey)
            this.engine.storage.metaSet(opKey, { signature, ref, operationId: result.operationId });
        },
      },
    );
    const revision = this.engine.storage.get(
      result.committed[0]!,
      this.engine.storage.watermark(),
    )!;
    const view = this.engine.view(revision, { ...s, at: this.engine.storage.watermark() });
    return {
      ...view,
      ref: ref ?? view.ref,
      operationId: result.operationId,
      repeated: result.repeatedInput,
      indexing: this.engine.embedding ? 'pending' : 'ready',
    };
  }
  private async stageWrite(
    input: MemoryContent,
    options: WriteOptions = {},
    body?: AtomContent['body'],
    base?: AtomRef,
    retire = false,
  ): Promise<AtomView> {
    const overlay = this.overlay ?? fail('INVALID_REF');
    const s = this.engine.session(
      this.binding,
      { signal: options.signal },
      this.execution?.ledger,
      overlay,
    );
    let atomId = uid('atom');
    let expectedHead: string | null = null;
    if (base) {
      const entry = this.engine.resolve(base, s);
      atomId = entry.target.atomId;
      const staged = overlay.revisions.get(atomId);
      if (staged) fail('LIMIT_EXCEEDED', 'One proposed revision per logical Atom per edit');
      expectedHead = entry.target.revisionId;
      this.engine.get(entry.target, s);
    }
    const content = this.content(input, s, options, body);
    const revisionId = uid('revision');
    const proposal: ProposedRevision = {
      atomId,
      revisionId,
      expectedHead,
      content: { ...content, state: retire ? 'retired' : 'active' },
    };
    if (
      overlay.revisions.size >= this.engine.kernel.limits.maxBatch &&
      !overlay.revisions.has(atomId)
    )
      fail('LIMIT_EXCEEDED');
    s.ledger.charge({ maxAtoms: 1, maxBytes: Buffer.byteLength(canonical(proposal)) });
    overlay.revisions.set(atomId, proposal);
    const r = this.engine.get({ kind: 'pinned', atomId, revisionId }, s);
    this.finish(s);
    return this.engine.view(r, s);
  }
  async edit<T>(
    callback: (draft: Draft) => T | Promise<T>,
    options: EditOptions = {},
  ): Promise<EditOutcome<T>> {
    if (this.overlay) fail('INVALID_INPUT', 'Nested edit is not supported');
    if (typeof callback !== 'function') fail('INVALID_INPUT');
    const s = this.engine.session(this.binding, options, this.execution?.ledger);
    const overlay: OverlayState = {
      id: uid('overlay'),
      at: s.at,
      authBinding: bindingKey(this.binding.auth),
      active: true,
      revisions: new Map(),
      refs: new Set(),
      traces: [],
    };
    this.engine.overlays.set(overlay.id, overlay);
    const scope = { ledger: s.ledger, traces: [...(this.execution?.traces ?? [])] };
    const client = new MemoryClient(this.engine, this.binding, scope, overlay);
    const draft: Draft = {
      write: (value, opts) => client.stageWrite(value, opts),
      revise: (ref, value, opts) => client.stageWrite(value, opts, undefined, ref),
      retire: async (ref) => {
        const ds = this.engine.session(this.binding, {}, scope.ledger, overlay);
        const entry = this.engine.resolve(ref, ds);
        const old = this.engine.get(entry.target, ds);
        const view = this.engine.view(old, ds);
        client.finish(ds);
        return client.stageWrite(
          {
            text: this.engine.text(old),
            links: view.links.map((link) => ({
              role: link.role,
              target: {
                ref: link.ref,
                at: link.at,
                required: link.required,
                orderKey: link.orderKey,
              },
            })),
          },
          {
            sources: old.origins.map((origin) => ({
              ref: this.engine.issue(this.engine.get(origin.source, ds), ds),
              start: origin.selector.start,
              end: origin.selector.end,
            })),
          },
          old.body,
          ref,
          true,
        );
      },
      search: (query, opts) => client.search(query, opts),
      inspect: (ref, opts) => client.inspect(ref, opts),
    };
    try {
      const value = await cancellable(() => Promise.resolve(callback(draft)), s.signal);
      this.engine.check(s);
      const combined = this.engine.merge([...scope.traces, ...overlay.traces], this.binding, s.at);
      if (!combined.policies.length) (combined.policies as string[]).push(this.binding.writePolicy);
      // Tentative inputs are audit records, never CAS preconditions against uncommitted heads.
      combined.current = combined.current.filter((r) => !overlay.revisions.has(r.atomId));
      this.engine.storage.metaSet(`sdk:trace:${combined.id}`, combined);
      this.engine.bridge(combined, this.binding, options.basis === 'historical');
      const proposals = [...overlay.revisions.values()].map((p) => ({
        ...p,
        content: {
          ...p.content,
          provenance: { ...p.content.provenance, inputReceiptId: combined.id },
        },
      }));
      if (!proposals.length)
        return { value, changes: [], operationId: uid('empty-edit'), resolve: (ref) => ref };
      const mapping = new Map<AtomRef, AtomRef>();
      const changes: AtomView[] = [];
      const result = await this.engine.commit(
        {
          idempotencyKey: uid('edit'),
          guards: [],
          revisions: proposals,
          ...(this.binding.actor.type === 'agent' ? { actorInputReceiptId: combined.id } : {}),
        },
        s,
        {
          validate: () => {
            this.engine.check(s);
          },
          committed: (result) => {
            const committedSession = { ...s, at: this.engine.storage.watermark() };
            const manifest = this.engine.storage.metaGet<
              import('../core/store.js').ReceiptManifest
            >(`receipt:${combined.id}`)!;
            manifest.ownedRevisionIds = result.committed.map((r) => r.revisionId);
            manifest.currentReads = [
              ...(manifest.currentReads ?? []),
              ...(options.basis === 'historical' ? [] : result.committed),
            ];
            manifest.observations = manifest.observations.map((o) => ({
              ...o,
              watermark: committedSession.at,
              revisionIds: this.engine.storage
                .scan(o.query, committedSession.at)
                .map((r) => r.revisionId),
            }));
            this.engine.storage.metaSet(`receipt:${combined.id}`, manifest);
            for (const ref of overlay.refs) {
              const entry = this.engine.storage.metaGet<import('./engine.js').RefEntry>(
                `sdk:ref:${ref}`,
              )!;
              const target = this.engine.storage.get(
                { kind: 'logical', atomId: entry.target.atomId },
                this.engine.storage.watermark(),
              )!;
              mapping.set(ref, this.engine.issue(target, committedSession));
            }
            for (const ref of result.committed)
              changes.push(
                this.engine.view(
                  this.engine.storage.get(ref, this.engine.storage.watermark())!,
                  committedSession,
                ),
              );
          },
        },
      );
      const replace = (v: unknown): unknown =>
        typeof v === 'string' && mapping.has(v as AtomRef)
          ? mapping.get(v as AtomRef)
          : Array.isArray(v)
            ? v.map(replace)
            : v && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)]))
              : v;
      return {
        value: replace(value) as T,
        changes,
        operationId: result.operationId,
        resolve: (ref) => mapping.get(ref) ?? ref,
      };
    } finally {
      overlay.active = false;
      for (const ref of overlay.refs) {
        const entry = this.engine.storage.metaGet<import('./engine.js').RefEntry>(`sdk:ref:${ref}`);
        if (entry)
          this.engine.storage.metaDelete(
            `sdk:ref-key:${digest(canonical([entry.authBinding, entry.target.revisionId, overlay.id]))}`,
          );
        this.engine.storage.metaDelete(`sdk:ref:${ref}`);
      }
      this.engine.overlays.delete(overlay.id);
    }
  }
}
