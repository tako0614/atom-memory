import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AtomKernel,
  LocalAuthority,
  MemoryStorage,
  LegacyAgentHarness as AgentHarness,
  content,
  logical,
  pin,
  membership,
  origin,
  defaultBudget,
  utf8Tokenizer,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
const budget = {
  ...defaultBudget,
  maxAtoms: 128,
  maxCandidates: 500,
  maxBytes: 2000000,
  maxContextTokens: 100000,
  maxModelInputTokens: 100000,
  maxModelOutputTokens: 10000,
  maxModelCalls: 10,
};
const ctx = { requestedPolicyIds: ['p'], consistency: { mode: 'snapshot' } };
const item = (id, c = content('source', id, 'p'), expectedHead = null, revisionId = id + ':1') => ({
  atomId: id,
  revisionId,
  expectedHead,
  content: c,
});
const req = (revisions, extra = {}) => ({
  idempotencyKey: crypto.randomUUID(),
  revisions,
  guards: [],
  ...extra,
});
const fixture = (options = {}) => {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'host',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  return { authority, auth, k: new AtomKernel({ authority, ...options }) };
};
const read = (k, auth, ids, options = {}) =>
  k.read(
    {
      selector: { kind: 'refs', refs: ids.map(logical) },
      context: ctx,
      budget,
      render: 'mixed',
      ...options,
    },
    auth,
  );
