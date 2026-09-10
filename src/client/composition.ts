import type { AtomRevision, PinnedRef } from '../contracts.js';
import { canonical, clone, fail } from '../core/util.js';
import { Engine, pinRevision, type Session } from './engine.js';
import type { CompositionPlan } from './types.js';

type Task =
  | { kind: 'node'; ref: PinnedRef; expand: boolean }
  | { kind: 'scan'; ref: PinnedRef; rule: number; after?: string }
  | { kind: 'relation'; ref: PinnedRef; rule: number };
export interface CompositionState {
  plan: CompositionPlan;
  tasks: Task[];
  seen: string[];
  expanded: string[];
}
export function validateComposition(plan: CompositionPlan): CompositionPlan {
  if (
    !plan ||
    !Array.isArray(plan.relations) ||
    Object.keys(plan).some((k) => k !== 'relations') ||
    Buffer.byteLength(canonical(plan)) > 16384 ||
    plan.relations.some(
      (r) =>
        !r ||
        typeof r.parent !== 'string' ||
        !r.parent.length ||
        !Array.isArray(r.children) ||
        !r.children.length ||
        r.children.some((c: unknown) => typeof c !== 'string' || !c.length) ||
        ![undefined, true, false].includes(r.recursive) ||
        Object.keys(r).some((k) => !['parent', 'children', 'recursive'].includes(k)),
    )
  )
    fail('INVALID_INPUT', 'Expected a finite declarative composition plan');
  return clone(plan);
}
export function composition(root: PinnedRef, plan: CompositionPlan): CompositionState {
  return {
    plan: validateComposition(plan),
    tasks: [{ kind: 'node', ref: root, expand: true }],
    seen: [],
    expanded: [],
  };
}
/** Directed composition only. A shared child's incoming references are never followed implicitly. */
export function compositionPage(
  engine: Engine,
  s: Session,
  state: CompositionState,
  limit: number,
) {
  const revisions: AtomRevision[] = [];
  const seen = new Set(state.seen);
  const expanded = new Set(state.expanded);
  while (state.tasks.length && revisions.length < limit) {
    engine.check(s);
    if (!s.ledger.can({ maxCandidates: 2 })) break;
    s.ledger.charge({ maxCandidates: 1 });
    const task = state.tasks[0]!;
    if (task.kind === 'scan') {
      const rule = state.plan.relations[task.rule]!;
      const count = Math.min(16, s.ledger.remaining('maxCandidates'));
      const rows = engine.scan(
        {
          policies: s.trace.policies,
          relation: { target: task.ref, role: rule.parent },
          after: task.after,
          limit: count,
        },
        s,
        true,
      );
      s.ledger.charge({ maxCandidates: rows.length, maxBytes: Buffer.byteLength(canonical(rows)) });
      if (rows.length < count) state.tasks.shift();
      else task.after = rows.at(-1)!.atomId;
      state.tasks.unshift(
        ...rows.map((r) => ({ kind: 'relation' as const, ref: pinRevision(r), rule: task.rule })),
      );
      continue;
    }
    const r = engine.get(task.ref, s);
    state.tasks.shift();
    if (r.state === 'retired') continue;
    if (!seen.has(r.revisionId)) {
      seen.add(r.revisionId);
      revisions.push(r);
      for (const slot of r.slots)
        if (slot.mode === 'include' || slot.required) {
          const child = engine.get(slot.target, s, slot.target.kind === 'logical');
          state.tasks.push({ kind: 'node', ref: pinRevision(child), expand: false });
        }
    }
    if (task.kind === 'relation') {
      const rule = state.plan.relations[task.rule]!;
      for (const slot of r.slots)
        if (rule.children.includes(slot.role)) {
          const child = engine.get(slot.target, s, slot.target.kind === 'logical');
          state.tasks.push({
            kind: 'node',
            ref: pinRevision(child),
            expand: rule.recursive === true,
          });
        }
    } else if (task.expand && !expanded.has(r.revisionId)) {
      expanded.add(r.revisionId);
      state.tasks.push(
        ...state.plan.relations.map((_, rule) => ({ kind: 'scan' as const, ref: task.ref, rule })),
      );
    }
  }
  state.seen = [...seen];
  state.expanded = [...expanded];
  return { revisions, complete: state.tasks.length === 0 };
}
