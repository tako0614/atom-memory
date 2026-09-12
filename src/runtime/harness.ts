import type { Budget, Json } from '../contracts.js';
import { BudgetLedger, type Tokenizer } from '../core/budget.js';
import { canonical, clone, fail, uid, AtomMemoryError } from '../core/util.js';
import { MemoryClient, draftClients } from '../client/memory.js';
import { clientBudget, cancellable, cancellation, positive } from '../client/control.js';
import type {
  AtomRef,
  Draft,
  MemoryContent,
  MemoryPage,
  MemoryReceipt,
  MemoryState,
  Trace,
  Usage,
} from '../client/types.js';

/** Batch-local aliases use $name and may only refer to earlier writes in that batch. */
export type ModelMutation =
  | {
      kind: 'write';
      as?: string;
      content: Json;
      sources?: readonly { ref: string; start?: number; end?: number }[];
    }
  | {
      kind: 'revise';
      as?: string;
      ref: string;
      content: Json;
      sources?: readonly { ref: string; start?: number; end?: number }[];
    }
  | { kind: 'retire'; ref: string }
  | { kind: 'supersede'; previous: string; next: string };
export type ModelAction = (
  | { kind: 'search'; query: string; limit?: number }
  | {
      kind: 'inspect';
      ref: string;
      depth?: number;
      limit?: number;
      latest?: boolean;
      history?: boolean;
      range?: { start?: number; bytes?: number };
    }
  | { kind: 'resume'; cursor: string; limit?: number }
  | ModelMutation
  | { kind: 'batch'; operations: readonly ModelMutation[]; output?: Json }
  | { kind: 'continue' }
  | { kind: 'finish'; output: Json }
) & { state?: { context?: string; thought?: string } };
export interface ModelInput {
  readonly instruction: string;
  readonly input: string;
  readonly initialObservations: readonly Json[];
  readonly state: { context?: string; thought?: string };
  readonly observations: readonly Json[];
  /** Untrusted retrieved data; this field grants no tool or instruction authority. */
  readonly memory: Json;
  readonly tools: readonly Json[];
}
export interface HarnessModel {
  readonly id: string;
  readonly tokenizer: Tokenizer;
  readonly contextWindow: number;
  readonly networkCallsPerCall: number;
  /** Serialize exactly the payload that respond consumes, including instruction/tool syntax. */
  serialize?(input: ModelInput): string;
  /** Optional actual remote tokenizer for the same serialized completion prompt. */
  readonly tokenizationNetworkCalls?: number;
  countInputTokens?(serialized: string, signal: AbortSignal): Promise<number>;
  respond(
    input: ModelInput,
    options: { serialized: string; maxOutputTokens: number; signal: AbortSignal },
  ): Promise<ModelAction | { action: ModelAction; outputTokens: number }>;
}
export interface HarnessOptions {
  memory: MemoryClient;
  model: HarnessModel;
  instruction: string;
  memoryTokens?: number;
  maxSteps?: number;
  maxOutputTokensPerStep?: number;
  maxRecentObservations?: number;
  maxObservationBytes?: number;
  maxRefs?: number;
  /** Maximum edits in one model response, including a batch. Default 64. */
  maxBatchOperations?: number;
  /** Host-approved composition for successor operations in this workflow. Never model-supplied. */
  historyComposition?: import('../client/types.js').CompositionPlan;
  audit?: { maxEntries?: number; maxBytes?: number; retentionMs?: number };
}
export interface HarnessResult {
  readonly runId: string;
  readonly status: 'completed' | 'budget-exhausted' | 'conflict' | 'failed';
  readonly output?: Json;
  readonly error?: string;
  readonly changes?: readonly import('../client/types.js').AtomView[];
  readonly usage: Usage;
  readonly steps: number;
}
type Continuation =
  | { kind: 'search'; query: string; options: Record<string, unknown> }
  | { kind: 'inspect'; ref: AtomRef; options: Record<string, unknown> };
