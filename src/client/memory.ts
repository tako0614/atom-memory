import { recordUse, resetUse } from './activation.js';
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
import { canonical, clone, digest, fail, uid, validId, AtomMemoryError } from '../core/util.js';
import { validateContent } from '../core/validation.js';
import type {
  AtomRef,
  AtomView,
  ClientBinding,
  HostOptions,
  Inspection,
  InspectionNeighbor,
  InspectionVia,
  InspectOptions,
  LinkTarget,
  MemoryAPI,
  MemoryChange,
  MemoryPage,
  MemoryReceipt,
  MemoryState,
  MemoryWriteRequest,
  OperationOptions,
  ReadOptions,
  RecallResult,
  SearchOptions,
  SearchSignal,
  WriteOptions,
  WriteOutcome,
  Candidate,
  UseResult,
} from './types.js';
import {
  Engine,
  bindingKey,
  pinRevision,
  type InspectionCursorState,
  type QueryState,
  type Session,
} from './engine.js';
import { validateMemory } from './retrieval.js';
import { select } from './selection.js';
import { positive } from './control.js';
import {
  observe,
  manifest,
  present,
  inputManifest,
  sourceManifest,
  attachOutputs,
  attachInheritedOutputs,
} from './observation.js';
import type { HostInput, InputToken } from './types.js';
interface Retrieval {
  s: Session;
  state: QueryState;
}
interface PreparedChange {
  change: MemoryChange;
  atomId: string;
  revisionId: string;
  slots: Slot[];
  normalizedLinks: unknown[];
  origins: Origin[];
  normalizedSources: unknown[];
  previous?: AtomRevision;
}
export interface ExecutionScope {
  ledger: BudgetLedger;
  traces?: Trace[];
}
const internalBodyWriters = new WeakMap<
  MemoryClient,
  (body: AtomContent['body']) => Promise<WriteOutcome>