const code = (c) => (e) => e.code === c;
test('SQLite receipts, history, idempotency and continuations survive reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-memory-reopen-'));
  let storage = new SqliteStorage(join(dir, 'data.sqlite'));
  try {
    const { k, auth, authority } = fixture({ storage });
    const write = req([item('A'), item('B')]);
    await k.write(write, auth);
    const page = await read(k, auth, ['A', 'B'], { budget: { ...budget, maxAtoms: 1 } });
    storage.close();
    storage = new SqliteStorage(join(dir, 'data.sqlite'));
    const reopened = new AtomKernel({ storage, authority });
    assert.equal((await reopened.write(write, auth)).repeatedInput, true);
    const next = await read(reopened, auth, ['A', 'B'], {
      budget: { ...budget, maxAtoms: 1 },
      continuation: page.continuation,
    });
    assert.equal(next.atoms[0].atomId, 'B');
    assert.equal(storage.history(undefined, 100).length, 2);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('runtime rejects logical includes, malformed UTF-8 offsets and digest mismatches', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A', content('source', '日本語', 'p'))]), auth);
  await assert.rejects(
    k.write(
      req([
        item(
          'P',
          content('collection', 'P', 'p', {
            slots: [{ role: 'part', mode: 'include', target: logical('A') }],
          }),
        ),
      ]),
      auth,
    ),
    code('PINNED_INCLUDE_REQUIRED'),
  );
  assert.throws(() => origin(pin('A', 'A:1'), '日本語', 1, 3), code('INVALID_SOURCE_SPAN'));
  const trace = await read(k, auth, ['A']);
  const sourceOrigin = origin(pin('A', 'A:1'), '日本語');
  sourceOrigin.selector.quoteDigest = '0'.repeat(64);
  await assert.rejects(
    k.write(
      req([
        item(
          'E',
          content('extract', '日本語', 'p', {
            origins: [sourceOrigin],
            provenance: {
              kind: 'extraction',
              producerId: 'writer',
              inputReceiptId: trace.receipt.receiptId,
            },
          }),
        ),
      ]),
      auth,
    ),
    code('INVALID_SOURCE_SPAN'),
  );
});
test('range guard catches insertion after an empty read', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('P', content('collection', 'P', 'p'))]), auth);
  const query = { kind: 'relations', target: logical('P'), schema: 'membership', role: 'group' };
  const empty = await read(k, auth, [], { selector: query });
  assert.equal(empty.atoms.length, 0);
  const observation = k.inspectReceipt(empty.receipt.receiptId, auth).observations[0];
  await k.write(req([item('B'), item('PB', membership('P', 'B', 'p'))]), auth);
  await assert.rejects(
    k.write(
      req([item('C')], {
        guards: [{ kind: 'query-observation', observationId: observation.observationId }],
      }),
      auth,
    ),
    code('REVISION_CONFLICT'),
  );
});
test('persistent derivatives retain all observed policies even when citations are omitted', async () => {
  const { k, authority } = fixture();
  const auth = authority.issue({
    subject: 'multi',
    readPolicies: ['p', 'secret'],
    writePolicies: ['p', 'secret'],
    canIngestSource: true,
  });
  await k.write(
    req([item('A'), item('secret', content('source', 'private text', 'secret'))]),
    auth,
  );
  const input = await read(k, auth, ['A', 'secret'], {
    context: { ...ctx, requestedPolicyIds: ['p', 'secret'] },
  });
  await assert.rejects(
    k.write(
      req([
        item(
          'summary',
          content('summary', 'leak', 'p', {
            provenance: {
              kind: 'derived',
              producerId: 'writer',
              inputReceiptId: input.receipt.receiptId,
            },
          }),
        ),
      ]),
      auth,
    ),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    k.write(
      req([
        item(
          'ref',
          content('statement', 'leak', 'p', {
            slots: [{ role: 'object', mode: 'refer', target: logical('secret') }],
          }),
        ),
      ]),
      auth,
    ),
    code('ACCESS_DENIED'),
  );
});
test('cursor is bound to caller, query, current grant generation and expiry', async () => {
  const { k, auth, authority } = fixture();
  await k.write(req([item('A'), item('B')]), auth);
  const page = await read(k, auth, ['A', 'B'], { budget: { ...budget, maxAtoms: 1 } });
  const other = authority.issue({ subject: 'host', readPolicies: ['p'], writePolicies: ['p'] });
  await assert.rejects(
    read(k, other, ['A', 'B'], { continuation: page.continuation }),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    read(k, auth, ['B'], { continuation: page.continuation }),
    code('CURSOR_EXPIRED'),
  );
  authority.update(auth, {
    subject: 'host',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  await assert.rejects(
    read(k, auth, ['A', 'B'], { continuation: page.continuation }),
    code('ACCESS_DENIED'),
  );
});
test('purge removes historical retired summaries and prior blob bodies', async () => {
  const { k, auth } = fixture();
  const blob = k.putBlob(Buffer.from('private source'), 'p', 'text/plain', auth);
  await k.write(req([item('A', { ...content('source', null, 'p'), body: blob })]), auth);
  const sourceRead = await read(k, auth, ['A']);
  const derived = content('summary', 'private summary', 'p', {
    provenance: {
      kind: 'derived',
      producerId: 'writer',
      inputReceiptId: sourceRead.receipt.receiptId,
    },
  });
  await k.write(req([item('S', derived)]), auth);
  await k.write(req([item('S', { ...derived, state: 'retired' }, 'S:1', 'S:2')]), auth);
  await k.write(req([item('A', content('source', 'replacement', 'p'), 'A:1', 'A:2')]), auth);
  assert.ok(k.purge('A').erasedAtomIds.includes('S'));
  assert.equal(k.storage.metaGet('blob:' + blob.blobId), undefined);
  assert.equal(k.storage.history(undefined, 100).length, 0);
});
test('read-only and Writer use one harness; staged changes are readable and commit once', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A')]), auth);
  let step = 0;
  let approved = 0;
  const model = {
    id: 'fixture',
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    respond: async (input) => {
      if (step++ === 0)
        return {
          kind: 'stage',
          revisions: [item('P', content('collection', 'new collection', 'p'))],
        };
      if (step === 2) return { kind: 'read', selector: { kind: 'refs', refs: [logical('P')] } };
      assert.ok(
        input.records.some(
          (record) =>
            record.kind === 'memory-data' && record.result.atoms.some((r) => r.atomId === 'P'),
        ),
      );
      return { kind: 'finish', output: 'saved' };
    },
  };
  const harness = new AgentHarness({
    kernel: k,
    maxOutputTokensPerStep: 2048,
    instructions: {
      writer: {
        text: 'Organize the source',
        model,
        approve: () => {
          approved++;
          return true;
        },
      },
    },
  });
  const result = await harness.run({
    instructionId: 'writer',
    inputRefs: [logical('A')],
    auth,
    readContext: ctx,
    budget,
    commitPolicy: 'host-validated-edits',
  });
  assert.equal(result.status, 'completed');
  assert.equal(approved, 1);
  assert.equal((await read(k, auth, ['P'])).atoms.length, 1);
});
test('host approval cannot commit after the Writer input changes', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A')]), auth);
  let step = 0;
  const harness = new AgentHarness({
    kernel: k,
    maxOutputTokensPerStep: 2048,
    instructions: {
      writer: {
        text: 'Organize source',
        model: {
          id: 'fixture',
          tokenizer: utf8Tokenizer,
          networkCallsPerCall: 0,
          respond: async () =>
            step++ === 0
              ? { kind: 'stage', revisions: [item('P', content('collection', 'stale', 'p'))] }
              : { kind: 'finish', output: 'done' },
        },
        approve: async () => {
          await k.write(req([item('A', content('source', 'changed', 'p'), 'A:1', 'A:2')]), auth);
          return true;
        },
      },
    },
  });
  const result = await harness.run({
    instructionId: 'writer',
    inputRefs: [logical('A')],
    auth,
    readContext: ctx,
    budget,
    commitPolicy: 'host-validated-edits',
  });
  assert.equal(result.status, 'conflict');
  assert.equal(k.storage.get(logical('P'), k.storage.watermark()), undefined);
});
test('model output budget and failed calls cannot be reused by retries', async () => {
  const { k, auth } = fixture();
  let calls = 0;
  const harness = new AgentHarness({
    kernel: k,
    maxOutputTokensPerStep: 100,
    instructions: {
      answer: {
        text: 'Answer',
        model: {
          id: 'fixture',
          tokenizer: utf8Tokenizer,
          networkCallsPerCall: 0,
          respond: async () => {
            calls++;
            return { kind: 'finish', output: 'x'.repeat(1000) };
          },
        },
      },
    },
  });
  const result = await harness.run({
    instructionId: 'answer',
    inputRefs: [],
    auth,
    readContext: ctx,
    budget: { ...budget, maxModelCalls: 1 },
    commitPolicy: 'read-only',
  });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(calls, 1);
});
test('embedding ranking uses maximum nonnegative cosine and reports missing representations', async () => {
  const embedding = {
    id: 'space:v1',
    dimensions: 2,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    embed: async (texts) =>
      texts.map((t) => (t.includes('cat') ? [1, 0] : t.includes('dog') ? [0, 1] : [-1, 0])),
  };
  const { k, auth } = fixture({ embedding });
  await k.write(
    req([
      item('A', content('source', 'dog', 'p')),
      item('B', content('source', 'cat', 'p')),
      item('C', content('source', 'new unindexed', 'p')),
    ]),
    auth,
  );
  await k.index(pin('A', 'A:1'), auth, budget);
  await k.index(pin('B', 'B:1'), auth, budget);
  const result = await read(k, auth, [], { selector: { kind: 'search', query: 'cat' } });
  assert.equal(result.atoms[0].atomId, 'B');
  assert.equal(result.diagnostics.indexState, 'lagging');
  assert.equal(result.diagnostics.traversal, 'approximate');
  assert.equal(result.usage.maxModelCalls, 1);
});
test('permission revocation during an embedding request denies the completed response', async () => {
  let revoke = () => {};
  const embedding = {
    id: 'test',
    dimensions: 1,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    embed: async () => {
      revoke();
      return [[1]];
    },
  };
  const { k, auth, authority } = fixture({ embedding });
  await k.write(req([item('A')]), auth);
  revoke = () => authority.revoke(auth);
  await assert.rejects(
    read(k, auth, [], { selector: { kind: 'search', query: 'A' } }),
    code('ACCESS_DENIED'),
  );
});
test('byte and exact serialized-token budgets include context metadata', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A')]), auth);
  const full = await read(k, auth, ['A']);
  assert.equal(full.contextPack.tokenCount, utf8Tokenizer.count(full.contextPack.serialized));
  const limited = await read(k, auth, ['A'], {
    budget: { ...budget, maxContextTokens: full.contextPack.tokenCount - 1 },
  });
  assert.equal(limited.atoms.length, 0);
  assert.equal(limited.diagnostics.stopReason, 'budget');
  const bytes = await read(k, auth, ['A'], { budget: { ...budget, maxBytes: 1 } });
  assert.equal(bytes.atoms.length, 0);
  assert.equal(bytes.usage.maxBytes, 0);
});
test('one resolved revision is emitted once across pinned and logical selectors', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A')]), auth);
  const result = await read(k, auth, [], {
    selector: { kind: 'refs', refs: [pin('A', 'A:1'), logical('A')] },
  });
  assert.equal(result.atoms.length, 1);
});
test('deadline and candidate exhaustion cannot claim traversal completion', async () => {
  const { k, auth } = fixture();
  const result = await read(k, auth, [], {
    budget: { ...budget, deadline: new Date(0).toISOString() },
  });
  assert.equal(result.diagnostics.stopReason, 'deadline');
  assert.equal(result.diagnostics.traversal, 'partial');
});
test('a continued page gets its own immutable read receipt', async () => {
  const { k, auth } = fixture();
  await k.write(req([item('A'), item('B')]), auth);
  const first = await read(k, auth, ['A', 'B'], { budget: { ...budget, maxAtoms: 1 } });
  const before = k.inspectReceipt(first.receipt.receiptId, auth);
  const next = await read(k, auth, ['A', 'B'], {
    budget: { ...budget, maxAtoms: 1 },
    continuation: first.continuation,
  });
  assert.notEqual(next.receipt.receiptId, first.receipt.receiptId);
  assert.deepEqual(k.inspectReceipt(first.receipt.receiptId, auth), before);
});
test('a changed embedding index expires an existing search continuation', async () => {
  const embedding = {
    id: 'test',
    dimensions: 1,
    tokenizer: utf8Tokenizer,
    networkCallsPerCall: 0,
    embed: async (texts) => texts.map(() => [1]),
  };
  const { k, auth } = fixture({ embedding });
  await k.write(req([item('A'), item('B')]), auth);
  const options = { selector: { kind: 'search', query: 'A' }, budget: { ...budget, maxAtoms: 1 } };
  const first = await read(k, auth, [], options);
  await k.index(pin('B', 'B:1'), auth, budget);
  await assert.rejects(
    read(k, auth, [], { ...options, continuation: first.continuation }),
    code('CURSOR_EXPIRED'),
  );
});
