import type {
  AuthContext,
  Budget,
  Harness,
  Json,
  ProposedRevision,
  ReadContext,
  ReadRequest,
  ReadResult,
  Ref,
  Selector,
  WriteRequest,
} from '../contracts.js';
import { AtomKernel } from '../core/kernel.js';
import { BudgetLedger, type Resource, type Tokenizer } from '../core/budget.js';
import { AtomMemoryError, canonical, clone, fail, uid } from '../core/util.js';
export type ModelAction =
  | { kind: 'read'; selector: Selector; render?: ReadRequest['render'] }
  | { kind: 'stage'; revisions: readonly ProposedRevision[] }
  | { kind: 'finish'; output: Json };
export interface ModelInput {
  instruction: string;
  records: readonly Json[];
}
export interface HarnessModel {
  readonly id: string;
  readonly tokenizer: Tokenizer;
  readonly networkCallsPerCall: number;
  respond(
    input: ModelInput,
    options: { maxOutputTokens: number; signal: AbortSignal },
  ): Promise<ModelAction>;
}
export interface Instruction {
  readonly text: string;
  readonly model: HarnessModel;
  /** Host decision immediately before commit. The model cannot replace this callback. */
  readonly approve?: (request: WriteRequest) => boolean | Promise<boolean>;
}
export interface HarnessOptions {
  kernel: AtomKernel;
  instructions: Readonly<Record<string, Instruction>>;
  readBudget?: Partial<Budget>;
  maxOutputTokensPerStep?: number;
}
export class AgentHarness implements Harness {
  #kernel: AtomKernel;
  #instructions: Readonly<Record<string, Instruction>>;
  #readBudget: Partial<Budget>;
  #maxOutput: number;
  constructor(options: HarnessOptions) {
    this.#kernel = options.kernel;
    this.#instructions = options.instructions;
    this.#readBudget = options.readBudget ?? {};
    this.#maxOutput = options.maxOutputTokensPerStep ?? 1024;
  }
  async run(input: {
    instructionId: string;
    inputRefs: readonly Ref[];
    auth: AuthContext;
    readContext: ReadContext;
    budget: Budget;
    commitPolicy: 'read-only' | 'host-validated-edits';
  }): Promise<{
    status: 'completed' | 'budget-exhausted' | 'conflict' | 'failed';
    output?: Json;
    proposedChanges?: WriteRequest;
  }> {
    const instruction = this.#instructions[input.instructionId];
    if (!instruction) fail('ACCESS_DENIED', 'Unknown host instruction');
    const ledger = new BudgetLedger(input.budget);
    let overlay: string | undefined;
    const records: Json[] = [];
    const receipts: string[] = [];
    let proposed: readonly ProposedRevision[] = [];
    const requestRead = async (selector: Selector, render: ReadRequest['render'] = 'mixed') => {
      const budget = { ...input.budget, ...this.#readBudget };
      for (const key of Object.keys(ledger.usage()) as Resource[])
        budget[key] = Math.min(budget[key], ledger.remaining(key));
      // Search embeddings and the model share the same host ledger.
      const read = await this.#kernel.read(
        {
          selector,
          context: { ...input.readContext, ...(overlay ? { overlayHandle: overlay } : {}) },
          budget,
          render,
        },
        input.auth,
      );
      ledger.charge(read.usage);
      receipts.push(read.receipt.receiptId);
      records.push(JSON.parse(canonical({ kind: 'memory-data', result: read })) as Json);
      return read;
    };
    try {
      if (input.commitPolicy === 'host-validated-edits')
        overlay = this.#kernel.createOverlay(input.auth);
      await requestRead({ kind: 'refs', refs: input.inputRefs });
      while (true) {
        const modelInput = { instruction: instruction.text, records };
        const inTokens = instruction.model.tokenizer.count(canonical(modelInput));
        const outputLimit = Math.min(this.#maxOutput, ledger.remaining('maxModelOutputTokens'));
        if (outputLimit === 0) fail('BUDGET_EXHAUSTED');
        // Reserve the entire completion cap before invoking an external model; failures/retries still spend it.
        ledger.charge({
          maxModelCalls: 1,
          maxNetworkCalls: instruction.model.networkCallsPerCall,
          maxModelInputTokens: inTokens,
          maxModelOutputTokens: outputLimit,
        });
        const signal = AbortSignal.timeout(
          input.budget.deadline
            ? Math.max(1, Date.parse(input.budget.deadline) - Date.now())
            : 30000,
        );
        const action = await Promise.race([
          instruction.model.respond(clone(modelInput), { maxOutputTokens: outputLimit, signal }),
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('Model deadline exceeded')), {
              once: true,
            }),
          ),
        ]);
        if (instruction.model.tokenizer.count(canonical(action)) > outputLimit)
          fail('BUDGET_EXHAUSTED');
        records.push(JSON.parse(canonical({ kind: 'model-action', action })) as Json);
        if (action.kind === 'read') await requestRead(action.selector, action.render);
        else if (action.kind === 'stage') {
          if (!overlay) fail('ACCESS_DENIED', 'This run cannot edit');
          const receipt = this.#kernel.combineReceipts(receipts, input.auth);
          proposed = action.revisions.map((r) => ({
            ...clone(r),
            content: {
              ...clone(r.content),
              provenance: { ...clone(r.content.provenance), inputReceiptId: receipt.receiptId },
            },
          }));
          this.#kernel.stage(overlay, proposed, input.auth);
        } else if (action.kind === 'finish') {
          if (!proposed.length) return { status: 'completed', output: action.output };
          const receipt = this.#kernel.combineReceipts(receipts, input.auth);
          const request: WriteRequest = {
            idempotencyKey: uid('harness'),
            guards: [],
            actorInputReceiptId: receipt.receiptId,
            revisions: proposed.map((r) => ({
              ...r,
              content: {
                ...r.content,
                provenance: { ...r.content.provenance, inputReceiptId: receipt.receiptId },
              },
            })),
          };
          if (!instruction.approve || !(await instruction.approve(clone(request))))
            return { status: 'failed', proposedChanges: request };
          await this.#kernel.write(request, input.auth);
          return { status: 'completed', output: action.output, proposedChanges: request };
        } else fail('INVALID_SCHEMA', 'Unknown model action');
      }
    } catch (error) {
      if (error instanceof AtomMemoryError && error.code === 'BUDGET_EXHAUSTED')
        return { status: 'budget-exhausted' };
      if (error instanceof AtomMemoryError && error.code === 'REVISION_CONFLICT')
        return { status: 'conflict' };
      return { status: 'failed' };
    } finally {
      if (overlay) this.#kernel.discardOverlay(overlay, input.auth);
    }
  }
}
