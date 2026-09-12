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
      const target = engine.get(slot.target, s, slot.target.kind === 'logical');
      task.slot++;
      if (!seen.has(target.revisionId))
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
      if (!compatible(engine, input, s, new Set(visiting), frozen)) return false;
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
      markStale(engine, root, s);
      markStale(engine, r, s);
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
  const items: import('./types.js').MemoryPage['items'][number][] = [];
  const selected = new Set<string>();
  const quotes = new Map<AtomView['ref'], Origin>();
  const citations: Origin[] = [];
  const deferred: Candidate[] = [];
  let text = '';
  let tokenCount = 0;
  let minimumTokens: number | undefined;
  let used = 0;
  const serialize = (views: AtomView[], spans: typeof quotes) => {
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
      memory: views.map((item) => {
        const {
          score: _score,
          scoreBreakdown: _breakdown,
          ...view
        } = item as AtomView & { score?: number; scoreBreakdown?: unknown };
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
      if (!validateMemory(engine, candidate.revision, s)) continue;
      const unit = bundle(engine, candidate.revision, s);
      if (!unit) continue;
      const all = new Map(unit.map((r) => [r.revisionId, r]));
      const views: AtomView[] = [];
      const nextQuotes = new Map(quotes);
      const nextCitations = [...citations];
      for (const r of all.values()) {
        if (selected.has(r.revisionId)) continue;
        const span = quote(engine, r, s);
        const scored = candidates.find(
          (candidate) => candidate.revision.revisionId === r.revisionId,
        );
        const view = {
          ...engine.view(r, s, true),
          score: scored?.score ?? 0,
          scoreBreakdown: scored?.scoreBreakdown ?? { direct: 0, structural: 0 },
        };
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
      if (!views.length) continue;
      const nextText = serialize([...items, ...views], nextQuotes);
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
          engine.tokenizer.count(serialize(views, nextQuotes)),
        );
        deferred.push(candidate);
        continue;
      }
      s.ledger.charge({ maxAtoms: views.length });
      items.push(...views);
      all.forEach((r) => selected.add(r.revisionId));
      for (const [ref, span] of nextQuotes) quotes.set(ref, span);
      citations.splice(0, citations.length, ...nextCitations);
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
