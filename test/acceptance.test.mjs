import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AtomKernel,
  LocalAuthority,
  MemoryStorage,
  defaultBudget,
  content,
  membership,
  logical,
  pin,
  origin,
  sourceCoverage,
  BudgetLedger,
  AgentHarness,
  utf8Tokenizer,
} from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

const ctx = { requestedPolicyIds: ['p'], consistency: { mode: 'snapshot' } };
const budget = {
  ...defaultBudget,
  maxAtoms: 128,
  maxCandidates: 1000,
  maxBytes: 1000000,
  maxContextTokens: 100000,
};
const c = (schema, value, extra = {}) => content(schema, value, 'p', extra);
const item = (id, value = c('source', id), expectedHead = null, rev = id + ':1') => ({
  atomId: id,
  revisionId: rev,
  expectedHead,
  content: value,
});
const request = (revisions, idempotencyKey = crypto.randomUUID(), extra = {}) => ({
  revisions,
  idempotencyKey,
  guards: [],
  ...extra,
});
const read = (kernel, auth, selector, options = {}) =>
  kernel.read({ selector, context: ctx, budget, render: 'mixed', ...options }, auth);
const refs = (...ids) => ({ kind: 'refs', refs: ids.map(logical) });
const relations = (id) => ({
  kind: 'relations',
  target: logical(id),
  role: 'group',
  schema: 'membership',
});
const code = (code) => (error) => error.code === code;
for (const adapter of ['memory', 'sqlite']) {
  const fixture = (t) => {
    const dir = adapter === 'sqlite' ? mkdtempSync(join(tmpdir(), 'atom-memory-')) : undefined;
    const storage = dir ? new SqliteStorage(join(dir, 'data.sqlite')) : new MemoryStorage();
    t.after(() => {
      storage.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    const authority = new LocalAuthority();
    const auth = authority.issue({
      subject: 'owner',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const kernel = new AtomKernel({ storage, authority });
    return { kernel, auth, storage, authority };
  };
  test(`${adapter}: F01-F03 independent multi-membership and retirement`, async (t) => {
    const { kernel: k, auth: a, storage } = fixture(t);
    await k.write(
      request([
        item('B'),
        item('P', c('collection', 'P')),
        item('Q', c('collection', 'Q')),
        item('PB', membership('P', 'B', 'p')),
        item('QB', membership('Q', 'B', 'p')),
      ]),
      a,
    );
    const before = storage.get(logical('P'), storage.watermark());
    await k.write(request([item('D'), item('PD', membership('P', 'D', 'p'))]), a);
    assert.deepEqual(storage.get(logical('P'), storage.watermark()), before);
    await k.write(
      request([item('PB', { ...membership('P', 'B', 'p'), state: 'retired' }, 'PB:1', 'PB:2')]),
      a,
    );
    assert.equal(
      (await read(k, a, relations('P'))).atoms.filter(
        (r) => r.schema === 'membership' && r.atomId === 'PB',
      ).length,
      0,
    );
    assert.equal(
      (await read(k, a, relations('Q'))).atoms.find((r) => r.atomId === 'QB').state,
      'active',
    );
    assert.equal((await read(k, a, refs('B'))).atoms[0].revisionId, 'B:1');
  });
  test(`${adapter}: F04 immutable include and stale derived content`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(
      request([
        item('B', c('source', 'old')),
        item(
          'P',
          c('collection', 'fixed', {
            slots: [{ role: 'part', mode: 'include', target: pin('B', 'B:1') }],
          }),
        ),
      ]),
      a,
    );
    const sourceRead = await read(k, a, refs('B'));
    await k.write(
      request([
        item(
          'S',
          c('summary', 'old summary', {
            provenance: {
              kind: 'derived',
              producerId: 'model',
              inputReceiptId: sourceRead.receipt.receiptId,
            },
            origins: [origin(pin('B', 'B:1'), 'old')],
          }),
        ),
      ]),
      a,
    );
    assert.equal((await read(k, a, refs('S'))).atoms.length, 1);
    await k.write(request([item('B', c('source', 'new'), 'B:1', 'B:2')]), a);
    const current = await read(k, a, refs('S'));
    assert.equal(current.atoms.length, 0);
    assert.equal(current.diagnostics.derivedState, 'pending');
    assert.equal(
      (await read(k, a, refs('P'))).atoms.find((r) => r.atomId === 'B').revisionId,
      'B:1',
    );
  });
  test(`${adapter}: F05 CAS rejects the losing concurrent revision`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(request([item('B')]), a);
    const result = await Promise.allSettled([
      k.write(request([item('B', c('source', 'a'), 'B:1', 'B:2')]), a),
      k.write(request([item('B', c('source', 'b'), 'B:1', 'B:3')]), a),
    ]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(result.find((r) => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  });
  test(`${adapter}: F06-F07 dynamic cycles terminate; fixed include cycles roll back`, async (t) => {
    const { kernel: k, auth: a, storage } = fixture(t);
    await k.write(
      request([
        item('P', c('collection', 'P')),
        item('Q', c('collection', 'Q')),
        item('PQ', membership('P', 'Q', 'p')),
        item('QP', membership('Q', 'P', 'p')),
      ]),
      a,
    );
    const out = await read(k, a, relations('P'));
    assert.ok(out.atoms.length <= 4);
    assert.equal(new Set(out.atoms.map((r) => r.revisionId)).size, out.atoms.length);
    const previous = storage.watermark();
    await assert.rejects(
      k.write(
        request([
          item(
            'X',
            c('collection', 'X', {
              slots: [{ role: 'part', mode: 'include', target: pin('Y', 'Y:1') }],
            }),
          ),
          item(
            'Y',
            c('collection', 'Y', {
              slots: [{ role: 'part', mode: 'include', target: pin('X', 'X:1') }],
            }),
          ),
        ]),
        a,
      ),
      code('INCLUDE_CYCLE'),
    );
    assert.equal(storage.watermark(), previous);
    assert.equal(storage.get(logical('X'), previous + 1), undefined);
  });
  test(`${adapter}: F08 a new membership invalidates a range-dependent summary`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(
      request([item('P', c('collection', 'P')), item('B'), item('PB', membership('P', 'B', 'p'))]),
      a,
    );
    const input = await read(k, a, relations('P'));
    await k.write(
      request([
        item(
          'S',
          c('summary', 'P has B', {
            provenance: {
              kind: 'derived',
              producerId: 'model',
              inputReceiptId: input.receipt.receiptId,
            },
          }),
        ),
      ]),
      a,
    );
    assert.equal((await read(k, a, refs('S'))).atoms.length, 1);
    await k.write(request([item('D'), item('PD', membership('P', 'D', 'p'))]), a);
    assert.equal((await read(k, a, refs('S'))).diagnostics.derivedState, 'pending');
  });
  test(`${adapter}: F09 overlap is a source union; repeated paths do not duplicate units`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    const coverage = sourceCoverage([
      origin(pin('B', 'B:1'), 'abcdef', 0, 4),
      origin(pin('B', 'B:1'), 'abcdef', 2, 6),
      origin(pin('B', 'B:2'), 'abcdef', 0, 3),
    ]);
    assert.equal(coverage[0].bytes, 6);
    assert.equal(coverage[1].bytes, 3);
    await k.write(
      request([
        item('B'),
        item(
          'P',
          c('collection', 'P', {
            slots: [
              { role: 'part', mode: 'include', target: pin('B', 'B:1') },
              { role: 'again', mode: 'include', target: pin('B', 'B:1') },
            ],
          }),
        ),
      ]),
      a,
    );
    const result = await read(k, a, refs('P', 'B', 'B'));
    assert.equal(result.contextPack.units.filter((u) => u.owner.atomId === 'B').length, 1);
  });
  test(`${adapter}: F10 directions and negation remain in rendered context`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(
      request([
        item('A'),
        item('B'),
        item(
          'R',
          c(
            'statement',
            { negated: true, condition: 'only in winter' },
            {
              slots: [
                { role: 'from', mode: 'refer', target: logical('A') },
                { role: 'to', mode: 'refer', target: logical('B') },
              ],
            },
          ),
        ),
      ]),
      a,
    );
    const result = await read(k, a, refs('R'));
    assert.match(result.contextPack.serialized, /winter/);
    assert.match(result.contextPack.serialized, /negated/);
    assert.deepEqual(result.contextPack.units[0].companionIds, ['A', 'B']);
  });
  test(`${adapter}: F11-F12 finite budgets and empty partial results are explicit`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(request([item('A'), item('B')]), a);
    const page = await read(k, a, refs('A', 'B'), { budget: { ...budget, maxAtoms: 1 } });
    assert.equal(page.atoms.length, 1);
    assert.ok(page.continuation);
    assert.equal(page.diagnostics.traversal, 'partial');
    const empty = await read(
      k,
      a,
      { kind: 'search', query: 'missing' },
      { budget: { ...budget, maxCandidates: 0 } },
    );
    assert.equal(empty.atoms.length, 0);
    assert.equal(empty.diagnostics.traversal, 'partial');
    assert.equal(empty.diagnostics.semanticCoverageCertified, false);
    const ledger = new BudgetLedger(budget);
    ledger.reserve({ ...budget, maxAtoms: 100 });
    assert.throws(() => ledger.reserve({ ...budget, maxAtoms: 100 }), code('BUDGET_EXHAUSTED'));
  });
  test(`${adapter}: F13 continuation and snapshot preserve versions`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(request([item('A'), item('B', c('source', 'old'))]), a);
    const req = {
      selector: refs('A', 'B'),
      context: ctx,
      budget: { ...budget, maxAtoms: 1 },
      render: 'raw',
    };
    const page = await k.read(req, a);
    await k.write(request([item('B', c('source', 'new'), 'B:1', 'B:2')]), a);
    const next = await k.read({ ...req, continuation: page.continuation }, a);
    assert.equal(next.atoms[0].revisionId, 'B:1');
    const historic = await read(k, a, refs('B'), {
      context: {
        ...ctx,
        consistency: { mode: 'snapshot', snapshotToken: page.receipt.snapshotToken },
      },
    });
    assert.equal(historic.atoms[0].revisionId, 'B:1');
  });
  test(`${adapter}: F14-F15 unsupported guarantees fail before mutation`, async (t) => {
    const { kernel: k, auth: a, storage } = fixture(t);
    storage.capabilities.snapshot = false;
    await assert.rejects(read(k, a, refs('A')), code('CONSISTENCY_UNAVAILABLE'));
    storage.capabilities.atomicBatch = false;
    await assert.rejects(k.write(request([item('A')]), a), code('ATOMICITY_UNAVAILABLE'));
    assert.equal(storage.watermark(), 0);
  });
  test(`${adapter}: F16 Writer failure discards private overlays`, async (t) => {
    const { kernel: k, auth: a } = fixture(t);
    await k.write(request([item('A')]), a);
    let step = 0;
    const harness = new AgentHarness({
      kernel: k,
      maxOutputTokensPerStep: 2000,
      instructions: {
        writer: {
          text: 'Organize source data',
          approve: () => true,
          model: {
            id: 'fixture',
            tokenizer: utf8Tokenizer,
            networkCallsPerCall: 0,
            respond: async () => {
              if (step++ === 0)
                return { kind: 'stage', revisions: [item('P', c('collection', 'tentative'))] };
              throw new Error('model failed');
            },
          },
        },
      },
    });
    const result = await harness.run({
      instructionId: 'writer',
      inputRefs: [logical('A')],
      auth: a,
      readContext: ctx,
      budget: { ...budget, maxModelInputTokens: 100000, maxModelOutputTokens: 10000 },
      commitPolicy: 'host-validated-edits',
    });
    assert.equal(result.status, 'failed');
    await assert.rejects(read(k, a, refs('P')), code('REFERENCE_UNAVAILABLE'));
  });
  test(`${adapter}: F17 current authorization governs old versions, cursors and summaries`, async (t) => {
    const { kernel: k, auth: a, authority } = fixture(t);
    await k.write(request([item('A'), item('B')]), a);
    const page = await read(k, a, refs('A', 'B'), { budget: { ...budget, maxAtoms: 1 } });
    const unauthorized = authority.issue({ subject: 'guest', readPolicies: [], writePolicies: [] });
    await assert.rejects(read(k, unauthorized, refs('A')), code('ACCESS_DENIED'));
    authority.revoke(a);
    await assert.rejects(
      read(k, a, refs('A', 'B'), {
        budget: { ...budget, maxAtoms: 1 },
        continuation: page.continuation,
      }),
      code('ACCESS_DENIED'),
    );
    await assert.rejects(
      read(k, a, { kind: 'refs', refs: [pin('A', 'A:1')] }),
      code('ACCESS_DENIED'),
    );
  });
  test(`${adapter}: F18 model-authored source classification is denied`, async (t) => {
    const { kernel: k, auth: a, authority } = fixture(t);
    const writer = authority.issue({
      subject: 'writer',
      readPolicies: ['p'],
      writePolicies: ['p'],
    });
    await assert.rejects(k.write(request([item('A')]), writer), code('ACCESS_DENIED'));
    await k.write(request([item('A')]), a);
    const receipt = await read(k, a, refs('A'));
    await assert.rejects(
      k.write(
        request([item('S')], undefined, { actorInputReceiptId: receipt.receipt.receiptId }),
        a,
      ),
      code('ACCESS_DENIED'),
    );
  });
  test(`${adapter}: F19 idempotent retries bind identity and exact request content`, async (t) => {
    const { kernel: k, auth: a, storage } = fixture(t);
    const req = request([item('A')], 'same');
    const first = await k.write(req, a);
    const repeat = await k.write(req, a);
    assert.equal(first.operationId, repeat.operationId);
    assert.equal(repeat.repeatedInput, true);
    assert.equal(storage.watermark(), 1);
    await assert.rejects(k.write(request([item('B')], 'same'), a), code('IDEMPOTENCY_CONFLICT'));
  });
  test(`${adapter}: F20 purge denies historic source and uncited derivations`, async (t) => {
    const { kernel: k, auth: a, storage } = fixture(t);
    await k.write(request([item('A', c('source', 'secret'))]), a);
    const input = await read(k, a, refs('A'));
    await k.write(
      request([
        item(
          'S',
          c('summary', 'secret derived without citation', {
            provenance: {
              kind: 'derived',
              producerId: 'writer',
              inputReceiptId: input.receipt.receiptId,
            },
          }),
        ),
      ]),
      a,
    );
    const result = k.purge('A');
    assert.deepEqual(new Set(result.erasedAtomIds), new Set(['A', 'S']));
    await assert.rejects(
      read(k, a, { kind: 'refs', refs: [pin('A', 'A:1')] }),
      code('ACCESS_DENIED'),
    );
    await assert.rejects(read(k, a, refs('S')), code('ACCESS_DENIED'));
    assert.equal(storage.get(pin('A', 'A:1'), 100), undefined);
    assert.equal(storage.metaGet('receipt:' + input.receipt.receiptId), undefined);
  });
}
