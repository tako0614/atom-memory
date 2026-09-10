import type { AtomRevision, Origin, PinnedRef } from '../contracts.js';
import type { ReceiptManifest } from '../core/kernel.js';
import { sourceCoverage } from '../core/helpers.js';
import { AtomMemoryError, canonical, digest, fail } from '../core/util.js';
import type { AtomView, Candidate, SourceCitation, Trace } from './types.js';
import { Engine, pinRevision, type GraphState, type Session } from './engine.js';
import { cancellable } from './control.js';

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
      const target = engine.get(slot.target, s);
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
    const current = engine.get({ kind: 'logical', atomId: ref.atomId }, s);
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
  temporary?: { text: string; sources: PinnedRef[] };
}
/** Validate transitive inputs, then regenerate explicitly or return current source material. */
export async function materialize(
  engine: Engine,
  r: AtomRevision,
  s: Session,
  regenerate = true,
): Promise<Materialized> {
  if (compatible(engine, r, s)) {
    if (r.provenance.inputReceiptId && s.derived === 'unused') s.derived = 'ready';
    return { revisions: [r] };
  }
  s.derived = 'pending';
  const originals = new Map<string, AtomRevision>();
  const queue = [r];
  const visited = new Set<string>();
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node.revisionId)) continue;
    visited.add(node.revisionId);
    const m = node.provenance.inputReceiptId
      ? engine.storage.metaGet<ReceiptManifest>(`receipt:${node.provenance.inputReceiptId}`)
      : undefined;
    const refs = [...node.origins.map((o) => o.source), ...(m?.reads ?? [])];
    for (const ref of refs) {
      const current = engine.get({ kind: 'logical', atomId: ref.atomId }, s, true);
      if (current.provenance.kind === 'source') originals.set(current.revisionId, current);
      else if (!visited.has(current.revisionId)) queue.push(current);
    }
  }
  const revisions = [...originals.values()];
  const generator = regenerate ? engine.options.generator : undefined;
  if (!generator || !revisions.length) return { revisions };
  const input = {
    previous: engine.text(r),
    sources: revisions.map((v) => ({ ref: pinRevision(v), text: engine.text(v) })),
  };
  const key = `sdk:cache:derived:${digest(canonical([s.trace.authBinding, s.principal.generation, s.trace.policies, generator.id, r.revisionId, input]))}`;
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
    if (!s.ledger.can(cost)) return { revisions };
    s.ledger.charge(cost);
    text = await cancellable((signal) => generator.generate(input, signal), s.signal);
    engine.check(s);
    if (typeof text !== 'string' || generator.tokenizer.count(text) > generator.maxOutputTokens)
      fail('BUDGET_EXHAUSTED');
    engine.storage.metaSet(key, {
      text,
      until: Date.now() + (engine.options.cacheTtlMs ?? 300000),
    });
    engine.trimCaches();
  }
  s.derived = 'regenerated';
  return { revisions, temporary: { text, sources: revisions.map(pinRevision) } };
}
function bundle(engine: Engine, root: AtomRevision, s: Session): AtomRevision[] | undefined {
  const output: AtomRevision[] = [];
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length) {
    const r = pending.shift()!;
    if (seen.has(r.revisionId)) continue;
    seen.add(r.revisionId);
    engine.get(pinRevision(r), s, true);
    if (r.state === 'retired' || !compatible(engine, r, s)) {
      s.derived = 'pending';
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
  if (r.body.kind !== 'inline' || typeof r.body.value !== 'string' || r.slots.length) return;
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
  if (bytes.toString() === r.body.value) return o;
}
function uncovered(origin: Origin, prior: readonly Origin[]): { start: number; end: number }[] {
  let pieces = [{ start: origin.selector.start, end: origin.selector.end }];
  for (const o of prior) {
    if (
      o.source.atomId !== origin.source.atomId ||
      o.source.revisionId !== origin.source.revisionId
    )
      continue;
    pieces = pieces.flatMap((p) =>
      o.selector.end <= p.start || o.selector.start >= p.end
        ? [p]
        : [
            ...(o.selector.start > p.start ? [{ start: p.start, end: o.selector.start }] : []),
            ...(o.selector.end < p.end ? [{ start: o.selector.end, end: p.end }] : []),
          ],
    );
  }
  return pieces;
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
  const evidence: Origin[] = [];
  const citations: Origin[] = [];
  const temporaries: { text: string; sources: SourceCitation[]; origin: 'generated-cache' }[] = [];
  const deferred: Candidate[] = [];
  let text = '';
  let tokenCount = 0;
  let minimumTokens: number | undefined;
  let used = 0;
  const serialize = (views: AtomView[], origins: Origin[], temporary: typeof temporaries) =>
    canonical({
      memory: views,
      evidence: sourceCoverage(origins).map((o) => ({
        ref: engine.issue(engine.get(o.source, s), s),
        ranges: o.ranges,
      })),
      temporary,
    });
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
      const nextEvidence = [...evidence];
      const nextCitations = [...citations];
      for (const r of all.values()) {
        if (selected.has(r.revisionId)) continue;
        const span = quote(engine, r, s);
        const view = engine.view(r, s, true);
        if (span) {
          const pieces = uncovered(span, nextEvidence);
          if (!pieces.length) continue;
          const source = engine.get(span.source, s);
          const sourceRef = engine.issue(source, s);
          const bytes = Buffer.from(engine.text(source));
          views.push({
            ...view,
            sources: [{ ref: sourceRef, start: span.selector.start, end: span.selector.end }],
          });
          nextEvidence.push(span);
          nextCitations.push(span);
        } else {
          views.push(view);
          nextCitations.push(...r.origins);
        }
      }
      const temporary = material.temporary
        ? {
            text: material.temporary.text,
            sources: material.temporary.sources.map((ref) => ({
              ref: engine.issue(engine.get(ref, s), s),
            })),
            origin: 'generated-cache' as const,
          }
        : undefined;
      if (!views.length && !temporary) continue;
      const nextText = serialize([...items, ...views], nextCitations, [
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
          engine.tokenizer.count(serialize(views, nextCitations, temporary ? [temporary] : [])),
        );
        deferred.push(candidate);
        continue;
      }
      s.ledger.charge({ maxAtoms: views.length });
      items.push(...views);
      all.forEach((r) => selected.add(r.revisionId));
      evidence.splice(0, evidence.length, ...nextEvidence);
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
