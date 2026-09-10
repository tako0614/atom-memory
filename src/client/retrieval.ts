import type { AtomRevision, Origin, PinnedRef } from '../contracts.js';
import type { ReceiptManifest } from '../core/kernel.js';
import { sourceCoverage } from '../core/helpers.js';
import { AtomMemoryError, canonical, clone, digest, fail } from '../core/util.js';
import type {
  AcquisitionPlan,
  AtomView,
  Candidate,
  MemoryReceipt,
  SourceCitation,
  Trace,
} from './types.js';
import { Engine, pinRevision, type GraphState, type Session } from './engine.js';
import { cancellable } from './control.js';
import { composition, compositionPage } from './composition.js';

/** A schema-independent, resumable traversal. Both outgoing slots and inverse postings participate. */
export function graphPage(
  engine: Engine,
  s: Session,
  state: GraphState,
  limit: number,
): { revisions: AtomRevision[]; complete: boolean } {
  const revisions: AtomRevision[] = [];
  const seen = new Set(state.seen);
  while (state.tasks.length && revisions.length < limit) {
    engine.check(s);
    const task = state.tasks[0]!;
    if (!s.ledger.can({ maxCandidates: 1 }) && !s.charged.has(task.ref.revisionId)) break;
    if (task.phase === 'emit') {
      if (seen.has(task.ref.revisionId)) {
        state.tasks.shift();
        continue;
      }
      const r = engine.get(task.ref, s);
      seen.add(r.revisionId);
      state.tasks.shift();
      revisions.push(r);
      (state.scores ??= {})[r.revisionId] = task.score ?? 1;
      if (task.depth < state.maxDepth)
        state.tasks.push(
          { ref: task.ref, depth: task.depth, phase: 'forward', slot: 0, score: task.score },
          { ref: task.ref, depth: task.depth, phase: 'reverse', slot: 0, score: task.score },
        );
    } else if (task.phase === 'forward') {
      const r = engine.get(task.ref, s);
      if (task.slot >= r.slots.length) {
        state.tasks.shift();
        continue;
      }
      const slot = r.slots[task.slot]!;
      const target = engine.get(slot.target, s, slot.target.kind === 'logical');
      task.slot++;
      if (!seen.has(target.revisionId))
        state.tasks.splice(1, 0, {
          ref: pinRevision(target),
          depth: task.depth + 1,
          phase: 'emit',
          slot: 0,
          score: (task.score ?? 1) / 2,
        });
      if (task.slot >= r.slots.length) state.tasks.shift();
    } else {
      const available = s.ledger.remaining('maxCandidates');
      if (available < 2) break;
      const count = Math.min(16, Math.floor(available / 2));
      const page = engine.scan(
        {
          policies: [...s.trace.policies],
          relation: { target: task.ref },
          after: task.after,
          limit: count,
        },
        s,
        true,
      );
      s.ledger.charge({ maxCandidates: page.length });
      const next = page.map((r) => ({
        ref: pinRevision(r),
        depth: task.depth + 1,
        phase: 'emit' as const,
        slot: 0,
        score: (task.score ?? 1) / 2,
      }));
      if (page.length < count) {
        state.tasks.shift();
        state.tasks.unshift(...next);
      } else {
        task.after = page.at(-1)!.atomId;
        state.tasks.splice(0, 0, ...next);
      }
    }
  }
  state.seen = [...seen];
  return { revisions, complete: state.tasks.length === 0 };
}
export function graph(root: PinnedRef, depth: number): GraphState {
  return { tasks: [{ ref: root, depth: 0, phase: 'emit', slot: 0 }], seen: [], maxDepth: depth };
}
export async function expand(
  engine: Engine,
  s: Session,
  seeds: readonly Candidate[],
  depth: number,
  limit: number,
): Promise<{ candidates: Candidate[]; complete: boolean; graphs: GraphState[] }> {
  const state: GraphState = {
    tasks: seeds.map((seed) => ({
      ref: pinRevision(seed.revision),
      depth: 0,
      phase: 'emit',
      slot: 0,
      score: seed.score,
    })),
    seen: [],
    maxDepth: depth,
    scores: {},
  };
  const page = graphPage(engine, s, state, limit);
  return {
    candidates: page.revisions
      .map((revision) => ({ revision, score: state.scores?.[revision.revisionId] ?? 0 }))
      .sort(
        (a, b) => b.score - a.score || a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
      ),
    complete: page.complete,
    graphs: page.complete ? [] : [state],
  };
}