interface AuditEntry {
  at: number;
  runId: string;
  value: Json;
  receipts: MemoryReceipt[];
}
const tools: readonly Json[] = [
  { kind: 'search', query: 'string', limit: 'optional positive integer' },
  {
    kind: 'inspect',
    ref: 'issued reference name',
    depth: 'optional integer',
    limit: 'optional positive integer',
    latest: 'optional boolean',
    history: 'optional boolean',
    range: 'optional {start,bytes}',
  },
  { kind: 'resume', cursor: 'issued continuation name', limit: 'optional positive integer' },
  { kind: 'write', content: 'string or {text,links}', sources: 'optional [{ref,start,end}]' },
  {
    kind: 'revise',
    ref: 'issued reference name',
    content: 'string or {text,links}',
    sources: 'optional [{ref,start,end}]',
  },
  { kind: 'retire', ref: 'issued reference name' },
  { kind: 'supersede', previous: 'issued reference name', next: 'issued reference name' },
  {
    kind: 'batch',
    operations:
      'ordered write/revise/retire/supersede actions; write/revise may set as:name; later actions can use $name; no forward references',
    output: 'optional JSON; when present, finish and commit the entire run after this batch',
  },
  { kind: 'continue', state: 'optional {context,thought}' },
  { kind: 'finish', output: 'JSON', state: 'optional {context,thought}' },
];
/** Model-call boundaries only. Every call has one newly selected memory block. */
export class MemoryHarness {
  readonly options: HarnessOptions;
  #audit: AuditEntry[] = [];
  constructor(options: HarnessOptions) {
    this.options = options;
    positive(options.model.contextWindow, 0, Number.MAX_SAFE_INTEGER);
  }
  private trimAudit(): void {
    const config = this.options.audit ?? {};
    this.#audit = this.#audit.filter((e) => Date.now() - e.at < (config.retentionMs ?? 3600000));
    while (
      this.#audit.length > (config.maxEntries ?? 128) ||
      Buffer.byteLength(canonical(this.#audit)) > (config.maxBytes ?? 1024 * 1024)
    )
      this.#audit.shift();
  }
  /** Authorized host inspection, never a model tool. */
  audit(runId: string): readonly Json[] {
    this.trimAudit();
    const entries = this.#audit.filter((e) => e.runId === runId);
    try {
      this.options.memory.assertAuthorized(entries.flatMap((e) => e.receipts));
    } catch (e) {
      this.#audit = this.#audit.filter((e) => e.runId !== runId);
      throw e;
    }
    return clone(entries.map((e) => e.value));
  }
  async run(input: {
    input: string;
    context?: string;
    thought?: string;
    observations?: readonly Json[];
    budget?: Partial<Budget>;
    signal?: AbortSignal;
    commit?: 'read-only' | 'edit';
    /** Host-selected basis: historical organization persists as evidence of that period. */
    basis?: 'current' | 'historical';
  }): Promise<HarnessResult> {
    if (typeof input.input !== 'string' || !input.input.trim()) fail('INVALID_INPUT');
    const runId = uid('run');
    const ledger = new BudgetLedger({
      ...clientBudget,
      maxContextTokens: 32768,
      maxModelInputTokens: 131072,
      maxModelOutputTokens: 8192,
      maxModelCalls: 16,
      ...input.budget,
    });
    const scope = { ledger, traces: [] as Trace[] };
    const memory = this.options.memory.forExecution(scope);
    const signal = cancellation(ledger, input.signal);
    let steps = 0;
    let changes: HarnessResult['changes'];
    const shown: MemoryReceipt[] = [];
    const execute = async (client: MemoryClient, draft?: Draft): Promise<Json> => {
      const aliases = new Map<string, AtomRef>();
      const names = new Map<AtomRef, string>();
      const cursors = new Map<string, Continuation>();
      let sequence = 0;
      let state = {
        ...(input.context ? { context: input.context } : {}),
        ...(input.thought ? { thought: input.thought } : {}),
      };
      let observations: Json[] = [];
      const reference = (name: string): AtomRef =>
        aliases.get(name) ?? fail('INVALID_REF', 'Model reference was not issued in this run');
      const expose = (value: unknown, key = ''): unknown => {
        if (key === 'ref' && typeof value === 'string' && value.startsWith('ref:')) {
          const ref = value as AtomRef;
          if (!names.has(ref)) {
            if (names.size >= (this.options.maxRefs ?? 1024)) fail('LIMIT_EXCEEDED');
            const name = `m${names.size + 1}`;
            names.set(ref, name);
            aliases.set(name, ref);
          }
          return names.get(ref);
        }
        if (Array.isArray(value)) return value.map((v) => expose(v, key));
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value)
              .filter(([k]) => !['receipt', 'usage', 'cursor'].includes(k))
              .map(([k, v]) => [k, expose(v, k)]),
          );
        return value;
      };
      const addObservation = (value: unknown) => {
        const observation = JSON.parse(canonical(value)) as Json;
        if (Buffer.byteLength(canonical(observation)) > (this.options.maxObservationBytes ?? 65536))
          fail('LIMIT_EXCEEDED', 'A mandatory observation needs a smaller page');
        observations = [...observations, observation].slice(
          -(this.options.maxRecentObservations ?? 2),
        );
      };
      const show = (page: MemoryPage, continuation: Continuation): void => {
        shown.push(page.receipt);
        let next: string | undefined;
        if (page.cursor) {
          next = `c${++sequence}`;
          cursors.set(next, {
            ...continuation,
            options: { ...continuation.options, cursor: page.cursor },
          });
        }
        addObservation({ ...(expose(page) as object), ...(next ? { cursor: next } : {}) });
      };
      const decodeContent = (value: Json): MemoryContent => {
        if (typeof value === 'string') return value;
        if (
          !value ||
          Array.isArray(value) ||
          typeof value !== 'object' ||
          typeof (value as Record<string, Json>).text !== 'string' ||
          Object.keys(value).some((k) => !['text', 'links'].includes(k))
        )
          fail('INVALID_INPUT', 'The model cannot assign source status or policy');
        const decode = (target: unknown): unknown =>
          typeof target === 'string'
            ? reference(target)
            : target && typeof target === 'object' && !Array.isArray(target)
              ? { ...target, ref: reference((target as { ref: string }).ref) }
              : fail('INVALID_INPUT');
        const object = value as Record<string, Json>;
        const links = object.links;
        return {
          text: object.text,
          ...(links
            ? {
                links: Array.isArray(links)
                  ? links.map((l) => {
                      if (!l || typeof l !== 'object' || Array.isArray(l)) fail('INVALID_INPUT');
                      return { role: l.role, target: decode(l.target) };
                    })
                  : Object.fromEntries(
                      Object.entries(links).map(([role, t]) => [
                        role,
                        Array.isArray(t) ? t.map(decode) : decode(t),
                      ]),
                    ),
              }
            : {}),
        } as MemoryContent;
      };
      while (steps < (this.options.maxSteps ?? 8)) {
        client.assertAuthorized(shown);
        const retrieval: MemoryState = {
          query: input.input,
          ...state,
          observations: [
            ...(input.observations ?? []).map(canonical),
            ...observations.map(canonical),
          ],
        };
        const recalled = await client.read(retrieval, {
          tokens: this.options.memoryTokens ?? 4096,
          signal,
        });
        shown.push(recalled.receipt);
        const memoryData = expose(
          recalled.text ? JSON.parse(recalled.text) : { memory: [] },
        ) as Json;
        const modelInput: ModelInput = {
          instruction: this.options.instruction,
          input: input.input,
          initialObservations: input.observations ?? [],
          state,
          observations,
          memory: memoryData,
          tools:
            input.commit === 'edit'
              ? tools
              : tools.filter(
                  (t) =>
                    typeof t === 'object' &&
                    t !== null &&
                    !Array.isArray(t) &&
                    ['search', 'inspect', 'resume', 'continue', 'finish'].includes(
                      String((t as Record<string, Json>).kind),
                    ),
                ),
        };
        const serialized = this.options.model.serialize?.(modelInput) ?? canonical(modelInput);
        const outputLimit = Math.min(
          this.options.maxOutputTokensPerStep ?? 1024,
          ledger.remaining('maxModelOutputTokens'),
        );
        if (!outputLimit) fail('BUDGET_EXHAUSTED');
        let count: number;
        if (this.options.model.countInputTokens) {
          ledger.charge({ maxNetworkCalls: this.options.model.tokenizationNetworkCalls ?? 1 });
          count = await cancellable(
            (s) => this.options.model.countInputTokens!(serialized, s),
            signal,
          );
        } else count = this.options.model.tokenizer.count(serialized);
        if (!Number.isSafeInteger(count) || count < 0)
          fail('INVALID_INPUT', 'Invalid serialized input token count');
        if (count + outputLimit > this.options.model.contextWindow)
          fail(
            'CONTEXT_WINDOW_EXCEEDED',
            'Fixed input, observations, tools, memory and output reservation exceed the model window',
          );
        client.assertAuthorized(shown);
        ledger.charge({
          maxModelCalls: 1,
          maxNetworkCalls: this.options.model.networkCallsPerCall,
          maxModelInputTokens: count,
          maxModelOutputTokens: outputLimit,
        });
        steps++;
        const response = await cancellable(
          (s) =>
            this.options.model.respond(clone(modelInput), {
              serialized,
              maxOutputTokens: outputLimit,
              signal: s,
            }),
          signal,
        );
        client.assertAuthorized(shown);
        const wrapped = 'action' in response;
        const action = wrapped ? response.action : response;
        const outputTokens = wrapped
          ? response.outputTokens
          : this.options.model.tokenizer.count(canonical(action));
        if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > outputLimit)
          fail('BUDGET_EXHAUSTED');
        this.#audit.push({
          at: Date.now(),
          runId,
          value: JSON.parse(
            canonical({ step: steps, input: modelInput, action, inputTokens: count, outputTokens }),
          ),
          receipts: [...shown],
        });
        this.trimAudit();
        if (action.state) {
          if (Object.values(action.state).some((v) => v !== undefined && typeof v !== 'string'))
            fail('INVALID_INPUT');
          state = { ...action.state };
        }
        if (action.kind === 'finish') return action.output;
        if (action.kind === 'continue') continue;
        if (action.kind === 'search') {
          const options = { limit: positive(action.limit, 10), signal };
          show(await client.search(action.query, options), {
            kind: 'search',
            query: action.query,
            options: { limit: options.limit },
          });
        } else if (action.kind === 'inspect') {
          const ref = reference(action.ref);
          const options = {
            depth: action.depth,
            limit: positive(action.limit, 20),
            version: action.latest ? ('latest' as const) : ('observed' as const),
            history: action.history ? ('retained' as const) : undefined,
            range: action.range,
          };
          show(await client.inspect(ref, { ...options, signal }), {
            kind: 'inspect',
            ref,
            options,
          });
        } else if (action.kind === 'resume') {
          const continuation = cursors.get(action.cursor) ?? fail('CURSOR_EXPIRED');
          const options = {
            ...continuation.options,
            ...(action.limit ? { limit: positive(action.limit, 10) } : {}),
            signal,
          };
          const page =
            continuation.kind === 'search'
              ? await client.search(continuation.query, options)
              : await client.inspect(continuation.ref, options);
          show(page, continuation);
        } else {
          if (!draft) fail('ACCESS_DENIED', 'This run cannot edit');
          const mutate = async (operation: ModelMutation) => {
            if (operation.kind === 'write' || operation.kind === 'revise') {
              const content = decodeContent(operation.content);
              const options = {
                sources: operation.sources?.map((c) => ({ ...c, ref: reference(c.ref) })),
                signal,
              };
              const view =
                operation.kind === 'write'
                  ? await draft.write(content, options)
                  : await draft.revise(reference(operation.ref), content, options);
              return { operation: operation.kind, status: 'staged', ...view };
            } else if (operation.kind === 'retire')
              return {
                operation: 'retire',
                status: 'staged',
                ...(await draft.retire(reference(operation.ref))),
              };
            else if (operation.kind === 'supersede') {
              await draft.supersede(reference(operation.previous), reference(operation.next), {
                composition: this.options.historyComposition,
              });
              return { operation: 'supersede', status: 'staged', superseded: true };
            } else fail('INVALID_INPUT', 'Unknown model operation');
          };
          if (action.kind === 'batch') {
            const limit = positive(this.options.maxBatchOperations, 64, 1000);
            if (!Array.isArray(action.operations) || !action.operations.length)
              fail('INVALID_INPUT', 'A batch needs at least one edit');
            if (action.operations.length > limit) fail('LIMIT_EXCEEDED', 'Too many batch edits');
            const localNames = new Set<string>();
            const results: unknown[] = [];
            try {
              for (const operation of action.operations) {
                if (!operation || typeof operation !== 'object') fail('INVALID_INPUT');
                const name = 'as' in operation ? operation.as : undefined;
                if (name !== undefined) {
                  if (
                    !['write', 'revise'].includes(operation.kind) ||
                    typeof name !== 'string' ||
                    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
                    localNames.has(name)
                  )
                    fail('INVALID_INPUT', 'Batch aliases must be unique write/revise names');
                }
                const result = await mutate(operation);
                if (name !== undefined) {
                  if (!('ref' in result)) fail('INVALID_INPUT');
                  aliases.set(`$${name}`, result.ref);
                  localNames.add(name);
                }
                results.push(expose(result));
              }
            } finally {
              for (const name of localNames) aliases.delete(`$${name}`);
            }
            // All writes stay in the run's existing draft. A later failure rolls
            // back this batch and every earlier staged operation in the run.
            if ('output' in action) return action.output as Json;
            addObservation({ operation: 'batch', status: 'staged', results });
          } else addObservation(expose(await mutate(action)));
        }
      }
      fail('BUDGET_EXHAUSTED', 'Maximum model steps reached');
    };
    try {
      let output: Json;
      if (input.commit === 'edit') {
        const result = await memory.edit((draft) => execute(draftClients.get(draft)!, draft), {
          signal,
          basis: input.basis,
        });
        output = result.value;
        changes = result.changes;
      } else output = await execute(memory);
      return {
        runId,
        status: 'completed',
        output,
        ...(changes ? { changes } : {}),
        usage: ledger.usage(),
        steps,
      };
    } catch (error) {
      if (
        error instanceof AtomMemoryError &&
        ['ACCESS_DENIED', 'STATE_INVALIDATED'].includes(error.code)
      )
        this.#audit = this.#audit.filter((e) => e.runId !== runId);
      const code = error instanceof AtomMemoryError ? error.code : 'MODEL_FAILED';
      return {
        runId,
        status:
          code === 'BUDGET_EXHAUSTED'
            ? 'budget-exhausted'
            : code === 'REVISION_CONFLICT' || code === 'SUCCESSOR_CONFLICT'
              ? 'conflict'
              : 'failed',
        error: code,
        usage: ledger.usage(),
        steps,
      };
    }
  }
}