>();
export class MemoryHost {
  private readonly engine: Engine;
  constructor(options: HostOptions) {
    this.engine = new Engine(options);
  }
  connect(binding: ClientBinding): MemoryClient {
    this.engine.principal(binding);
    return new MemoryClient(this.engine, clone(binding));
  }
  observe(input: HostInput, binding: ClientBinding): InputToken {
    return observe(this.engine, input, binding);
  }
  manifest(value: MemoryReceipt | InputToken, binding: ClientBinding) {
    return manifest(this.engine, value, binding);
  }
  reference(ref: PinnedRef, binding: ClientBinding): AtomRef {
    const s = this.engine.session(binding);
    return this.engine.issue(this.engine.get(ref, s), s);
  }
  /** Acknowledge bodies actually delivered to a successful model request. */
  recordUse(
    refs: readonly AtomRef[],
    binding: ClientBinding,
    options: { eventId: string; input?: InputToken },
  ): UseResult {
    if (!options || Object.keys(options).some((key) => !['eventId', 'input'].includes(key)))
      fail('INVALID_INPUT');
    return this.engine.storage.transaction(() => {
      const m =
        options.input !== undefined
          ? inputManifest(this.engine, options.input, binding)
          : undefined;
      const g = m?.generation;
      if (g && typeof g !== 'string') {
        const delivered = new Set(g.presentations.flatMap((p) => p.units.map((u) => u.ref)));
        if (refs.some((ref) => !delivered.has(ref)))
          fail('INVALID_INPUT', 'Use must match the host presentation');
      }
      const result = recordUse(this.engine, refs, binding, options.eventId);
      if (m) {
        const s = this.engine.session(binding);
        const revisions = [
          ...new Map(
            refs.map((ref) => {
              const target = this.engine.resolve(ref, s).target;
              return [target.revisionId, target] as const;
            }),
          ).values(),
        ];
        const ack = m.acknowledgement ?? [];
        const old = ack.find((a) => a.eventId === options.eventId);
        if (old)
          old.revisions = [
            ...new Map([...old.revisions, ...revisions].map((r) => [r.revisionId, r])).values(),
          ];
        else ack.push({ eventId: options.eventId, acceptedAt: result.acceptedAt, revisions });
        m.acknowledgement = ack;
        this.engine.storage.metaSet(`receipt:${m.receipt.receiptId}`, m);
      }
      return result;
    });
  }
  /** Reset scoped use aggregates; durable retry markers remain valid. */
  resetUse(binding: ClientBinding): void {
    resetUse(this.engine, binding);
    this.engine.evaluations.clear();
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
    const client = this.connect(binding);
    return internalBodyWriters.get(client)!(body);
  }
  purge(atomId: string, options: import('../core/purge.js').PurgeOptions = {}) {
    const result = this.engine.kernel.purge(atomId, options);
    this.engine.evaluations.clear();
    return result;
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
  ) {
    internalBodyWriters.set(this, (body) =>
      this.writePrepared(
        {
          changes: [{ id: 'source', op: 'create', content: { text: '', links: [] }, sources: [] }],
        },
        {},
        new Map([['source', body]]),
      ),
    );
  }
  /** Share a host-owned memory budget and observed inputs across operations. No model loop runs here. */
  forExecution(scope: ExecutionScope): MemoryClient {
    return new MemoryClient(this.engine, this.binding, scope);
  }
  assertAuthorized(receipts: readonly MemoryReceipt[] = []): void {
    const s = this.engine.session(this.binding, {}, this.execution?.ledger);
    for (const receipt of receipts) {
      if (this.engine.storage.metaGet(`sdk:manifest:${receipt.id}`)) {
        manifest(this.engine, receipt, this.binding);
        continue;
      }
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
    if (options.cursor) saved = this.engine.cursor(options.cursor, this.binding, kind, key);
    const s = this.engine.session(
      this.binding,
      options,
      this.execution?.ledger,
      undefined,
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
      candidates: [],
      offset: 0,
      complete: false,
      scanned: 0,
      pending: false,
      approximate: false,
      trace: s.trace,
    };
    const maximum = this.engine.options.retrieval!.maxScan!;
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
    const maxSeeds = this.engine.options.retrieval!.maxSeeds!;
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
        options.depth ?? this.engine.options.retrieval!.depth!,
        this.engine.options.retrieval,
      );
      ranking.truncated ||= exhausted;
      if (!collectRanking(this.engine, s, ranking)) ranking.truncated = true;
    } finally {
      s.ledger = ledger;
    }
    const evaluated = finishRanking(this.engine, s, ranking, found.signals);
    q.candidates = evaluated.candidates;
    q.evaluatedCandidates = evaluated.candidates;
    q.evaluation = evaluated.evaluation;
    q.approximate ||= ranking.truncated || ranking.depth > 0;
    q.complete = true;
    return { s, state: q };
  }
  async search(query: string, options: SearchOptions = {}): Promise<MemoryPage> {
    if (typeof query !== 'string' || !query.trim())
      fail('INVALID_INPUT', 'Search query must not be empty');
    const limit = positive(options.limit, 10);
    const depth = options.depth ?? this.engine.options.retrieval!.depth!;
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
        items.push({ ...view, score: candidate.score });
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
    present(this.engine, s, receipt, items, canonical(items.map(({ score: _score, ...v }) => v)));
    const cursor = more ? this.engine.saveCursor({ ...state, trace: s.trace }) : undefined;
    return {
      items,
      stale: [...s.stale],
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(state.scanned, !more, state.pending),
        approximate: state.approximate,
        ...state.evaluation,
        acquisition: {
          partial: state.approximate,
          scanned: state.scanned,
          index: state.pending ? 'pending' : 'ready',
        },
        validation: { stale: s.stale.size, blocked: s.blocked?.size ?? 0 },
        ...(state.evaluation
          ? {
              evaluation: {
                converged: state.evaluation.evaluationConverged,
                numericErrorL1Upper: state.evaluation.numericErrorL1Upper,
                scope: 'acquired-graph' as const,
              },
            }
          : {}),
        derived: s.pendingDerived ? 'pending' : s.derived,
        ...(s.derivedReason ? { derivedReason: s.derivedReason } : {}),
        stop:
          state.evaluation?.evaluationConverged === false
            ? 'numeric-budget'
            : more
              ? 'page-limit'
              : 'completed',
      },
      usage: s.ledger.usage(),
    };
  }
  async read(input: MemoryState, options: ReadOptions = {}): Promise<RecallResult> {
    if (!input || typeof input !== 'object') fail('INVALID_INPUT');
    const limit = positive(options.limit, 24);
    const tokens = positive(options.tokens, 4096, 1000000);
    const depth = options.depth ?? this.engine.options.retrieval!.depth!;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) fail('INVALID_INPUT');
    const key = this.key('read', input, { depth });
    const { s, state } = await this.retrieve(
      'read',
      input,
      { ...options, budget: { maxContextTokens: tokens, ...options.budget } },
      key,
    );
    const seeds = state.candidates.slice(state.offset);
    const packed = select(
      this.engine,
      s,
      seeds,
      Math.min(tokens, s.ledger.remaining('maxContextTokens')),
      limit,
      state.evaluatedCandidates,
    );
    const receipt = this.finish(s);
    const more = packed.deferred.length > 0 || !state.complete;
    present(this.engine, s, receipt, packed.items, packed.text);
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
      formatVersion: 2,
      refs: packed.items.map((i) => i.ref),
      sources: packed.sources,
      tokenCount: packed.tokenCount,
      receipt,
      ...(cursor ? { cursor } : {}),
      diagnostics: {
        ...this.engine.diagnostics(state.scanned, !more, state.pending),
        approximate: state.approximate,
        ...state.evaluation,
        acquisition: {
          partial: state.approximate,
          scanned: state.scanned,
          index: state.pending ? 'pending' : 'ready',
        },
        validation: { stale: s.stale.size, blocked: s.blocked?.size ?? 0 },
        ...(state.evaluation
          ? {
              evaluation: {
                converged: state.evaluation.evaluationConverged,
                numericErrorL1Upper: state.evaluation.numericErrorL1Upper,
                scope: 'acquired-graph' as const,
              },
            }
          : {}),
        derived: s.pendingDerived ? 'pending' : s.derived,
        ...(s.derivedReason ? { derivedReason: s.derivedReason } : {}),
        stop:
          state.evaluation?.evaluationConverged === false
            ? 'numeric-budget'
            : more || !packed.selection.complete
              ? 'budget'
              : 'completed',
        selection: packed.selection,
        ...(packed.minimumTokens ? { minimumTokens: packed.minimumTokens } : {}),
      },
      usage: s.ledger.usage(),
    };
  }
  async inspect(ref: AtomRef, options: InspectOptions = {}): Promise<Inspection> {
    if (
      !options ||
      typeof options !== 'object' ||
      Object.keys(options).some(
        (key) =>
          ![
            'version',
            'direction',
            'roles',
            'limit',
            'cursor',
            'range',
            'budget',
            'deadline',
            'signal',
          ].includes(key),
      )
    )
      fail('INVALID_INPUT');
    if (![undefined, 'observed', 'latest'].includes(options.version)) fail('INVALID_INPUT');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) fail('INVALID_INPUT');
    const direction = options.direction ?? 'both';
    if (!['both', 'incoming', 'outgoing'].includes(direction)) fail('INVALID_INPUT');
    if (
      options.roles !== undefined &&
      (!Array.isArray(options.roles) ||
        options.roles.length > this.engine.kernel.limits.maxSlots ||
        options.roles.some((role) => typeof role !== 'string' || !role.length))
    )
      fail('INVALID_INPUT');
    for (const role of options.roles ?? []) validId(role);
    if (
      options.range !== undefined &&
      (!options.range ||
        typeof options.range !== 'object' ||
        Object.keys(options.range).some((key) => !['start', 'bytes'].includes(key)))
    )
      fail('INVALID_INPUT');
    const roles = [...new Set(options.roles ?? [])].sort();
    const key = this.key('inspect', ref, {
      version: options.version ?? 'observed',
      direction,
      roles,
      rangeStart: options.range?.start,
      rangeBytes: options.range?.bytes,
    });
    const saved = options.cursor
      ? this.engine.cursor(options.cursor, this.binding, 'inspect', key)
      : undefined;
    let s = this.engine.session(
      this.binding,
      options,
      this.execution?.ledger,
      undefined,
      saved?.at,
      key,
    );
    const entry = this.engine.resolve(ref, s);
    let root = saved?.root ?? entry.target;
    if (!saved && options.version === 'latest')
      root = pinRevision(this.engine.get({ kind: 'logical', atomId: root.atomId }, s, true));
    if (saved) s.trace = { ...clone(saved.trace), id: uid('trace') };
    const r = this.engine.get(root, s, options.version === 'latest');
    // An AtomRef embedded in a returned AtomView is presentation metadata, not a
    // claim that the referenced body was shown. Record only the AtomViews that
    // this inspection page actually returns.
    const atom = this.engine.view(r, s, options.version === 'latest', false);
    if (r.body.kind === 'blob' || options.range)
      return this.blobInspection(r, atom, s, options, key, saved);
    if (limit === 0) return this.finishInspection(atom, [], s, true);

    const roleAllowed = (role: string) => !options.roles || roles.includes(role);
    const via = (slot: Slot, edgeDirection: InspectionVia['direction']): InspectionVia => ({
      direction: edgeDirection,
      role: slot.role,
      at: slot.target.kind === 'logical' ? 'logical' : 'observed',
      required: slot.mode === 'include' || slot.required === true,
      ...(slot.orderKey ? { orderKey: slot.orderKey } : {}),
    });
    const incomingVias = (candidate: AtomRevision): InspectionVia[] => {
      const found: InspectionVia[] = [];
      for (const slot of candidate.slots) {
        if (!roleAllowed(slot.role)) continue;
        const matches =
          slot.target.kind === 'pinned'
            ? slot.target.atomId === root.atomId && slot.target.revisionId === root.revisionId
            : this.engine.neighbor(slot.target, s, true, false)?.revisionId === root.revisionId;
        if (matches) found.push(via(slot, 'incoming'));
      }
      return found;
    };
    const state: InspectionCursorState =
      saved?.inspection ??
      (() => {
        const outgoing = new Map<
          string,
          { ref: PinnedRef; via: InspectionVia[]; outgoing: boolean }
        >();
        if (direction !== 'incoming')
          for (const slot of r.slots) {
            if (!roleAllowed(slot.role)) continue;
            const target = this.engine.neighbor(
              slot.target,
              s,
              slot.target.kind === 'logical',
              false,
            );
            if (!target) continue;
            const old = outgoing.get(target.revisionId);
            if (old) old.via.push(via(slot, 'outgoing'));
            else
              outgoing.set(target.revisionId, {
                ref: pinRevision(target),
                via: [via(slot, 'outgoing')],
                outgoing: true,
              });
          }
        return {
          pending: [...outgoing.values()],
          outgoingRevisionIds: [...outgoing.keys()],
          incomingDone: direction === 'outgoing' || (options.roles !== undefined && !roles.length),
        };
      })();
    const neighbors: InspectionNeighbor[] = [];
    while (neighbors.length < limit) {
      this.engine.check(s);
      const next = state.pending.shift();
      if (next) {
        const revision = this.engine.get(next.ref, s);
        const allVia = [
          ...next.via,
          ...(next.outgoing && direction === 'both' ? incomingVias(revision) : []),
        ];
        const uniqueVia = [
          ...new Map(allVia.map((item) => [canonical(item), item] as const)).values(),
        ];
        neighbors.push({ atom: this.engine.view(revision, s, false, false), via: uniqueVia });
        continue;
      }
      if (state.incomingDone) break;
      const available = s.ledger.remaining('maxCandidates');
      if (available < 2) break;
      const count = Math.min(16, Math.max(1, Math.floor(available / 2)));
      const page = this.engine.scan(
        {
          policies: [...s.trace.policies],
          relation: { target: root },
          after: state.incomingAfter,
          limit: count,
        },
        s,
        true,
      );
      s.ledger.charge({ maxCandidates: page.length });
      if (page.length < count) state.incomingDone = true;
      else state.incomingAfter = page.at(-1)!.atomId;
      for (const candidate of page) {
        if (state.outgoingRevisionIds.includes(candidate.revisionId)) continue;
        const candidateVia = incomingVias(candidate);
        if (candidateVia.length)
          state.pending.push({
            ref: pinRevision(candidate),
            via: candidateVia,
            outgoing: false,
          });
      }
    }
    const complete = state.incomingDone && state.pending.length === 0;
    if (!complete && !neighbors.length)
      fail('BUDGET_EXHAUSTED', 'Adjacency cannot advance with this budget');
    const cursor = !complete
      ? this.engine.saveCursor({
          kind: 'inspect',
          binding: bindingKey(this.binding.auth),
          generation: s.principal.generation,
          at: s.at,
          signalDigest: key,
          index: this.engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
          config: this.engine.config,
          candidates: [],
          offset: 0,
          complete,
          scanned: s.ledger.usage().maxCandidates,
          pending: false,
          approximate: false,
          trace: s.trace,
          inspection: state,
          root,
        })
      : undefined;
    return this.finishInspection(atom, neighbors, s, complete, cursor);
  }
  private finishInspection(
    atom: AtomView,
    neighbors: readonly InspectionNeighbor[],
    s: Session,
    complete: boolean,
    cursor?: string,
  ): Inspection {
    const rendered = canonical({ atom, neighbors });
    s.ledger.charge({
      maxAtoms: 1 + neighbors.length,
      maxBytes: Buffer.byteLength(rendered),
    });
    const receipt = this.finish(s);
    const presentedRefs = new Set<AtomRef>();
    const presented = [atom, ...neighbors.map((neighbor) => neighbor.atom)].filter((item) => {
      if (presentedRefs.has(item.ref)) return false;
      presentedRefs.add(item.ref);
      return true;
    });
    present(this.engine, s, receipt, presented, rendered, undefined, { root: atom.ref, neighbors });
    return {
      atom,
      neighbors,
      readEligibility: atom.links.some((link) => link.required && link.unavailable)
        ? 'blocked'
        : 'unchecked',
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
    const returnedAtom = { ...atom, text: text ?? '' };
    const range = {
      start,
      end,
      totalBytes: total,
      mediaType,
      ...(text !== undefined ? { text } : { base64: Buffer.from(part).toString('base64') }),
    };
    const rendered = canonical({ atom: returnedAtom, neighbors: [], range });
    s.ledger.charge({ maxBytes: Buffer.byteLength(rendered) });
    const receipt = this.finish(s);
    present(
      this.engine,
      s,
      receipt,
      [{ ...returnedAtom, text: text ?? Buffer.from(part).toString('base64') }],
      rendered,
      { start, end, unit: textual ? 'utf8' : 'byte', digest: digest(part) },
    );
    const cursor = !complete
      ? this.engine.saveCursor({
          kind: 'inspect',
          binding: bindingKey(this.binding.auth),
          generation: s.principal.generation,
          at: s.at,
          signalDigest: key,
          index: this.engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
          config: this.engine.config,
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
      atom: returnedAtom,
      neighbors: [],
      readEligibility: atom.links.some((link) => link.required && link.unavailable)
        ? 'blocked'
        : 'unchecked',
      stale: [],
      range,
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
  async write(request: MemoryWriteRequest, options: WriteOptions = {}): Promise<WriteOutcome> {
    return this.writePrepared(request, options);
  }
  private async writePrepared(
    request: MemoryWriteRequest,
    options: WriteOptions,
    bodies = new Map<string, AtomContent['body']>(),
  ): Promise<WriteOutcome> {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some((key) => key !== 'changes') ||
      !Array.isArray(request.changes)
    )
      fail('INVALID_INPUT');
    if (
      !options ||
      typeof options !== 'object' ||
      Object.keys(options).some(
        (key) => !['idempotencyKey', 'budget', 'deadline', 'signal'].includes(key),
      )
    )
      fail('INVALID_INPUT');
    if (!request.changes.length) fail('INVALID_INPUT', 'A write batch must contain a change');
    if (request.changes.length > this.engine.kernel.limits.maxBatch) fail('LIMIT_EXCEEDED');
    if (options.idempotencyKey !== undefined) validId(options.idempotencyKey);

    const generated = this.binding.actor.type === 'agent';
    const ids = new Set<string>();
    for (const change of request.changes) {
      if (!change || typeof change !== 'object') fail('INVALID_INPUT');
      validId(change.id);
      if (ids.has(change.id)) fail('INVALID_INPUT', 'Change ids are unique within a batch');
      ids.add(change.id);
      if (!['create', 'revise', 'retire'].includes(change.op)) fail('INVALID_INPUT');
      const allowed =
        change.op === 'create'
          ? ['id', 'op', 'content', 'sources', 'input']
          : change.op === 'revise'
            ? ['id', 'op', 'target', 'content', 'sources', 'input']
            : ['id', 'op', 'target', 'input'];
      if (Object.keys(change).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
      if (generated && change.input === undefined)
        fail('INVALID_INPUT', 'Every agent change requires its host-issued input token');
      if (change.input !== undefined && typeof change.input !== 'string') fail('INVALID_INPUT');
      if (change.op !== 'create' && typeof change.target !== 'string') fail('INVALID_REF');
      if (change.op !== 'retire') {
        if (
          !change.content ||
          typeof change.content !== 'object' ||
          Object.keys(change.content).some((key) => !['text', 'links'].includes(key)) ||
          !Object.hasOwn(change.content, 'links') ||
          typeof change.content.text !== 'string'
        )
          fail('INVALID_INPUT', 'Create and revise require full text and links');
        if (Buffer.byteLength(change.content.text) > this.engine.kernel.limits.maxAtomBytes)
          fail('LIMIT_EXCEEDED');
        if (!Array.isArray(change.sources))
          fail('INVALID_INPUT', 'Create and revise require an explicit sources array');
      }
    }

    // Allocate every generated identity before resolving any external or local reference.
    const prepared: PreparedChange[] = request.changes.map((change) => ({
      change,
      atomId: change.op === 'create' ? uid('atom') : '',
      revisionId: uid('revision'),
      slots: [],
      normalizedLinks: [],
      origins: [],
      normalizedSources: [],
    }));
    const local = new Map(prepared.map((item) => [item.change.id, item] as const));
    const s = this.engine.session(this.binding, options, this.execution?.ledger);
    const logicalAtoms = new Set<string>();
    for (const item of prepared) {
      if (item.change.op !== 'create') {
        const entry = this.engine.resolve(item.change.target, s);
        item.previous = this.engine.get(entry.target, s, true);
        item.atomId = entry.target.atomId;
      }
      if (logicalAtoms.has(item.atomId))
        fail('INVALID_INPUT', 'A batch may change each logical Atom only once');
      logicalAtoms.add(item.atomId);
    }

    const resolveLink = (target: LinkTarget, position: number) => {
      const spec = typeof target === 'string' ? { ref: target } : target;
      if (!spec || typeof spec !== 'object') fail('INVALID_INPUT');
      if (
        Object.keys(spec).some(
          (key) => !['ref', 'local', 'at', 'required', 'orderKey'].includes(key),
        ) ||
        ![undefined, 'logical', 'observed'].includes(spec.at) ||
        (spec.required !== undefined && typeof spec.required !== 'boolean') ||
        (spec.orderKey !== undefined && typeof spec.orderKey !== 'string')
      )
        fail('INVALID_INPUT');
      const hasRef = 'ref' in spec;
      const hasLocal = 'local' in spec;
      if (hasRef === hasLocal) fail('INVALID_INPUT');
      const at = spec.at ?? 'logical';
      const required = spec.required === true;
      const orderKey = spec.orderKey ?? String(position);
      validId(orderKey);
      if (hasLocal) {
        const targetChange = local.get(spec.local);
        if (!targetChange) fail('INVALID_REF', 'Unknown batch-local change id');
        const pinned: PinnedRef = {
          kind: 'pinned',
          atomId: targetChange.atomId,
          revisionId: targetChange.revisionId,
        };
        return {
          slot: {
            mode: 'refer' as const,
            target:
              at === 'observed' ? pinned : { kind: 'logical' as const, atomId: pinned.atomId },
            required,
            orderKey,
          },
          normalized: { local: spec.local, at, required, orderKey },
        };
      }
      const entry = this.engine.resolve(spec.ref, s);
      const observed = this.engine.get(entry.target, s, generated && at === 'logical');
      return {
        slot: {
          mode: 'refer' as const,
          target:
            at === 'observed'
              ? entry.target
              : { kind: 'logical' as const, atomId: entry.target.atomId },
          required,
          orderKey,
        },
        normalized: { ref: pinRevision(observed), at, required, orderKey },
      };
    };

    for (const item of prepared) {
      const change = item.change;
      if (change.op === 'retire') continue;
      const links = change.content.links;
      if (!links || typeof links !== 'object') fail('INVALID_INPUT');
      const add = (role: string, target: LinkTarget) => {
        if (item.slots.length >= this.engine.kernel.limits.maxSlots) fail('LIMIT_EXCEEDED');
        validId(role);
        const resolved = resolveLink(target, item.slots.length);
        item.slots.push({ role, ...resolved.slot });
        item.normalizedLinks.push({ role, target: resolved.normalized });
      };
      if (Array.isArray(links)) {
        for (const link of links) {
          if (
            !link ||
            typeof link !== 'object' ||
            Object.keys(link).some((key) => !['role', 'target'].includes(key)) ||
            typeof link.role !== 'string' ||
            !Object.hasOwn(link, 'target')
          )
            fail('INVALID_INPUT');
          add(link.role, link.target);
        }
      } else {
        for (const [role, targets] of Object.entries(links)) {
          if (Array.isArray(targets)) for (const target of targets) add(role, target);
          else add(role, targets as LinkTarget);
        }
      }
      if (change.sources.length > this.engine.kernel.limits.maxOrigins) fail('LIMIT_EXCEEDED');
      for (const citation of change.sources) {
        if (
          !citation ||
          typeof citation !== 'object' ||
          Object.keys(citation).some((key) => !['ref', 'start', 'end'].includes(key)) ||
          typeof citation.ref !== 'string'
        )
          fail('INVALID_INPUT');
        const entry = this.engine.resolve(citation.ref, s);
        const source = this.engine.get(entry.target, s, generated);
        const start = citation.start ?? 0;
        const end =
          citation.end ??
          (source.body.kind === 'blob'
            ? source.body.bytes
            : Buffer.byteLength(this.engine.text(source)));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
          fail('INVALID_SOURCE_SPAN');
        const bytes =
          source.body.kind === 'blob'
            ? this.engine.storage.blobRange?.(source.body.blobId, start, end - start)
            : Buffer.from(this.engine.text(source)).subarray(start, end);
        if (!bytes || bytes.length !== end - start) fail('INVALID_SOURCE_SPAN');
        s.ledger.charge({ maxBytes: bytes.length });
        item.origins.push({
          source: entry.target,
          selector: { kind: 'utf8', start, end, quoteDigest: digest(bytes) },
        });
        item.normalizedSources.push({ ref: entry.target, start, end });
      }
    }

    const normalized = prepared.map((item) => {
      const change = item.change;
      return change.op === 'retire'
        ? { id: change.id, op: change.op, target: pinRevision(item.previous!), input: change.input }
        : {
            id: change.id,
            op: change.op,
            ...(change.op === 'revise' ? { target: pinRevision(item.previous!) } : {}),
            content: { text: change.content.text, links: item.normalizedLinks },
            sources: item.normalizedSources,
            input: change.input,
            ...(bodies.has(change.id) ? { body: bodies.get(change.id) } : {}),
          };
    });
    const fingerprint = digest(canonical({ changes: normalized }));
    const replayKey = options.idempotencyKey
      ? `sdk:write-v3:${digest(
          canonical([
            s.principal.subject,
            this.binding.writePolicy,
            this.binding.actor,
            options.idempotencyKey,
          ]),
        )}`
      : undefined;
    type ReplayRecord = {
      version: 3;
      fingerprint: string;
      operationId: string;
      changes: Record<string, PinnedRef>;
    };
    const previousReplay = replayKey
      ? this.engine.storage.metaGet<ReplayRecord>(replayKey)
      : undefined;
    if (previousReplay) {
      if (previousReplay.version !== 3 || previousReplay.fingerprint !== fingerprint)
        fail('IDEMPOTENCY_CONFLICT');
      const changes: [string, AtomView][] = [];
      for (const change of request.changes) {
        const pinned = Object.hasOwn(previousReplay.changes, change.id)
          ? previousReplay.changes[change.id]!
          : fail('IDEMPOTENCY_CONFLICT');
        const revision = this.engine.get(pinned, s);
        if (
          revision.policyId !== this.binding.writePolicy ||
          !s.principal.writePolicies.includes(revision.policyId)
        )
          fail('ACCESS_DENIED');
        changes.push([change.id, this.engine.view(revision, s)]);
      }
      return {
        operationId: previousReplay.operationId,
        repeated: true,
        indexing: this.engine.embedding ? 'pending' : 'ready',
        changes: Object.fromEntries(changes),
      };
    }

    const manifests = new Map<InputToken, import('../core/store.js').ReceiptManifest>();
    for (const change of request.changes)
      if (change.input !== undefined && !manifests.has(change.input))
        manifests.set(change.input, inputManifest(this.engine, change.input, this.binding));

    const proposals: ProposedRevision[] = [];
    for (const item of prepared) {
      const change = item.change;
      let content: AtomContent;
      let receiptId: string | undefined = change.input;
      if (change.op === 'retire') {
        const old = item.previous!;
        if (!receiptId) {
          const trace = { ...s.trace, id: uid('retire') };
          this.engine.bridge(trace, this.binding, true);
          receiptId = trace.id;
          if (old.provenance.kind === 'source')
            // Retirement republishes no evidence. The immutable old origins stay
            // byte-for-byte in the retired revision even when their sources are gone.
            sourceManifest(this.engine, trace.id, [], old.policyId);
        }
        content = {
          schema: old.schema,
          state: 'retired',
          body: clone(old.body),
          slots: clone(old.slots),
          origins: clone(old.origins),
          provenance: {
            ...clone(old.provenance),
            producerId: s.principal.subject,
            inputReceiptId: receiptId,
            dependencyContract: change.input
              ? 'observed-v2'
              : old.provenance.kind === 'source'
                ? 'source-v2'
                : undefined,
          },
          policyId: old.policyId,
          ...(old.validTime ? { validTime: clone(old.validTime) } : {}),
        };
      } else {
        const kind = generated ? (this.binding.actor.generatedOrigin ?? 'derived') : 'source';
        if (!receiptId) {
          const trace = { ...s.trace, id: uid('source') };
          this.engine.bridge(trace, this.binding, true);
          sourceManifest(this.engine, trace.id, item.origins, this.binding.writePolicy);
          receiptId = trace.id;
        }
        content = {
          schema: kind === 'source' ? 'source' : 'atom',
          state: 'active',
          body: bodies.get(change.id) ?? { kind: 'inline', value: change.content.text },
          slots: item.slots,
          origins: item.origins,
          provenance: {
            kind,
            producerId: s.principal.subject,
            inputReceiptId: receiptId,
            dependencyContract: change.input ? 'observed-v2' : 'source-v2',
          },
          policyId: this.binding.writePolicy,
        };
      }
      validateContent(
        content,
        s.principal,
        this.engine.kernel.limits,
        generated && change.op !== 'retire',
      );
      proposals.push({
        atomId: item.atomId,
        revisionId: item.revisionId,
        expectedHead: item.previous?.revisionId ?? null,
        content,
      });
    }
    s.ledger.charge({
      maxAtoms: proposals.length,
      maxBytes: Buffer.byteLength(canonical(proposals)),
    });
    const internalIdempotencyKey = options.idempotencyKey
      ? `v09:${digest(
          canonical([this.binding.writePolicy, this.binding.actor, options.idempotencyKey]),
        )}`
      : uid('operation');
    const result = await this.engine.commit(
      { idempotencyKey: internalIdempotencyKey, guards: [], revisions: proposals },
      s,
      {
        validate: () => {
          this.engine.check(s);
          for (const token of manifests.keys()) inputManifest(this.engine, token, this.binding);
        },
        committed: (committed) => {
          const receiptIds = new Set(proposals.map((p) => p.content.provenance.inputReceiptId));
          for (const receiptId of receiptIds) {
            const outputs = committed.committed.filter((ref) =>
              proposals.some(
                (proposal) =>
                  proposal.revisionId === ref.revisionId &&
                  proposal.content.provenance.inputReceiptId === receiptId,
              ),
            );
            attachOutputs(this.engine, receiptId!, outputs);
          }
          // Resolve inherited outputs after every generation has its complete output set.
          for (const receiptId of receiptIds) attachInheritedOutputs(this.engine, receiptId!);
          if (replayKey)
            this.engine.storage.metaSet(replayKey, {
              version: 3,
              fingerprint,
              operationId: committed.operationId,
              changes: Object.fromEntries(
                request.changes.map((change, index) => [change.id, committed.committed[index]!]),
              ),
            } satisfies ReplayRecord);
        },
      },
    );
    const committedSession = { ...s, at: this.engine.storage.watermark() };
    const changes: [string, AtomView][] = [];
    for (let index = 0; index < request.changes.length; index++) {
      const ref = result.committed[index]!;
      changes.push([
        request.changes[index]!.id,
        this.engine.view(this.engine.storage.get(ref, committedSession.at)!, committedSession),
      ]);
    }
    return {
      operationId: result.operationId,
      repeated: result.repeatedInput,
      indexing: this.engine.embedding ? 'pending' : 'ready',
      changes: Object.fromEntries(changes),
    };
  }
}