function compatible(
  engine: Engine,
  r: AtomRevision,
  s: Session,
  visiting = new Set<string>(),
  historical = false,
): boolean {
  engine.get(pinRevision(r), s);
  if (s.overlay?.revisions.get(r.atomId)?.revisionId === r.revisionId) return true;
  const receiptId = r.provenance.inputReceiptId;
  if (!receiptId || r.provenance.kind === 'source') return true;
  if (visiting.has(r.revisionId)) return false;
  visiting.add(r.revisionId);
  const m = engine.storage.metaGet<ReceiptManifest>(`receipt:${receiptId}`);
  if (!m) return false;
  s.ledger.charge({ maxBytes: Buffer.byteLength(canonical(m)) });
  if (m.policies.some((p) => !s.trace.policies.includes(p))) fail('ACCESS_DENIED');
  const trace = engine.storage.metaGet<Trace>(`sdk:trace:${receiptId}`);
  const frozen = historical || m.historicalInputs;
  if (!frozen && trace && trace.config !== engine.config) return false;
  for (const ref of frozen ? [] : (m.currentReads ?? m.reads)) {
    const current = engine.get({ kind: 'logical', atomId: ref.atomId }, s, true);
    if (current.revisionId !== ref.revisionId) return false;
  }
  for (const observation of frozen ? [] : m.observations) {
    const count = Math.min(observation.query.limit, observation.revisionIds.length + 1);
    if (!s.ledger.can({ maxCandidates: count })) fail('BUDGET_EXHAUSTED');
    const actual = engine.scan({ ...observation.query, limit: count }, s);
    s.ledger.charge({ maxCandidates: actual.length });
    if (canonical(actual.map((r) => r.revisionId)) !== canonical(observation.revisionIds))
      return false;
  }
  for (const ref of m.reads)
    if (ref.revisionId !== r.revisionId && !m.ownedRevisionIds?.includes(ref.revisionId)) {
      const input = engine.get(ref, s);
      if (!compatible(engine, input, s, new Set(visiting), frozen)) return false;
    }
  return true;
}
export interface Materialized {
  revisions: AtomRevision[];
  temporary?: { text: string; sources: PinnedRef[]; receipt: MemoryReceipt };
}
/** Re-evaluate host-recorded conditions at one snapshot. A cursor is never an acquisition plan. */
async function acquire(engine: Engine, s: Session, plans: readonly AcquisitionPlan[]) {
  const revisions = new Map<string, AtomRevision>();
  let complete = true;
  const max = Math.min(engine.options.maxScan ?? 10000, engine.kernel.limits.maxReadCandidates);
  for (const plan of plans) {
    engine.check(s);
    let page: { revisions: AtomRevision[]; complete: boolean };
    if (plan.kind === 'search') {
      const state = clone(plan.state);
      // Only persisted SDK plans may restore an already host-validated signal.
      if (state.signal) engine.signals.add(state.signal);
      const found = await engine.candidates(state, s);
      const seeds = found.candidates.map((c) => ({
        ...c,
        revision: plan.historical
          ? c.revision
          : engine.get(engine.successor(pinRevision(c.revision), s), s),
      }));
      const expanded = await expand(engine, s, seeds, plan.depth, max + 1);
      page = {
        revisions: expanded.candidates.map((c) => c.revision),
        complete: found.complete && expanded.complete,
      };
    } else {
      const root = engine.get(plan.target, s, plan.target.kind === 'logical');
      page =
        root.state === 'retired'
          ? { revisions: [], complete: true }
          : plan.kind === 'inspect' && plan.composition
            ? compositionPage(engine, s, composition(pinRevision(root), plan.composition), max + 1)
            : graphPage(
                engine,
                s,
                graph(pinRevision(root), plan.kind === 'inspect' ? plan.depth : 0),
                max + 1,
              );
    }
    for (const r of page.revisions)
      if (r.state === 'active') {
        engine.record(r, s, plan.kind === 'search');
        revisions.set(r.revisionId, r);
      }
    complete &&= page.complete;
    if (revisions.size > max) return { revisions: [], complete: false };
  }
  return { revisions: [...revisions.values()], complete };
}
function validateGenerationState(engine: Engine, s: Session): void {
  engine.check(s);
  const at = engine.storage.watermark();
  if (at === s.at) return;
  for (const ref of s.trace.current) {
    s.ledger.charge({ maxCandidates: 1 });
    if (
      engine.storage.get({ kind: 'logical', atomId: ref.atomId }, at)?.revisionId !== ref.revisionId
    )
      fail('STATE_INVALIDATED', 'Regeneration inputs changed while the generator was running');
  }
  for (const observation of s.trace.queries) {
    s.ledger.charge({ maxCandidates: observation.query.limit });
    const rows = engine.storage.scan(observation.query, at);
    s.ledger.charge({ maxBytes: Buffer.byteLength(canonical(rows)) });
    if (canonical(rows.map((v) => v.revisionId)) !== canonical(observation.revisions))
      fail('STATE_INVALIDATED', 'Regeneration selection changed while the generator was running');
  }
}
/** Validate transitive inputs; regenerate only after complete declarative reacquisition. */
export async function materialize(
  engine: Engine,
  r: AtomRevision,
  s: Session,
  regenerate = true,
  visiting = new Set<string>(),
): Promise<Materialized> {
  const pending = (revisions: AtomRevision[], reason?: Session['derivedReason']): Materialized => {
    s.pendingDerived = true;
    if (reason) s.derivedReason = reason;
    return { revisions };
  };
  if (compatible(engine, r, s)) {
    if (r.provenance.inputReceiptId && s.derived === 'unused') s.derived = 'ready';
    return { revisions: [r] };
  }
  s.derived = 'pending';
  if (visiting.has(r.revisionId)) {
    return pending([], 'dependency-stale');
  }
  visiting = new Set(visiting).add(r.revisionId);
  const old = engine.storage.metaGet<Trace>(`sdk:trace:${r.provenance.inputReceiptId}`);
  const recorded = old?.plans ?? [];
  // Explicit citations are audit provenance when a retrieval plan exists, not extra current members.
  const retrieval = recorded.filter((p) => p.kind !== 'source');
  const plans = retrieval.length ? retrieval : recorded;
  const fresh = engine.session(
    s.binding,
    { signal: s.signal },
    s.ledger,
    s.overlay,
    s.at,
    digest(canonical(plans)),
  );
  fresh.trace.plans = clone(plans);
  if (!plans.length) {
    // Old receipts cannot recover selection intent. Only explicitly cited source material is a fallback.
    const revisions = r.origins
      .map((o) => engine.get(o.source, s))
      .filter((v) => v.provenance.kind === 'source' && v.state === 'active');
    return pending(revisions, 'missing-plan');
  }
  const selected = await acquire(engine, fresh, plans);
  const originals = new Map<string, AtomRevision>();
  let complete = selected.complete;
  let unsupported = false;
  const nodes = [
    ...selected.revisions,
    ...r.slots
      .filter((slot) => slot.mode === 'include' || slot.required)
      .map((slot) => engine.get(slot.target, fresh, slot.target.kind === 'logical')),
  ];
  for (const node of nodes) {
    if (node.revisionId === r.revisionId) continue;
    const unit = bundle(engine, node, fresh);
    if (!unit) {
      complete = false;
      const fallback = await materialize(engine, node, fresh, false, visiting);
      for (const v of fallback.revisions) originals.set(v.revisionId, v);
      continue;
    }
    for (const value of unit) {
      if (value.body.kind === 'blob') unsupported = true;
      originals.set(value.revisionId, value);
      for (const origin of value.origins) {
        const source = engine.get(origin.source, fresh);
        if (source.body.kind === 'blob') unsupported = true;
        if (source.state === 'active') originals.set(source.revisionId, source);
      }
    }
  }
  const revisions = [...originals.values()];
  const atoms = revisions.map((v) => engine.view(v, fresh, false));
  // Dependency checks and model inputs belong to the caller's audit too, even when no generator runs.
  s.trace = engine.merge([s.trace, fresh.trace], s.binding, s.at);
  if (!complete || unsupported) {
    return pending(
      revisions,
      unsupported
        ? 'unsupported-input'
        : selected.complete
          ? 'dependency-stale'
          : 'acquisition-incomplete',
    );
  }
  const generator = regenerate ? engine.options.generator : undefined;
  if (!generator) return pending(revisions);
  const receipt = engine.trace(fresh);
  const content = {
    previous: engine.text(r),
    sources: revisions.map((v) => ({ ref: pinRevision(v), text: engine.text(v) })),
    atoms,
  };
  const input = { ...content, receipt };
  const key = `sdk:cache:derived:${digest(canonical([s.trace.authBinding, s.principal.generation, s.trace.policies, engine.config, r.revisionId, content]))}`;
  const cached = engine.storage.metaGet<{ text: string; until: number }>(key);
  let text: string;
  if (cached && cached.until > Date.now()) text = cached.text;
  else {
    const cost = {
      maxModelCalls: 1,
      maxNetworkCalls: generator.networkCallsPerCall,
      maxModelInputTokens: generator.tokenizer.count(canonical(input)),
      maxModelOutputTokens: generator.maxOutputTokens,
    };
    if (!s.ledger.can(cost)) {
      return pending(revisions, 'budget');
    }
    s.ledger.charge(cost);
    text = await cancellable((signal) => generator.generate(input, signal), s.signal);
    engine.check(s);
    validateGenerationState(engine, fresh);
    if (typeof text !== 'string' || generator.tokenizer.count(text) > generator.maxOutputTokens)
      fail('BUDGET_EXHAUSTED');
    engine.storage.metaSet(key, {
      text,
      input: clone(fresh.trace),
      until: Date.now() + (engine.options.cacheTtlMs ?? 300000),
    });
    engine.trimCaches();
  }
  s.derived = 'regenerated';
  return { revisions, temporary: { text, sources: revisions.map(pinRevision), receipt } };
}
function bundle(engine: Engine, root: AtomRevision, s: Session): AtomRevision[] | undefined {
  const output: AtomRevision[] = [];
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length) {
    const r = pending.shift()!;
    if (seen.has(r.revisionId)) continue;
    seen.add(r.revisionId);
    engine.get(pinRevision(r), s);
    if (r.state === 'retired' || !compatible(engine, r, s)) {
      s.derived = 'pending';
      s.pendingDerived = true;
      return;
    }
    output.push(r);
    for (const link of r.slots)
      if (link.mode === 'include' || link.required === true)
        pending.push(engine.get(link.target, s, link.target.kind === 'logical'));
  }
  return output;
}
function quote(engine: Engine, r: AtomRevision, s: Session): Origin | undefined {
  if (r.body.kind !== 'inline' || typeof r.body.value !== 'string') return;
  if (Buffer.from(r.body.value).toString('utf8') !== r.body.value) return;
  if (r.provenance.kind === 'source')
    return {
      source: pinRevision(r),
      selector: {
        kind: 'utf8',
        start: 0,
        end: Buffer.byteLength(r.body.value),
        quoteDigest: digest(r.body.value),
      },
    };
  if (r.provenance.kind !== 'extraction' || r.origins.length !== 1) return;
  const o = r.origins[0]!;
  const source = engine.get(o.source, s);
  if (source.body.kind !== 'inline' || typeof source.body.value !== 'string') return;
  const bytes = Buffer.from(source.body.value).subarray(o.selector.start, o.selector.end);
  if (
    bytes.toString() === r.body.value &&
    (!o.selector.quoteDigest || digest(bytes) === o.selector.quoteDigest)
  )
    return o;
}
export interface Packed {
  items: AtomView[];
  text: string;
  tokenCount: number;
  sources: SourceCitation[];
  used: number;
  deferred: Candidate[];
  minimumTokens?: number;
}
export async function pack(
  engine: Engine,
  s: Session,
  candidates: readonly Candidate[],
  tokens: number,
  limit: number,
): Promise<Packed> {
  const items: AtomView[] = [];
  const selected = new Set<string>();
  const quotes = new Map<AtomView['ref'], Origin>();
  const citations: Origin[] = [];
  const temporaries: { text: string; sources: SourceCitation[]; origin: 'generated-cache' }[] = [];
  const deferred: Candidate[] = [];
  let text = '';
  let tokenCount = 0;
  let minimumTokens: number | undefined;
  let used = 0;
  const serialize = (views: AtomView[], spans: typeof quotes, temporary: typeof temporaries) => {
    const selected = views.flatMap((v) => (spans.has(v.ref) ? [spans.get(v.ref)!] : []));
    const key = (o: Origin) => canonical(o.source);
    const shared = new Set<string>();
    for (let i = 0; i < selected.length; i++)
      for (let j = i + 1; j < selected.length; j++) {
        const a = selected[i]!,
          b = selected[j]!;
        if (
          key(a) === key(b) &&
          a.selector.start < b.selector.end &&
          b.selector.start < a.selector.end
        )
          shared.add(key(a));
      }
    return canonical({
      memory: views.map((view) => {
        const span = spans.get(view.ref);
        if (!span || !shared.has(key(span))) return view;
        const { text: _text, ...metadata } = view;
        return {
          ...metadata,
          quote: {
            ref: engine.issue(engine.get(span.source, s), s),
            start: span.selector.start,
            end: span.selector.end,
            unit: 'utf8',
          },
        };
      }),
      evidence: sourceCoverage(selected.filter((o) => shared.has(key(o)))).map((o) => {
        const source = engine.get(o.source, s);
        const bytes = Buffer.from(engine.text(source));
        return {
          ref: engine.issue(source, s),
          unit: 'utf8',
          ranges: o.ranges.map((range, i) => ({
            ...range,
            ...(i > 0 ? { omittedBefore: { start: o.ranges[i - 1]!.end, end: range.start } } : {}),
            text: bytes.subarray(range.start, range.end).toString('utf8'),
          })),
        };
      }),
      temporary,
    });
  };
  const ranked = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      Buffer.byteLength(canonical(a.revision.body)) -
        Buffer.byteLength(canonical(b.revision.body)) ||
      a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
  );
  for (let index = 0; index < ranked.length; index++) {
    const candidate = ranked[index]!;
    try {
      if (candidate.revision.state === 'retired' || selected.has(candidate.revision.revisionId))
        continue;
      if (items.length >= limit) {
        deferred.push(candidate);
        continue;
      }
      let material: Materialized;
      material = await materialize(engine, candidate.revision, s);
      const all = new Map<string, AtomRevision>();
      let missingCompanion = false;
      for (const r of material.revisions) {
        const unit = bundle(engine, r, s);
        if (!unit) {
          missingCompanion = true;
          break;
        }
        for (const dep of unit) all.set(dep.revisionId, dep);
      }
      if (missingCompanion) continue;
      const views: AtomView[] = [];
      const nextQuotes = new Map(quotes);
      const nextCitations = [...citations];
      for (const r of all.values()) {
        if (selected.has(r.revisionId)) continue;
        const span = quote(engine, r, s);
        const view = engine.view(r, s, true);
        if (span) {
          const source = engine.get(span.source, s);
          const sourceRef = engine.issue(source, s);
          views.push({
            ...view,
            sources: [{ ref: sourceRef, start: span.selector.start, end: span.selector.end }],
          });
          nextQuotes.set(view.ref, span);
          nextCitations.push(span);
        } else {
          views.push(view);
          nextCitations.push(...r.origins);
        }
      }
      const temporary = material.temporary
        ? {
            text: material.temporary.text,
            receipt: material.temporary.receipt,
            sources: material.temporary.sources.map((ref) => ({
              ref: engine.issue(engine.get(ref, s), s),
            })),
            origin: 'generated-cache' as const,
          }
        : undefined;
      if (!views.length && !temporary) continue;
      const nextText = serialize([...items, ...views], nextQuotes, [
        ...temporaries,
        ...(temporary ? [temporary] : []),
      ]);
      const count = engine.tokenizer.count(nextText);
      if (!Number.isSafeInteger(count) || count < 0)
        fail('INVALID_INPUT', 'Tokenizer returned an invalid count');
      if (
        count > tokens ||
        items.length + views.length > limit ||
        !s.ledger.can({ maxAtoms: views.length })
      ) {
        minimumTokens = Math.min(
          minimumTokens ?? Infinity,
          engine.tokenizer.count(serialize(views, nextQuotes, temporary ? [temporary] : [])),
        );
        deferred.push(candidate);
        continue;
      }
      s.ledger.charge({ maxAtoms: views.length });
      items.push(...views);
      all.forEach((r) => selected.add(r.revisionId));
      for (const [ref, span] of nextQuotes) quotes.set(ref, span);
      citations.splice(0, citations.length, ...nextCitations);
      if (temporary) temporaries.push(temporary);
      text = nextText;
      tokenCount = count;
      used++;
    } catch (e) {
      if (e instanceof AtomMemoryError && e.code === 'BUDGET_EXHAUSTED') {
        deferred.push(...ranked.slice(index));
        break;
      }
      throw e;
    }
  }
  s.ledger.charge({ maxContextTokens: tokenCount });
  const sources: SourceCitation[] = [];
  for (const c of sourceCoverage(citations)) {
    const source = engine.get(c.source, s);
    const ref = engine.issue(source, s);
    for (const range of c.ranges) sources.push({ ref, start: range.start, end: range.end });
  }
  return {
    items,
    text,
    tokenCount,
    sources,
    used,
    deferred,
    ...(minimumTokens ? { minimumTokens } : {}),
  };
}
