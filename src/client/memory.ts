import { collectRanking, finishRanking, startRanking } from './ranking.js';
import { updateIndex, indexRevision } from './indexing.js';
import type {
  AtomContent,
  AtomRevision,
  Budget,
  Origin,
  PinnedRef,
  ProposedRevision,
  Slot,
  WriteRequest,
} from '../contracts.js';
import { BudgetLedger } from '../core/budget.js';
import { canonical, clone, digest, fail, uid, AtomMemoryError } from '../core/util.js';
import { validateContent, validateOrigin } from '../core/validation.js';
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
  SourceCitation,
  SupersedeOptions,
  Trace,
  WriteOptions,
  WriteOutcome,
  Candidate,
} from './types.js';
import {
  Engine,
  bindingKey,
  pinRevision,
  type HistoryManifest,
  type OverlayState,
  type QueryState,
  type Session,
  type SuccessorRecord,
} from './engine.js';
import { expand, graph, graphPage, materialize, pack } from './retrieval.js';
import { composition, compositionPage, validateComposition } from './composition.js';
import { positive, cancellable } from './control.js';
interface Retrieval {
  s: Session;
  state: QueryState;
}
export interface ExecutionScope {
  ledger: BudgetLedger;
  traces: Trace[];
}
interface Succession {
  old: PinnedRef;
  next: PinnedRef;
  manifest: HistoryManifest;
  revisions: PinnedRef[];
  relation: ProposedRevision;
  trace: Trace;
  retainSnapshot: boolean;
}
export const draftClients = new WeakMap<Draft, MemoryClient>();
export class MemoryHost {
  readonly engine: Engine;
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
      fail(
        'MODEL_SPACE_MISMATCH',
        'Only this encoder or a host-validated mapping output is accepted',
      );
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
  /** Host-only run binding; model tools receive the five methods through a validated dispatcher. */
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
    if (this.execution) this.execution.traces.push(clone(s.trace));
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
      if (!options.historical) {
        const successor = this.engine.successor(pinRevision(r), s);
        if (successor.revisionId !== r.revisionId) r = this.engine.get(successor, s);
      }
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
    const ranking = startRanking(
      seeds.slice(0, maxSeeds),
      options.depth ?? this.engine.options.ranking!.depth!,
      this.engine.options.ranking,
    );
    s.ledger = ledger.window({
      maxCandidates: Math.floor(ledger.remaining('maxCandidates') / 2),
      maxBytes: Math.floor(ledger.remaining('maxBytes') / 2),
    });
    try {
      if (!collectRanking(this.engine, s, ranking)) ranking.truncated = true;
    } finally {
      s.ledger = ledger;
    }
    q.candidates = finishRanking(this.engine, s, ranking).filter((candidate) => {
      if (options.historical) return true;
      const successor = this.engine.storage.metaGet<SuccessorRecord>(
        `sdk:successor:${candidate.revision.atomId}`,
      );
      return !successor || successor.sequence > s.at;
    });
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
    const key = this.key('search', query, { historical: options.historical ?? false, depth });
    const { s, state } = await this.retrieve('search', { query }, options, key);
    s.trace.plans ??= [];
    if (!options.cursor)
      s.trace.plans.push({
        kind: 'search',
        state: { query },
        depth,
        historical: options.historical ?? false,
      });
    const initialOffset = state.offset;
    const items: MemoryPage['items'][number][] = [];
    while (state.offset < state.candidates.length && items.length < limit) {
      const candidate = state.candidates[state.offset]!;
      try {
        const material = await materialize(this.engine, candidate.revision, s, false);
        if (
          material.revisions.length !== 1 ||
          material.revisions[0]!.revisionId !== candidate.revision.revisionId
        ) {
          state.candidates.splice(
            state.offset,
            1,
            ...material.revisions.map((revision) => ({ ...candidate, revision })),
          );
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
    const key = this.key('read', input, { historical: options.historical ?? false, depth });
    const { s, state } = await this.retrieve(
      'read',
      input,
      { ...options, budget: { maxContextTokens: tokens, ...options.budget } },
      key,
    );
    const seeds = state.candidates.slice(state.offset);
    s.trace.plans ??= [];
    if (!options.cursor)
      s.trace.plans.push({
        kind: 'search',
        state: clone(input),
        depth,
        historical: options.historical ?? false,
      });
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
    const limit = positive(options.limit, 20);
    const depth = options.depth ?? 1;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
    const key = this.key('inspect', ref, {
      depth,
      version: options.version ?? 'observed',
      successor: options.successor ?? false,
      history: options.history,
      rangeStart: options.range?.start,
      composition: options.composition,
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
    if (options.successor) root = this.engine.successor(root, s);
    const historyId =
      saved?.historyId ??
      this.engine.storage.metaGet<string>(`sdk:history-root:${root.atomId}:${root.revisionId}`);
    const history = historyId
      ? this.engine.storage.metaGet<HistoryManifest>(`sdk:history:${historyId}`)
      : undefined;
    if (
      (options.history === 'retained' || history) &&
      !options.successor &&
      options.version !== 'latest'
    ) {
      if (!history || history.until < Date.now()) fail('HISTORY_EXPIRED');
      if (!s.principal.readPolicies.includes(history.policy)) fail('ACCESS_DENIED');
      if (history.snapshot) {
        const retained = this.engine.storage.retainedSnapshot?.(history.snapshot);
        if (!retained || retained.at !== history.at || retained.until < history.until)
          fail('HISTORY_EXPIRED');
      }
      s = this.engine.session(
        this.binding,
        options,
        this.execution?.ledger,
        this.overlay,
        history.at,
        key,
      );
    }
    if (saved) s.trace = { ...clone(saved.trace), id: uid('trace') };
    if (!history && !saved) {
      (s.trace.plans ??= []).push({
        kind: 'inspect',
        target: options.version === 'latest' ? { kind: 'logical', atomId: root.atomId } : root,
        depth,
        ...(options.composition ? { composition: validateComposition(options.composition) } : {}),
      });
    }
    const r = this.engine.get(root, s, options.version === 'latest');
    const atom = this.engine.view(r, s, options.version === 'latest');
    if (r.body.kind === 'blob' || options.range)
      return this.blobInspection(r, atom, s, options, key, saved);
    let revisions: AtomRevision[];
    let complete: boolean;
    let graphState = saved?.graph;
    let compositionState = saved?.composition;
    let offset = saved?.offset ?? 0;
    let candidates = saved?.candidates ?? [];
    if (history?.snapshot && options.version !== 'latest' && !options.successor) {
      compositionState ??= composition(root, history.composition ?? fail('HISTORY_EXPIRED'));
      const page = compositionPage(this.engine, s, compositionState, limit);
      revisions = page.revisions;
      complete = page.complete;
    } else if (history && options.version !== 'latest' && !options.successor) {
      revisions = [];
      while (offset < history.count && revisions.length < limit) {
        const page =
          this.engine.storage.metaGet<PinnedRef[]>(history.pages[Math.floor(offset / 64)]!) ??
          fail('HISTORY_EXPIRED');
        s.ledger.charge({ maxBytes: Buffer.byteLength(canonical(page)) });
        for (let i = offset % 64; i < page.length && revisions.length < limit; i++, offset++)
          revisions.push(this.engine.get(page[i]!, s));
      }
      complete = offset >= history.count;
    } else if (options.composition) {
      compositionState ??= composition(root, options.composition);
      const page = compositionPage(this.engine, s, compositionState, limit);
      revisions = page.revisions;
      complete = page.complete;
    } else {
      graphState ??= graph(root, depth);
      const page = graphPage(this.engine, s, graphState, limit);
      revisions = page.revisions;
      complete = page.complete;
    }
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
          candidates,
          offset,
          complete,
          scanned: s.ledger.usage().maxCandidates,
          pending: false,
          approximate: false,
          trace: s.trace,
          graph: graphState,
          root,
          historyId: history?.id,
          composition: compositionState,
        })
      : undefined;
    return {
      atom,
      items,
      receipt,
      ...(cursor ? { cursor } : {}),
      ...(history
        ? { history: { retainedUntil: new Date(history.until).toISOString(), ref: atom.ref } }
        : {}),
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
      (s.trace.plans ??= []).push({
        kind: 'source',
        target: { kind: 'logical', atomId: source.atomId },
      });
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
    const scope: ExecutionScope = { ledger: s.ledger, traces: [...(this.execution?.traces ?? [])] };
    const client = new MemoryClient(this.engine, this.binding, scope, overlay);
    const successions: Succession[] = [];
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
      supersede: async (oldRef, newRef, opts) => {
        successions.push(await client.captureSuccession(oldRef, newRef, opts));
      },
    };
    draftClients.set(draft, client);
    try {
      const value = await cancellable(() => Promise.resolve(callback(draft)), s.signal);
      this.engine.check(s);
      const combined = this.engine.merge([...scope.traces, ...overlay.traces], this.binding, s.at);
      if (!combined.policies.length) (combined.policies as string[]).push(this.binding.writePolicy);
      // Tentative inputs are audit records, never CAS preconditions against uncommitted heads.
      combined.current = combined.current.filter((r) => !overlay.revisions.has(r.atomId));
      this.engine.storage.metaSet(`sdk:trace:${combined.id}`, combined);
      this.engine.bridge(combined, this.binding, options.basis === 'historical');
      const proposals = [...overlay.revisions.values(), ...successions.map((x) => x.relation)].map(
        (p) => ({
          ...p,
          content: {
            ...p.content,
            provenance: { ...p.content.provenance, inputReceiptId: combined.id },
          },
        }),
      );
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
            this.validateSuccessionBatch(successions, s, overlay);
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
            for (const succession of successions) {
              if (succession.retainSnapshot) {
                const token = this.engine.storage.retainSnapshot!(
                  succession.manifest.at,
                  succession.manifest.until,
                );
                const retained = this.engine.storage.retainedSnapshot!(token);
                if (
                  !retained ||
                  retained.at !== succession.manifest.at ||
                  retained.until < succession.manifest.until
                )
                  fail('HISTORY_INCOMPLETE', 'Backend did not retain the requested read state');
                succession.manifest.snapshot = token;
              }
              for (let i = 0; i < succession.manifest.pages.length; i++)
                this.engine.storage.metaSet(
                  succession.manifest.pages[i]!,
                  succession.revisions.slice(i * 64, (i + 1) * 64),
                );
              this.engine.storage.metaSet(
                `sdk:history:${succession.manifest.id}`,
                succession.manifest,
              );
              this.engine.storage.metaSet(
                `sdk:history-root:${succession.old.atomId}:${succession.old.revisionId}`,
                succession.manifest.id,
              );
              this.engine.storage.metaSet(
                `sdk:predecessor:${succession.next.atomId}`,
                succession.old,
              );
              this.engine.storage.metaSet(`sdk:successor:${succession.old.atomId}`, {
                from: succession.old,
                to: succession.next,
                historyId: succession.manifest.id,
                policy: succession.manifest.policy,
                operationId: result.operationId,
                sequence: this.engine.storage.watermark(),
              } satisfies SuccessorRecord);
            }
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
      draftClients.delete(draft);
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
  private async captureSuccession(
    oldRef: AtomRef,
    newRef: AtomRef,
    options: SupersedeOptions = {},
  ): Promise<Succession> {
    const s = this.engine.session(this.binding, {}, this.execution?.ledger, this.overlay);
    const old = this.engine.resolve(oldRef, s).target;
    const next = this.engine.resolve(newRef, s).target;
    const oldRevision = this.engine.get(old, s, true);
    const newRevision = this.engine.get(next, s, true);
    if (oldRevision.policyId !== newRevision.policyId) fail('ACCESS_DENIED');
    if (
      this.engine.storage.metaGet(`sdk:successor:${old.atomId}`) ||
      this.engine.storage.metaGet(`sdk:predecessor:${next.atomId}`)
    )
      fail('SUCCESSOR_CONFLICT');
    const capture = { ...s, overlay: undefined };
    const recorded =
      this.overlay?.traces
        .flatMap((t) => t.plans ?? [])
        .flatMap((p) =>
          p.kind === 'inspect' && p.target.atomId === old.atomId && p.composition
            ? [p.composition]
            : [],
        ) ?? [];
    const unique = [...new Map(recorded.map((p) => [canonical(p), p])).values()];
    let plan = options.composition ?? (unique.length === 1 ? unique[0] : undefined);
    if (!plan) {
      const incoming = this.engine.scan(
        { policies: s.trace.policies, relation: { target: old }, limit: 1 },
        capture,
        true,
      );
      s.ledger.charge({ maxCandidates: 1, maxBytes: Buffer.byteLength(canonical(incoming)) });
      if (
        unique.length > 1 ||
        incoming.length ||
        oldRevision.slots.some((slot) => slot.mode === 'refer')
      )
        fail(
          'HISTORY_PLAN_REQUIRED',
          'Declare which roles form this composition; neighbourhoods are not compositions',
        );
      plan = { relations: [] };
    }
    plan = validateComposition(plan);
    const retainSnapshot = !!(
      this.engine.storage.retainSnapshot && this.engine.storage.retainedSnapshot
    );
    const max = this.engine.options.historyMaxAtoms ?? 256;
    let page = { revisions: [] as AtomRevision[], complete: true };
    try {
      if (!retainSnapshot)
        page = compositionPage(this.engine, capture, composition(old, plan), max + 1);
    } catch (e) {
      if (e instanceof AtomMemoryError && e.code === 'BUDGET_EXHAUSTED') fail('HISTORY_INCOMPLETE');
      throw e;
    }
    if (!page.complete || page.revisions.length > max)
      fail('HISTORY_INCOMPLETE', 'Exact arrangement exceeded the history capture budget');
    this.finish(capture);
    const retain = options.retainForMs ?? this.engine.options.historyRetentionMs ?? 30 * 86400000;
    if (!Number.isSafeInteger(retain) || retain <= 0) fail('INVALID_INPUT');
    const id = uid('history');
    const revisions = page.revisions.map(pinRevision);
    const pages = Array.from(
      { length: Math.ceil(revisions.length / 64) },
      (_, i) => `sdk:history-page:${id}:${i}`,
    );
    const manifest: HistoryManifest = {
      id,
      root: old,
      at: s.at,
      until: Date.now() + retain,
      policy: oldRevision.policyId,
      pages,
      count: revisions.length,
      composition: plan,
    };
    const relationContent = this.content(
      {
        text: 'An authorized successor was adopted',
        links: {
          previous: { ref: oldRef, at: 'observed' },
          successor: { ref: newRef, at: 'observed' },
        },
      },
      s,
    );
    return {
      old,
      next,
      manifest,
      revisions,
      trace: clone(capture.trace),
      retainSnapshot,
      relation: {
        atomId: uid('atom'),
        revisionId: uid('revision'),
        expectedHead: null,
        content: relationContent,
      },
    };
  }
  private validateSuccessionBatch(items: Succession[], s: Session, overlay: OverlayState): void {
    const next = new Map<string, string>();
    const targets = new Set<string>();
    for (const item of items) {
      if (next.has(item.old.atomId) || targets.has(item.next.atomId))
        fail('SUCCESSOR_CONFLICT', 'Only one-to-one successor adoption is supported');
      next.set(item.old.atomId, item.next.atomId);
      targets.add(item.next.atomId);
      this.validateSuccession(item, s, overlay);
    }
    for (const old of next.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = old;
      while (current) {
        s.ledger.charge({ maxCandidates: 1 });
        if (seen.has(current)) fail('SUCCESSOR_CYCLE');
        seen.add(current);
        current =
          next.get(current) ??
          this.engine.storage.metaGet<SuccessorRecord>(`sdk:successor:${current}`)?.to.atomId;
      }
    }
  }
  private validateSuccession(item: Succession, s: Session, overlay: OverlayState): void {
    if (
      this.engine.storage.metaGet(`sdk:successor:${item.old.atomId}`) ||
      this.engine.storage.metaGet(`sdk:predecessor:${item.next.atomId}`)
    )
      fail('SUCCESSOR_CONFLICT');
    for (const observation of item.trace.queries) {
      s.ledger.charge({ maxCandidates: observation.revisions.length + 1 });
      const current = this.engine.storage.scan(observation.query, this.engine.storage.watermark());
      if (canonical(current.map((r) => r.revisionId)) !== canonical(observation.revisions))
        fail('REVISION_CONFLICT', 'Historical capture range changed');
    }
    for (const ref of item.trace.reads) {
      if (overlay.revisions.has(ref.atomId)) continue;
      s.ledger.charge({ maxCandidates: 1 });
      const before = this.engine.storage.get({ kind: 'logical', atomId: ref.atomId }, s.at);
      const now = this.engine.storage.get(
        { kind: 'logical', atomId: ref.atomId },
        this.engine.storage.watermark(),
      );
      if (before?.revisionId !== now?.revisionId)
        fail('REVISION_CONFLICT', 'Historical capture input changed');
    }
    if (item.old.atomId === item.next.atomId) fail('SUCCESSOR_CYCLE');
    for (const ref of [item.old, item.next]) {
      const staged = overlay.revisions.get(ref.atomId);
      const current = staged
        ? staged.revisionId
        : this.engine.storage.get(
            { kind: 'logical', atomId: ref.atomId },
            this.engine.storage.watermark(),
          )?.revisionId;
      if (current !== ref.revisionId) fail('REVISION_CONFLICT');
    }
    const visited = new Set<string>([item.old.atomId]);
    let id = item.next.atomId;
    while (true) {
      s.ledger.charge({ maxCandidates: 1 });
      if (visited.has(id)) fail('SUCCESSOR_CYCLE');
      visited.add(id);
      const successor = this.engine.storage.metaGet<SuccessorRecord>(`sdk:successor:${id}`);
      if (!successor) break;
      id = successor.to.atomId;
    }
  }
}
