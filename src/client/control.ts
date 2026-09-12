import type { Budget } from '../contracts.js';
import { BudgetLedger, defaultBudget } from '../core/budget.js';
import { fail } from '../core/util.js';
import type { OperationOptions } from './types.js';
export const clientBudget: Budget = {
  ...defaultBudget,
  maxAtoms: 128,
  maxCandidates: 10000,
  maxBytes: 4 * 1024 * 1024,
  maxContextTokens: 4096,
  maxModelInputTokens: 32768,
  maxModelCalls: 16,
};
export function operationBudget(
  defaults: Partial<Budget>,
  options: OperationOptions,
  shared?: BudgetLedger,
): BudgetLedger {
  const limits = {
    ...clientBudget,
    ...defaults,
    ...options.budget,
    ...(options.deadline ? { deadline: options.deadline } : {}),
  };
  if (shared) return shared;
  return new BudgetLedger(limits);
}
export function cancellation(ledger: BudgetLedger, signal?: AbortSignal): AbortSignal {
  if (signal?.aborted) fail('ABORTED');
  if (ledger.expired) fail('BUDGET_EXHAUSTED');
  const ms = ledger.limits.deadline
    ? Math.max(1, Date.parse(ledger.limits.deadline) - Date.now())
    : 30000;
  const timeout = AbortSignal.timeout(Math.min(ms, 2147483647));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export async function cancellable<T>(
  job: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) fail('ABORTED');
  let remove = () => {};
  const abort = new Promise<never>((_, reject) => {
    const handler = () => {
      try {
        fail('ABORTED');
      } catch (e) {
        reject(e);
      }
    };
    signal.addEventListener('abort', handler, { once: true });
    remove = () => signal.removeEventListener('abort', handler);
  });
  try {
    return await Promise.race([job(signal), abort]);
  } finally {
    remove();
  }
}
export function positive(value: number | undefined, fallback: number, max = 10000): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    fail('INVALID_INPUT', 'Expected a positive finite limit');
  return n;
}
