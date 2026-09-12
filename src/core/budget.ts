import type { Budget } from '../contracts.js';
import { clone, fail } from './util.js';
export const defaultBudget: Readonly<Budget> = Object.freeze({
  maxAtoms: 32,
  maxCandidates: 256,
  maxBytes: 262144,
  maxNetworkCalls: 16,
  maxModelCalls: 4,
  maxModelInputTokens: 8192,
  maxContextTokens: 8192,
});
export type Resource = Exclude<keyof Budget, 'deadline'>;
export class BudgetLedger {
  readonly limits: Budget;
  #used: Record<Resource, number>;
  constructor(
    limits: Budget,
    private readonly parent?: BudgetLedger,
  ) {
    for (const key of Object.keys(defaultBudget) as (keyof Budget)[]) {
      const v = limits[key];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
        fail('INVALID_SCHEMA', `Invalid budget ${key}`);
    }
    if (limits.deadline !== undefined && !Number.isFinite(Date.parse(limits.deadline)))
      fail('INVALID_SCHEMA', 'Invalid deadline');
    this.limits = clone(limits);
    this.#used = Object.fromEntries(Object.keys(defaultBudget).map((k) => [k, 0])) as Record<
      Resource,
      number
    >;
  }
  get expired(): boolean {
    return this.limits.deadline !== undefined && Date.now() >= Date.parse(this.limits.deadline);
  }
  remaining(key: Resource): number {
    return Math.min(this.limits[key] - this.#used[key], this.parent?.remaining(key) ?? Infinity);
  }
  can(cost: Partial<Record<Resource, number>>): boolean {
    return (
      !this.expired &&
      Object.entries(cost).every(
        ([k, n]) => Number.isSafeInteger(n) && n! >= 0 && n! <= this.remaining(k as Resource),
      )
    );
  }
  charge(cost: Partial<Record<Resource, number>>): void {
    if (!this.can(cost)) fail('BUDGET_EXHAUSTED');
    this.parent?.charge(cost);
    for (const [k, n] of Object.entries(cost)) this.#used[k as Resource] += n!;
  }
  /** Limit a phase while charging actual usage to the shared operation ledger. */
  window(limits: Partial<Record<Resource, number>>): BudgetLedger {
    return new BudgetLedger({ ...this.limits, ...limits }, this);
  }
  /** Reservation is charged once to the parent; a child cannot spend sibling funds. */
  reserve(limits: Budget): BudgetLedger {
    const child = new BudgetLedger(limits);
    if (
      this.limits.deadline &&
      (!limits.deadline || Date.parse(limits.deadline) > Date.parse(this.limits.deadline))
    )
      fail('BUDGET_EXHAUSTED');
    const { deadline: _, ...cost } = limits;
    this.charge(cost);
    return child;
  }
  usage(): Readonly<Record<Resource, number>> {
    return clone(this.#used);
  }
}
/** Exact tokenizer for a byte-token vocabulary. Supply the target model's tokenizer in production. */
export interface Tokenizer {
  readonly id: string;
  count(text: string): number;
}
export const utf8Tokenizer: Tokenizer = {
  id: 'utf8-bytes-v1',
  count: (text) => Buffer.byteLength(text, 'utf8'),
};
