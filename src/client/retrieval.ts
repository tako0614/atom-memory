import type { AtomView, Candidate, SourceCitation } from './types.js';
import type { AtomRevision, Origin, PinnedRef } from '../contracts.js';
import type { ReceiptManifest } from '../core/store.js';
import { sourceCoverage } from '../core/helpers.js';
import { AtomMemoryError, canonical, digest, fail } from '../core/util.js';
import { Engine, pinRevision, type GraphState, type Session } from './engine.js';

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
      if (task.depth < state.maxDepth)
        state.tasks.push(
          { ref: task.ref, depth: task.depth, phase: 'forward', slot: 0 },
          { ref: task.ref, depth: task.depth, phase: 'reverse', slot: 0 },
        );
    } else if (task.phase === 'forward') {
      const r = engine.get(task.ref, s);
      if (task.slot >= r.slots.length) {
        state.tasks.shift();
        continue;
      }
      const slot = r.slots[task.slot]!;
      const target = engine.neighbor(slot.target, s, slot.target.kind === 'logical');
      task.slot++;
      if (target && !seen.has(target.revisionId))
        state.tasks.splice(1, 0, {
          ref: pinRevision(target),
          depth: task.depth + 1,
          phase: 'emit',
          slot: 0,
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
  const frozen = historical || m.historicalInputs;
  // Ranking configuration is not evidence. Validate the actual observed inputs below.
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
    // An edit observes its prior revision for CAS and audit. Requiring that old
    // interpretation to stay fresh would make an explicit correction impossible.
    // It remains in the receipt for provenance and transitive purge.
    if (ref.atomId !== r.atomId && !m.ownedRevisionIds?.includes(ref.revisionId)) {
      const input = engine.get(ref, s);
      const watched = (m.currentReads ?? []).some((r) => r.revisionId === ref.revisionId);
      const historicalInput =
        !watched &&
        !!m.generation &&
        typeof m.generation !== 'string' &&
        m.generation.historicalReads?.some((r) => r.revisionId === ref.revisionId);
      const auditOnly = m.dependencyContract === 'observed' && !watched;
      if (!compatible(engine, input, s, new Set(visiting), frozen || historicalInput || auditOnly))
        return false;
    }
  return true;
}
function markStale(engine: Engine, r: AtomRevision, s: Session): void {
  s.derived = 'pending';
  s.pendingDerived = true;
  s.derivedReason = 'dependency-stale';
  s.stale.add(engine.issue(r, s));
}
/** Validate the candidate's evidence without substituting a different Atom.
 * A host may inspect stale references and explicitly decide how to repair them. */
export function validateMemory(engine: Engine, r: AtomRevision, s: Session): boolean {
  engine.check(s);
  const known = s.validated.get(r.revisionId);
  if (known !== undefined) return known;
  const valid = compatible(engine, r, s);
  s.validated.set(r.revisionId, valid);
  if (valid) {
    if (r.provenance.inputReceiptId && s.derived === 'unused') s.derived = 'ready';
    return true;
  }
  markStale(engine, r, s);
  return false;
}
export function bundle(engine: Engine, root: AtomRevision, s: Session): AtomRevision[] | undefined {
  const output: AtomRevision[] = [];
  const pending = [root];
  const seen = new Set<string>();
  for (let position = 0; position < pending.length; position++) {
    s.ledger.charge({ maxPackingWork: 1 });
    const r = pending[position]!;
    if (seen.has(r.revisionId)) continue;
    seen.add(r.revisionId);
    engine.get(pinRevision(r), s);
    if (r.state === 'retired' || !validateMemory(engine, r, s)) {
      (s.blocked ??= new Set()).add(engine.issue(root, s));
      return;
    }
    output.push(r);
    for (const link of r.slots) {
      s.ledger.charge({ maxPackingWork: 1 });
      if (link.mode === 'include' || link.required === true) {
        const target = engine.neighbor(link.target, s, link.target.kind === 'logical');
        if (!target) {
          (s.blocked ??= new Set()).add(engine.issue(root, s));
          return;
        }
        pending.push(target);
      }
    }
  }
  return output;
}
export function quote(engine: Engine, r: AtomRevision, s: Session): Origin | undefined {
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
  items: import('./types.js').MemoryPage['items'][number][];
  text: string;
  tokenCount: number;
  sources: SourceCitation[];
  used: number;
  deferred: Candidate[];
  minimumTokens?: number;
}
export interface PackingSolution {
  revisions: AtomRevision[];
  items: Packed['items'];
  text: string;
  tokenCount: number;
  sources: SourceCitation[];
  utility: number;
}
/** One closure, render, and cost evaluator shared by the frozen baseline and selector. */
export function packingMaterials(
  engine: Engine,
  s: Session,
  candidateByRevision: (id: string) => Candidate | undefined,
) {
  const closures = new Map<string, AtomRevision[] | undefined>();
  const material = new Map<
    string,
    {
      view: AtomView;
      span?: Origin;
      citations: readonly Origin[];
      bytes: number;
      key: string;
      weight: number;
    }
  >();
  const work = (n = 1) => {
    engine.check(s);
    s.ledger.charge({ maxPackingWork: n });
  };
  const closure = (root: AtomRevision) => {
    work();
    if (closures.has(root.revisionId)) return closures.get(root.revisionId);
    const value = bundle(engine, root, s);
    closures.set(root.revisionId, value);
    return value;
  };
  const prepare = (r: AtomRevision) => {
    const prior = material.get(r.revisionId);
    if (prior) return prior;
    work(Buffer.byteLength(canonical(r)));
    const span = quote(engine, r, s);
    const view = engine.view(r, s, true);
    if (span) {
      const source = engine.get(span.source, s);
      const sources = [
        { ref: engine.issue(source, s), start: span.selector.start, end: span.selector.end },
      ];
      Object.assign(view, { sources });
    }
    const value = {
      view,
      span,
      citations: span ? [span] : r.origins,
      bytes: Buffer.byteLength(canonical(view)),
      key: span
        ? canonical({
            source: span.source,
            start: span.selector.start,
            end: span.selector.end,
            attribution: r.provenance.producerId,
            origin: r.provenance.kind,
            slots: r.slots,
          })
        : r.revisionId,
      weight:
        candidateByRevision(r.revisionId)?.activation ??
        candidateByRevision(r.revisionId)?.score ??
        0,
    };
    material.set(r.revisionId, value);
    return value;
  };
  const empty: PackingSolution = {
    revisions: [],
    items: [],
    text: '',
    tokenCount: 0,
    sources: [],
    utility: 0,
  };
  const evaluate = (input: readonly AtomRevision[]): PackingSolution => {
    work();
    const revisions = [...new Map(input.map((r) => [r.revisionId, r])).values()];
    if (!revisions.length) return empty;
    const materials = revisions.map(prepare);
    const inputBytes = materials.reduce((n, m) => n + m.bytes, 0);
    work(inputBytes);
    // Bound serialization before allocating its output. JSON escaping is at most sixfold.
    if (!s.ledger.can({ maxPackingWork: 2 * (inputBytes * 6 + 4096) })) fail('BUDGET_EXHAUSTED');
    const spans = materials.flatMap((m) => (m.span ? [m.span] : []));
    const key = (o: Origin) => canonical(o.source);
    const shared = new Set<string>();
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) {
        work();
        const a = spans[i]!,
          b = spans[j]!;
        if (
          key(a) === key(b) &&
          a.selector.start < b.selector.end &&
          b.selector.start < a.selector.end
        )
          shared.add(key(a));
      }
    const text = canonical({
      formatVersion: 2,
      memory: materials.map(({ view, span }) => {
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
      evidence: sourceCoverage(spans.filter((o) => shared.has(key(o)))).map((o) => {
        const source = engine.get(o.source, s),
          bytes = Buffer.from(engine.text(source));
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
    });
    work(Buffer.byteLength(text) * 2); // Serialization output and tokenizer input are separate work.
    const tokenCount = engine.tokenizer.count(text);
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 0)
      fail('INVALID_INPUT', 'Tokenizer returned an invalid count');
    const classes = new Map<string, number>();
    for (const m of materials) classes.set(m.key, Math.max(classes.get(m.key) ?? 0, m.weight));
    const sources: SourceCitation[] = [];
    for (const coverage of sourceCoverage(materials.flatMap((m) => [...m.citations]))) {
      const ref = engine.issue(engine.get(coverage.source, s), s);
      for (const range of coverage.ranges) sources.push({ ref, ...range });
    }
    return {
      revisions,
      items: materials.map((m, i) => ({
        ...m.view,
        score: candidateByRevision(revisions[i]!.revisionId)?.score ?? 0,
      })),
      text,
      tokenCount,
      sources,
      utility: [...classes.values()].reduce((a, b) => a + b, 0),
    };
  };
  return { closure, evaluate, empty, work };
}

/** Frozen v0.7 rank-order policy, evaluated using the current shared closure/render contract. */
export function createPacking(
  engine: Engine,
  s: Session,
  candidateByRevision: (id: string) => Candidate | undefined,
  tokens: number,
  limit: number,
) {
  const evaluator = packingMaterials(engine, s, candidateByRevision);
  let solution = evaluator.empty,
    finished = false,
    used = 0,
    minimumTokens: number | undefined;
  const deferred: Candidate[] = [];
  const offer = (candidate: Candidate): 'selected' | 'skipped' | 'deferred' | 'exhausted' => {
    if (finished) fail('INVALID_INPUT', 'Packing already finished');
    try {
      if (solution.revisions.some((r) => r.revisionId === candidate.revision.revisionId))
        return 'skipped';
      const unit = evaluator.closure(candidate.revision);
      if (!unit) return 'skipped';
      const next = evaluator.evaluate([...solution.revisions, ...unit]);
      if (
        next.tokenCount > tokens ||
        next.items.length > limit ||
        !s.ledger.can({ maxAtoms: next.items.length - solution.items.length })
      ) {
        const single = evaluator.evaluate(unit);
        minimumTokens = Math.min(minimumTokens ?? Infinity, single.tokenCount);
        deferred.push(candidate);
        return 'deferred';
      }
      s.ledger.charge({ maxAtoms: next.items.length - solution.items.length });
      solution = next;
      used++;
      return 'selected';
    } catch (e) {
      if (e instanceof AtomMemoryError && e.code === 'BUDGET_EXHAUSTED') {
        deferred.push(candidate);
        return 'exhausted';
      }
      throw e;
    }
  };
  const finish = (): Packed => {
    if (finished) fail('INVALID_INPUT', 'Packing already finished');
    engine.check(s);
    s.ledger.charge({ maxContextTokens: solution.tokenCount });
    finished = true;
    return {
      items: solution.items,
      text: solution.text,
      tokenCount: solution.tokenCount,
      sources: solution.sources,
      used,
      deferred,
      ...(minimumTokens ? { minimumTokens } : {}),
    };
  };
  return {
    offer,
    finish,
    deferred,
    has: (id: string) => solution.revisions.some((r) => r.revisionId === id),
    get full() {
      return solution.items.length >= limit;
    },
    get tokenCount() {
      return solution.tokenCount;
    },
    get itemCount() {
      return solution.items.length;
    },
  };
}
export async function pack(
  engine: Engine,
  s: Session,
  candidates: readonly Candidate[],
  tokens: number,
  limit: number,
): Promise<Packed> {
  const ranked = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      Buffer.byteLength(canonical(a.revision.body)) -
        Buffer.byteLength(canonical(b.revision.body)) ||
      a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
  );
  const packing = createPacking(
    engine,
    s,
    (id) => candidates.find((c) => c.revision.revisionId === id),
    tokens,
    limit,
  );
  for (let i = 0; i < ranked.length; i++)
    if (packing.offer(ranked[i]!) === 'exhausted') {
      packing.deferred.push(...ranked.slice(i + 1));
      break;
    }
  return packing.finish();
}
