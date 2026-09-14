import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, create, revise, retire } from './fixtures.mjs';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { createHash } from 'node:crypto';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const budget = { maxCandidates: 8000, maxBytes: 8000000, maxAtoms: 100, maxPackingWork: 8000000 };
for (const adapter of ['memory', 'sqlite']) {
  const setup = (t, options = {}) => {
    const f = fixture({
      ...(adapter === 'sqlite' ? { storage: new SqliteStorage(':memory:') } : {}),
      ...options,
    });
    t.after(() => f.storage.close());
    f.agentBinding = { ...f.binding, actor: { type: 'agent' } };
    return f;
  };
  const observed = async (f, ref, extra = {}) => {
    const inspection = await f.writer.inspect(ref, { budget });
    return f.host.observe(
      {
        presentations: [{ receipt: inspection.receipt }],
        payloadDigest: digest(inspection.atom.text),
        ...extra,
      },
      f.agentBinding,
    );
  };
  test(`${adapter} V08-22 acquisition and presentation are distinct`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    for (let i = 0; i < 12; i++) await create(f.memory, `needle ${i}`);
    const page = await f.memory.read({ query: 'needle' }, { limit: 1, tokens: 10000, budget });
    const m = f.host.manifest(page.receipt, f.binding);
    assert.equal(m.contractVersion, 2);
    assert.equal(m.acquisition.reads.length, 12);
    assert.equal(m.presentation.units.length, 1);
    assert.equal(m.generation, undefined);
  });
  test(`${adapter} V09-24 independent generations share a commit only`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'alpha input');
    const B = await create(f.memory, 'beta input');
    const aInput = await observed(f, A.ref);
    const bInput = await observed(f, B.ref);
    const result = await f.writer.write(
      {
        changes: [
          {
            id: 'alpha-output',
            op: 'create',
            content: { text: 'alpha output', links: [] },
            sources: [],
            input: aInput,
          },
          {
            id: 'beta-output',
            op: 'create',
            content: { text: 'beta output', links: [] },
            sources: [],
            input: bInput,
          },
        ],
      },
      { budget },
    );
    await revise(f.memory, A.ref, 'alpha changed', {}, { budget });
    const page = await f.writer.search('output', { budget, depth: 0 });
    assert.ok(!page.items.some((v) => v.ref === result.changes['alpha-output'].ref));
    assert.ok(page.items.some((v) => v.ref === result.changes['beta-output'].ref));
  });
  test(`${adapter} V08-28 forged token is refused`, async (t) => {
    const f = setup(t);
    await assert.rejects(create(f.writer, 'fabrication', { input: 'input:fake' }));
    for (const invalid of ['', null, false, 0, {}])
      await assert.rejects(create(f.writer, 'invalid token', { input: invalid }), {
        code: 'INVALID_INPUT',
      });
    const A = await create(f.memory, 'source');
    const token = await observed(f, A.ref);
    await assert.rejects(create(f.writer, 'object token', { input: { id: token } }), {
      code: 'INVALID_INPUT',
    });
    assert.throws(
      () =>
        f.host.observe(
          { inherit: [{ id: token }], payloadDigest: digest('state') },
          f.agentBinding,
        ),
      { code: 'INVALID_INPUT' },
    );
    const other = {
      ...f.agentBinding,
      auth: f.authority.issue({ subject: 'other', readPolicies: ['p'], writePolicies: ['p'] }),
    };
    assert.throws(() => f.host.manifest(token, other), { code: 'ACCESS_DENIED' });
    assert.throws(() => f.host.manifest(token, { ...f.agentBinding, writePolicy: 'other' }), {
      code: 'ACCESS_DENIED',
    });
    const real = Date.now;
    const now = real();
    Date.now = () => now + 1000000;
    try {
      await assert.rejects(create(f.writer, 'expired', { input: token }), {
        code: 'CURSOR_EXPIRED',
      });
    } finally {
      Date.now = real;
    }
    await assert.rejects(
      create(f.writer, { text: 'fake source', provenance: { kind: 'source' } }, { input: token }),
      { code: 'INVALID_INPUT' },
    );
    f.host.purge(f.storage.metaGet(`sdk:ref:${A.ref}`).target.atomId);
    await assert.rejects(create(f.writer, 'purged input', { input: token }));
  });
  test(`${adapter} V08-31 independent source survives ordinary relation purge`, async (t) => {
    const f = setup(t);
    const B = await create(f.memory, 'target');
    const P = await create(f.memory, { text: 'independent payload', links: { related: B.ref } });
    const id = f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId;
    const result = f.host.purge(id);
    assert.equal(result.complete, true);
    const page = await f.memory.read({ query: 'independent' }, { budget });
    assert.equal(page.items[0].ref, P.ref);
    assert.equal(page.items[0].links[0].unavailable, true);
    assert.equal('ref' in page.items[0].links[0], false);
    const retired = await retire(f.memory, P.ref, {}, { budget });
    const retiredView = await f.memory.inspect(retired.value.ref, { budget });
    assert.equal(retiredView.atom.state, 'retired');
    assert.equal(retiredView.atom.links[0].unavailable, true);
    assert.equal((await f.memory.search('independent', { budget })).items.length, 0);
  });
  test(`${adapter} V08-33 unavailable required blocks read but permits inspect`, async (t) => {
    const f = setup(t);
    const B = await create(f.memory, 'condition');
    const P = await create(f.memory, {
      text: 'conditioned payload',
      links: { when: { ref: B.ref, required: true } },
    });
    f.host.purge(f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId);
    const inspection = await f.memory.inspect(P.ref, { budget });
    assert.equal(inspection.atom.text, 'conditioned payload');
    assert.equal(inspection.readEligibility, 'blocked');
    const page = await f.memory.read({ query: 'conditioned' }, { budget });
    assert.equal(page.items.length, 0);
    assert.ok(page.diagnostics.validation.blocked > 0);
  });
  test(`${adapter} V09-01 five operations use declarative content`, async (t) => {
    const f = setup(t);
    const first = await create(f.memory, 'content needle');
    assert.equal((await f.memory.inspect(first.ref, { budget })).atom.text, first.text);
    assert.ok((await f.memory.search('needle', { budget })).items.length);
    assert.ok((await f.memory.read({ query: 'needle' }, { budget })).text.includes(first.text));
    const edited = await revise(f.memory, first.ref, 'new needle', {}, { budget });
    assert.equal(edited.changes.length, 1);
    assert.notEqual(edited.changes[0].ref, first.ref);
  });
  test(`${adapter} V08-02 shared n-ary roles and cycles use ordinary Atoms`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'alpha');
    const B = await create(f.memory, 'beta');
    const R = await create(f.memory, {
      text: 'relation',
      links: { member: [A.ref, B.ref], second: A.ref },
    });
    const P = await create(f.memory, { text: 'parent', links: { member: A.ref } });
    await revise(f.memory, A.ref, { text: 'alpha', links: { back: R.ref } }, {}, { budget });
    const page = await f.memory.search('relation', { depth: 5, budget });
    assert.ok(page.items.some((v) => v.ref === P.ref));
    assert.equal((await f.memory.inspect(R.ref, { budget })).atom.links.length, 3);
  });
  test(`${adapter} V08-03 reading leaves semantic revisions and use state intact`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle');
    const before = f.storage.history(undefined, 100);
    for (const run of [
      () => f.memory.search('needle', { budget }),
      () => f.memory.read({ query: 'needle' }, { budget }),
      () => f.memory.inspect(a.ref, { budget }),
    ])
      await run();
    assert.deepEqual(f.storage.history(undefined, 100), before);
    assert.deepEqual(f.storage.metaEntries('sdk:use:state:'), []);
  });
  test(`${adapter} V08-04 observed inspection and logical links retain separate versions`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'old');
    const p = await create(f.memory, {
      text: 'parent',
      links: { logical: a.ref, observed: { ref: a.ref, at: 'observed' } },
    });
    const next = await revise(f.memory, a.ref, 'new', {}, { budget });
    assert.equal((await f.memory.inspect(a.ref, { budget })).atom.text, 'old');
    const view = (await f.memory.inspect(p.ref, { budget })).atom;
    assert.equal(view.links[0].ref, next.value.ref);
    assert.equal(view.links[1].ref, a.ref);
  });
  test(`${adapter} V09-05 declarative batches roll back and exact observed CAS wins once`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'old');
    await assert.rejects(
      f.memory.write(
        {
          changes: [
            {
              id: 'must-rollback',
              op: 'create',
              content: { text: 'must rollback', links: [] },
              sources: [],
            },
            {
              id: 'bad-local',
              op: 'create',
              content: { text: 'bad local', links: { related: { local: 'missing' } } },
              sources: [],
            },
          ],
        },
        { budget },
      ),
      { code: 'INVALID_REF' },
    );
    assert.equal((await f.memory.search('rollback', { budget })).items.length, 0);
    await revise(f.memory, a.ref, 'winner', {}, { budget });
    await assert.rejects(revise(f.memory, a.ref, 'loser', {}, { budget }), {
      code: 'REVISION_CONFLICT',
    });
    await assert.rejects(
      f.memory.write(
        {
          changes: [
            {
              id: 'same-logical-twice-a',
              op: 'revise',
              target: a.ref,
              content: { text: 'a', links: [] },
              sources: [],
            },
            {
              id: 'same-logical-twice-b',
              op: 'retire',
              target: a.ref,
            },
          ],
        },
        { budget },
      ),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(
      (await f.memory.inspect(a.ref, { version: 'latest', budget })).atom.text,
      'winner',
    );
  });
  test(`${adapter} V08-06 bounded use correction preserves the v0.7 activation formula`, async (t) => {
    const f = setup(t, {
      activation: {
        propagation: 0,
        maxBoost: 2,
        model: { id: 'bounded', update: (p) => ({ u: (p?.u ?? 0) + 1 }), value: (s) => s?.u ?? 0 },
      },
    });
    const a = await create(f.memory, 'needle a');
    await create(f.memory, 'needle b');
    const zero = await f.memory.search('needle', { budget });
    assert.ok(zero.items.every((i) => i.score === 0.5));
    for (let i = 0; i < 10; i++) f.host.recordUse([a.ref], f.binding, { eventId: `u:${i}` });
    const after = await f.memory.search('needle', { budget });
    const ratio = after.items[0].score / after.items[1].score;
    assert.ok(Math.abs(ratio - (1 + (2 * 10) / 11)) < 1e-10);
    assert.ok(ratio < 3);
  });
  test(`${adapter} V08-07 use cannot create relevance without matching body or edge`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const no = await create(f.memory, 'unrelated');
    await create(f.memory, 'needle');
    for (let i = 0; i < 10; i++)
      f.host.recordUse([no.ref], f.binding, { eventId: `unrelated:${i}` });
    assert.ok(!(await f.memory.search('needle', { budget })).items.some((i) => i.ref === no.ref));
  });
  test(`${adapter} V08-08 wall clock and iteration count do not mutate use`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle');
    f.host.recordUse([a.ref], f.binding, { eventId: 'clock' });
    const before = f.storage.metaEntries('sdk:use:state:');
    const real = Date.now;
    const now = real();
    Date.now = () => now;
    try {
      const cold = await f.memory.search('needle', { budget });
      const warm = await f.memory.search('needle', { budget });
      assert.equal(cold.diagnostics.evaluatedAt, warm.diagnostics.evaluatedAt);
    } finally {
      Date.now = real;
    }
    assert.deepEqual(f.storage.metaEntries('sdk:use:state:'), before);
  });
  test(`${adapter} V08-09 cold and warm solve the same acquired graph`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle');
    await create(f.memory, { text: 'parent', links: { member: a.ref } });
    const x = await f.memory.search('needle', { depth: 2, budget });
    const y = await f.memory.search('needle', { depth: 2, budget });
    const weights = new Map(x.items.map((i) => [i.ref, i.score]));
    for (const i of y.items)
      assert.ok(
        Math.abs(i.score - weights.get(i.ref)) <=
          x.diagnostics.numericErrorL1Upper + y.diagnostics.numericErrorL1Upper + 1e-10,
      );
  });
  test(`${adapter} V08-10 invalid model values and states fail explicitly`, async (t) => {
    for (const value of [
      () => -1,
      () => NaN,
      () => Infinity,
      async () => 1,
      () => {
        throw Error('bad');
      },
    ]) {
      const f = setup(t, { activation: { model: { id: 'bad', update: () => ({}), value } } });
      await create(f.memory, 'needle');
      await assert.rejects(f.memory.search('needle', { budget }), { code: 'INVALID_INPUT' });
    }
    for (const update of [
      async () => ({}),
      () => ({ text: 'x'.repeat(2000) }),
      () => {
        throw Error('bad');
      },
    ]) {
      const f = setup(t, { activation: { model: { id: 'state', update, value: () => 0 } } });
      const a = await create(f.memory, 'needle');
      assert.throws(() => f.host.recordUse([a.ref], f.binding, { eventId: 'bad-state' }), {
        code: 'INVALID_INPUT',
      });
      assert.equal(f.storage.metaEntries('sdk:use:state:').length, 0);
    }
  });
  test(`${adapter} V08-11 acquisition and numerical truncation are separate diagnostics`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle');
    await create(f.memory, { text: 'relation', links: { member: a.ref } });
    const page = await f.memory.search('needle', {
      depth: 1,
      budget: { ...budget, maxEvaluationWork: 120 },
    });
    assert.equal(page.diagnostics.evaluation.converged, false);
    assert.equal(page.diagnostics.evaluation.scope, 'acquired-graph');
    assert.equal(page.diagnostics.coverageCertified, false);
    assert.equal(typeof page.diagnostics.acquisition.partial, 'boolean');
  });
  test(`${adapter} V08-12 long top-ranked body competes with short closure sets`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const long = await create(f.memory, 'needle '.repeat(300));
    f.host.recordUse([long.ref], f.binding, { eventId: 'fixed-comparison-event' });
    const condition = await create(f.memory, 'unmatched condition');
    await create(f.memory, {
      text: 'needle a',
      links: { when: { ref: condition.ref, required: true } },
    });
    await create(f.memory, 'needle b');
    const full = await f.memory.read({ query: 'needle' }, { tokens: 10000, budget, depth: 0 });
    let improved = false;
    for (const tokens of [800, 1400, 2200, 2500, 3000]) {
      const page = await f.memory.read({ query: 'needle' }, { tokens, budget, depth: 0 });
      assert.ok(page.tokenCount <= tokens);
      assert.equal(page.diagnostics.selection.baselineComplete, true);
      assert.ok(page.diagnostics.selection.utility >= page.diagnostics.selection.baselineUtility);
      improved ||=
        page.diagnostics.selection.utility > page.diagnostics.selection.baselineUtility + 1e-6;
    }
    assert.ok(full.items.some((i) => i.ref === long.ref));
    assert.ok(
      improved,
      'real rendering improves the same fixed-state baseline in at least one budget',
    );
  });
  test(`${adapter} V08-13 explanation itself can be the answer`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const p = await create(f.memory, 'needle explanation contains answer');
    await create(f.memory, 'other detail');
    const page = await f.memory.read({ query: 'needle' }, { budget });
    assert.equal(page.items[0].ref, p.ref);
  });
  test(`${adapter} V08-14 shared required body is rendered once`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const c = await create(f.memory, 'unique condition');
    const a = await create(f.memory, {
      text: 'needle a',
      links: { when: { ref: c.ref, required: true } },
    });
    const b = await create(f.memory, {
      text: 'needle b',
      links: { when: { ref: c.ref, required: true } },
    });
    const page = await f.memory.read({ query: 'needle' }, { tokens: 10000, budget, depth: 0 });
    assert.ok(page.refs.includes(a.ref) && page.refs.includes(b.ref));
    assert.equal(page.refs.filter((r) => r === c.ref).length, 1);
    assert.equal(page.text.split('unique condition').length - 1, 1);
  });
  test(`${adapter} V08-15 deep required cycles close finitely`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    let a = await create(f.memory, 'last condition');
    const first = a;
    for (let i = 0; i < 8; i++)
      a = await create(f.memory, {
        text: i === 7 ? 'needle root' : `condition ${i}`,
        links: { when: { ref: a.ref, required: true } },
      });
    await revise(
      f.memory,
      first.ref,
      {
        text: 'last condition',
        links: { when: { ref: a.ref, required: true } },
      },
      {},
      { budget },
    );
    const page = await f.memory.read({ query: 'needle' }, { tokens: 20000, depth: 0, budget });
    assert.equal(page.items.length, 9);
  });
  test(`${adapter} V08-16 oversized closure is deferred without ref-only substitution`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const c = await create(f.memory, 'condition '.repeat(1000));
    const root = await create(f.memory, {
      text: 'needle',
      links: { when: { ref: c.ref, required: true } },
    });
    const small = await create(f.memory, 'needle small');
    const page = await f.memory.read({ query: 'needle' }, { tokens: 1200, depth: 0, budget });
    assert.ok(!page.refs.includes(root.ref));
    assert.ok(page.refs.includes(small.ref));
    assert.ok(page.diagnostics.minimumTokens > 1200);
  });
  test(`${adapter} V08-17 overlapping verified quotations share evidence`, async (t) => {
    const f = setup(t);
    const source = await create(f.memory, 'AAAABBBBCCCC');
    const writer = f.host.connect({
      ...f.binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await create(writer, 'AAAABBBB', {
      sources: [{ ref: source.ref, start: 0, end: 8 }],
    });
    const b = await create(writer, 'BBBBCCCC', {
      sources: [{ ref: source.ref, start: 4, end: 12 }],
    });
    const page = await f.memory.read({ query: 'BBBB' }, { tokens: 10000, budget });
    assert.ok(page.refs.includes(a.ref) && page.refs.includes(b.ref));
    assert.equal(page.text.split('BBBB').length - 1, 1);
    assert.equal((await f.memory.inspect(a.ref, { budget })).atom.text, 'AAAABBBB');
  });
  test(`${adapter} V08-18 different generated meanings and different sources stay separate`, async (t) => {
    const f = setup(t);
    const source = await create(f.memory, 'needle original');
    const a = await create(f.writer, 'needle only with consent', {
      sources: [{ ref: source.ref }],
    });
    const b = await create(f.writer, 'needle never without review', {
      sources: [{ ref: source.ref }],
    });
    const other = await create(f.memory, source.text);
    const page = await f.memory.read({ query: 'needle' }, { tokens: 10000, budget });
    for (const v of [a, b, source, other]) assert.ok(page.refs.includes(v.ref));
  });
  test(`${adapter} V08-19 identical quote classes count max activation while retaining selected refs`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const source = await create(f.memory, 'quoted');
    const writer = f.host.connect({
      ...f.binding,
      actor: { type: 'agent', generatedOrigin: 'extraction' },
    });
    const a = await create(writer, 'quoted', { sources: [{ ref: source.ref }] });
    const b = await create(writer, 'quoted', { sources: [{ ref: source.ref }] });
    const root = await create(f.memory, {
      text: 'needle',
      links: {
        when: [
          { ref: a.ref, required: true },
          { ref: b.ref, required: true },
        ],
      },
    });
    const page = await f.memory.read({ query: 'needle' }, { tokens: 10000, budget, depth: 0 });
    assert.ok(
      page.refs.includes(a.ref) && page.refs.includes(b.ref) && page.refs.includes(root.ref),
    );
    assert.equal(page.text.split('quoted').length - 1, 1);
    const q = await f.memory.read({ query: 'quoted' }, { tokens: 10000, budget, depth: 0 });
    assert.ok(q.diagnostics.selection.utility > 0);
    assert.ok(q.items.length < 3, 'equal utility chooses less metadata');
  });
  test(`${adapter} V08-20 exact UTF-8 display and explicit packing work limits`, async (t) => {
    const f = setup(t);
    await create(f.memory, '日本語 needle');
    const full = await f.memory.read({ query: 'needle' }, { tokens: 10000, budget });
    assert.equal(full.tokenCount, Buffer.byteLength(full.text));
    const small = await f.memory.read({ query: 'needle' }, { tokens: full.tokenCount - 1, budget });
    assert.ok(small.tokenCount <= full.tokenCount - 1);
    const stopped = await f.memory.read(
      { query: 'needle' },
      { budget: { ...budget, maxPackingWork: 0 } },
    );
    assert.equal(stopped.diagnostics.selection.baselineComplete, false);
    assert.equal(stopped.diagnostics.selection.complete, false);
    assert.equal(stopped.usage.maxPackingWork, 0);
  });
  test(`${adapter} V08-21 small corpus oracle compares every feasible public rendering`, async (t) => {
    // A tokenizer whose cost is the sum of visible body characters makes the tiny exact oracle transparent.
    const tokenizer = {
      id: 'public-body-length',
      count(text) {
        if (!text) return 0;
        const p = JSON.parse(text);
        return (
          p.memory.reduce((n, i) => n + (i.text?.length ?? 0), 0) +
          p.evidence.reduce((n, e) => n + e.ranges.reduce((k, r) => k + r.text.length, 0), 0)
        );
      },
    };
    const f = setup(t, { tokenizer, activation: { propagation: 0 } });
    const views = [];
    for (const text of ['needle long long', 'needle a', 'needle b', 'needle c'])
      views.push(await create(f.memory, text));
    const ranking = await f.memory.search('needle', { budget, depth: 0 });
    const score = new Map(ranking.items.map((v) => [v.ref, v.score]));
    let oracle = 0;
    const tokens = 25;
    for (let mask = 0; mask < 1 << views.length; mask++) {
      const selected = views.filter((_, i) => mask & (1 << i));
      const cost = selected.reduce((n, v) => n + v.text.length, 0);
      if (cost <= tokens)
        oracle = Math.max(
          oracle,
          selected.reduce((n, v) => n + score.get(v.ref), 0),
        );
    }
    const page = await f.memory.read({ query: 'needle' }, { tokens, budget, depth: 0 });
    const actual = page.items.reduce((n, v) => n + score.get(v.ref), 0);
    assert.ok(actual <= oracle + 1e-12);
    assert.ok(page.diagnostics.selection.utility >= page.diagnostics.selection.baselineUtility);
    t.diagnostic(
      JSON.stringify({
        oracle,
        selected: actual,
        gap: oracle - actual,
        tokens: page.tokenCount,
        work: page.usage.maxPackingWork,
        realLLM: false,
      }),
    );
  });
  test(`${adapter} V08-23 host filtering narrows delivery while preserving acquisition`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle a');
    const b = await create(f.memory, 'needle b');
    const page = await f.writer.read({ query: 'needle' }, { tokens: 10000, budget });
    const token = f.host.observe(
      { presentations: [{ receipt: page.receipt, refs: [a.ref] }], payloadDigest: digest(a.text) },
      f.agentBinding,
    );
    const m = f.host.manifest(token, f.agentBinding);
    assert.deepEqual(
      m.generation.presentations[0].units.map((u) => u.ref),
      [a.ref],
    );
    assert.equal(m.acquisition.reads.length, 2);
    assert.throws(
      () => f.host.recordUse([b.ref], f.agentBinding, { eventId: 'filtered', input: token }),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(
      f.host.recordUse([a.ref], f.agentBinding, { eventId: 'sent', input: token }).recorded,
      1,
    );
  });
  test(`${adapter} V09-25 citations cannot split one generation input`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'A');
    const B = await create(f.memory, 'B');
    const token = f.host.observe(
      { sources: [{ ref: A.ref }, { ref: B.ref }], payloadDigest: digest('AB') },
      f.agentBinding,
    );
    const result = await f.writer.write(
      {
        changes: [
          {
            id: 'needle-a',
            op: 'create',
            content: { text: 'needle a', links: [] },
            sources: [{ ref: A.ref }],
            input: token,
          },
          {
            id: 'needle-b',
            op: 'create',
            content: { text: 'needle b', links: [] },
            sources: [{ ref: B.ref }],
            input: token,
          },
        ],
      },
      { budget },
    );
    assert.equal(f.host.manifest(token, f.agentBinding).generation.outputs.length, 2);
    await revise(f.memory, A.ref, 'A changed', {}, { budget });
    const page = await f.writer.search('needle', { budget, depth: 0 });
    assert.equal(page.items.length, 0);
    assert.equal(page.stale.length, Object.keys(result.changes).length);
  });
  test(`${adapter} V08-26 inherited working state cannot drop its dependency`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'A');
    const first = await observed(f, A.ref);
    const next = f.host.observe(
      { inherit: [first], basis: 'historical', payloadDigest: digest('working state') },
      f.agentBinding,
    );
    const out = await create(f.writer, 'needle inherited', { input: next });
    await revise(f.memory, A.ref, 'changed', {}, { budget });
    assert.ok((await f.writer.search('needle', { budget, depth: 0 })).stale.includes(out.ref));
  });
  test(`${adapter} inherited staged generation outputs remain purge dependencies`, async (t) => {
    const f = setup(t);
    const source = await create(f.memory, 'ancestor source');
    const input = await observed(f, source.ref);
    const childInput = f.host.observe(
      { inherit: [input], payloadDigest: digest('generated working state') },
      f.agentBinding,
    );
    const edit = await f.writer.write(
      {
        changes: [
          {
            id: 'parent',
            op: 'create',
            content: { text: 'parent output', links: [] },
            sources: [],
            input,
          },
          {
            id: 'child',
            op: 'create',
            content: { text: 'child output', links: [] },
            sources: [],
            input: childInput,
          },
        ],
      },
      { budget },
    );
    const parent = f.storage.metaGet(`sdk:ref:${edit.changes.parent.ref}`).target;
    assert.ok(
      f.host
        .manifest(childInput, f.agentBinding)
        .generation.inheritedOutputs.some((r) => r.atomId === parent.atomId),
    );
    assert.equal(f.host.purge(parent.atomId).complete, true);
    await assert.rejects(f.memory.inspect(edit.changes.child.ref), { code: 'ACCESS_DENIED' });
    assert.equal((await f.memory.inspect(source.ref)).atom.text, 'ancestor source');
  });
  test(`${adapter} V08-27 unshown selection inputs remain erasure dependencies`, async (t) => {
    const f = setup(t);
    const a = await create(f.memory, 'needle a');
    const b = await create(f.memory, 'needle b');
    const page = await f.writer.read({ query: 'needle' }, { limit: 1, tokens: 10000, budget });
    const unseen = page.refs.includes(a.ref) ? b : a;
    const token = f.host.observe(
      { presentations: [{ receipt: page.receipt }], payloadDigest: digest(page.text) },
      f.agentBinding,
    );
    const out = await create(f.writer, 'generated result', { input: token });
    const result = f.host.purge(f.storage.metaGet(`sdk:ref:${unseen.ref}`).target.atomId);
    assert.equal(result.complete, true);
    await assert.rejects(f.writer.inspect(out.ref), { code: 'ACCESS_DENIED' });
  });
  test(`${adapter} V08-29 historical and empty-query currentness differ`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'past input');
    const historical = await observed(f, A.ref, { basis: 'historical' });
    await revise(f.memory, A.ref, 'new head', {}, { budget });
    const out = await create(f.writer, 'historical needle', { input: historical });
    assert.ok((await f.writer.search('needle', { budget })).items.some((i) => i.ref === out.ref));
    const generated = await create(f.writer, 'past derived', {
      sources: [{ ref: (await f.memory.inspect(A.ref, { version: 'latest', budget })).atom.ref }],
    });
    const historicalDerived = await observed(f, generated.ref, { basis: 'historical' });
    const latest = (await f.memory.inspect(A.ref, { version: 'latest', budget })).atom;
    await revise(f.memory, latest.ref, 'newest', {}, { budget });
    const analysis = await create(f.writer, 'historical analysis', { input: historicalDerived });
    assert.ok(
      (await f.writer.search('analysis', { budget, depth: 0 })).items.some(
        (i) => i.ref === analysis.ref,
      ),
    );
    const empty = await f.writer.search('missing', { budget, depth: 0 });
    const current = f.host.observe(
      { presentations: [{ receipt: empty.receipt }], payloadDigest: digest('no result') },
      f.agentBinding,
    );
    await create(f.memory, 'missing inserted');
    await assert.rejects(create(f.writer, 'depends on absence', { input: current }), {
      code: 'REVISION_CONFLICT',
    });
  });
  test(`${adapter} V09-30 every agent change requires an explicit generation input`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'A');
    const B = await create(f.memory, 'B');
    const a = await observed(f, A.ref);
    await assert.rejects(
      f.writer.write(
        {
          changes: [
            {
              id: 'valid',
              op: 'create',
              content: { text: 'needle a', links: [] },
              sources: [{ ref: A.ref }],
              input: a,
            },
            {
              id: 'missing-input',
              op: 'create',
              content: { text: 'needle b', links: [] },
              sources: [{ ref: B.ref }],
            },
          ],
        },
        { budget },
      ),
      { code: 'INVALID_INPUT' },
    );
    assert.equal((await f.writer.search('needle', { budget, depth: 0 })).items.length, 0);
  });
  test(`${adapter} V09 mixed batch rejects a tokenless sibling atomically`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'A');
    const B = await create(f.memory, 'B');
    const a = await observed(f, A.ref);
    const b = await observed(f, B.ref);
    await assert.rejects(
      f.writer.write(
        {
          changes: [
            {
              id: 'needle-a',
              op: 'create',
              content: { text: 'needle a', links: [] },
              sources: [],
              input: a,
            },
            {
              id: 'needle-b',
              op: 'create',
              content: { text: 'needle b', links: [] },
              sources: [],
              input: b,
            },
            {
              id: 'needle-fallback',
              op: 'create',
              content: { text: 'needle fallback', links: [] },
              sources: [],
            },
          ],
        },
        { budget },
      ),
      { code: 'INVALID_INPUT' },
    );
    assert.equal((await f.writer.search('needle', { budget, depth: 0 })).items.length, 0);
    const output = await f.writer.write(
      {
        changes: [
          {
            id: 'needle-a',
            op: 'create',
            content: { text: 'needle a', links: [] },
            sources: [],
            input: a,
          },
          {
            id: 'needle-b',
            op: 'create',
            content: { text: 'needle b', links: [] },
            sources: [],
            input: b,
          },
        ],
      },
      { budget },
    );
    await revise(f.memory, A.ref, 'changed', {}, { budget });
    const page = await f.writer.search('needle', { budget, depth: 0 });
    assert.deepEqual(
      page.items.map((v) => v.ref),
      [output.changes['needle-b'].ref],
    );
    assert.deepEqual(page.stale, [output.changes['needle-a'].ref]);
    const purged = f.host.purge(f.storage.metaGet(`sdk:ref:${A.ref}`).target.atomId);
    assert.equal(purged.erasedAtomIds.length, 2);
    assert.equal((await f.writer.inspect(output.changes['needle-b'].ref)).atom.text, 'needle b');
  });
  test(`${adapter} V08-32 generation and inherited erasure ignore search weights`, async (t) => {
    const f = setup(t, { activation: { relations: { related: { forward: 0, reverse: 0 } } } });
    const B = await create(f.memory, 'input');
    const token = await observed(f, B.ref);
    const D = await create(f.writer, 'derived', { input: token });
    const child = await create(f.writer, 'descendant', { input: await observed(f, D.ref) });
    const plan = f.host.purge(f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId, {
      dryRun: true,
    });
    assert.equal(plan.complete, true);
    assert.equal(plan.affectedAtomIds.length, 3);
    const result = f.host.purge(f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId);
    assert.equal(result.erasedAtomIds.length, 3);
    await assert.rejects(f.memory.inspect(child.ref), { code: 'ACCESS_DENIED' });
  });
  test(`${adapter} V08-34 hidden ordinary targets expose no identity or reason`, async (t) => {
    const f = setup(t);
    const auth = f.authority.issue({
      subject: 'owner',
      readPolicies: ['p', 'hidden'],
      writePolicies: ['p', 'hidden'],
      canIngestSource: true,
    });
    const wide = { ...f.binding, auth };
    const privateClient = f.host.connect({ ...wide, writePolicy: 'hidden' });
    const B = await create(privateClient, 'secret');
    const publicClient = f.host.connect(wide);
    const P = await create(publicClient, { text: 'independent', links: { related: B.ref } });
    const old = f.storage.metaGet(`sdk:ref:${B.ref}`).target;
    const narrow = f.host.connect({ ...wide, readPolicies: ['p'] });
    const page = await narrow.read({ query: 'independent' }, { budget, depth: 0 });
    assert.equal(page.items[0].ref, P.ref);
    const link = page.items[0].links[0];
    assert.equal(link.unavailable, true);
    assert.equal('ref' in link, false);
    assert.ok(
      !page.text.includes(old.atomId) &&
        !page.text.includes(B.ref) &&
        !page.text.includes('secret'),
    );
  });
  test(`${adapter} V08-35 mixed legacy manifests preserve conservative deletion`, async (t) => {
    const f = setup(t);
    const B = await create(f.memory, 'private input');
    const target = f.storage.metaGet(`sdk:ref:${B.ref}`).target;
    const legacyPinned = {
      kind: 'pinned',
      atomId: `legacy-copied-${adapter}`,
      revisionId: `legacy-copied-${adapter}:1`,
    };
    await f.host.engine.kernel.write(
      {
        idempotencyKey: `legacy-copied-${adapter}`,
        guards: [],
        revisions: [
          {
            atomId: legacyPinned.atomId,
            revisionId: legacyPinned.revisionId,
            expectedHead: null,
            content: {
              schema: 'atom',
              state: 'active',
              body: { kind: 'inline', value: 'legacy copied' },
              slots: [
                {
                  role: 'arbitrary',
                  mode: 'refer',
                  target: { kind: 'logical', atomId: target.atomId },
                },
              ],
              origins: [],
              provenance: { kind: 'organization', producerId: 'legacy' },
              policyId: 'p',
            },
          },
        ],
      },
      f.auth,
    );
    const legacy = {
      ref: f.host.reference(legacyPinned, f.binding),
    };
    const independent = await create(f.memory, {
      text: 'surviving source',
      links: { arbitrary: B.ref },
    });
    f.host.recordUse([legacy.ref], f.binding, { eventId: 'erase-use' });
    const read = await f.writer.read({ query: 'private' }, { budget });
    const plan = f.host.purge(f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId, {
      dryRun: true,
    });
    assert.equal(plan.legacyDependencies, true);
    const done = f.host.purge(f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId);
    assert.equal(done.complete, true);
    assert.equal(
      (await f.memory.inspect(independent.ref, { budget })).atom.text,
      'surviving source',
    );
    await assert.rejects(f.memory.inspect(legacy.ref), { code: 'ACCESS_DENIED' });
    assert.equal(f.storage.metaEntries('sdk:use:state:').length, 0);
    assert.equal(
      f.storage
        .metaEntries('sdk:manifest:')
        .some(([, m]) => m.presentation?.digest === digest(read.text)),
      false,
    );
  });
  test(`${adapter} V08-36 failed and budgeted purge blocks reads until explicit resume`, async (t) => {
    const f = setup(t);
    const B = await create(f.memory, 'private bytes');
    const id = f.storage.metaGet(`sdk:ref:${B.ref}`).target.atomId;
    const stopped = f.host.purge(id, { maxWork: 0 });
    assert.equal(stopped.complete, false);
    await assert.rejects(f.memory.inspect(B.ref), { code: 'ACCESS_DENIED' });
    const erase = f.storage.erase.bind(f.storage);
    f.storage.erase = () => {
      throw Error('disk failure');
    };
    assert.equal(f.host.purge(id).reason, 'storage-error');
    await assert.rejects(f.memory.search('private'), { code: 'ACCESS_DENIED' });
    f.storage.erase = erase;
    assert.equal(f.host.purge(id).complete, true);
    assert.equal((await f.memory.search('private')).items.length, 0);
  });
  test(`${adapter} V08-37 ack counts successful exposure once per event and revision`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'needle');
    const input = await observed(f, A.ref);
    assert.equal(f.storage.metaEntries('sdk:use:state:').length, 0);
    assert.equal(
      f.host.recordUse([A.ref, A.ref], f.agentBinding, { eventId: 'request', input }).recorded,
      1,
    );
    assert.equal(
      f.host.recordUse([A.ref], f.agentBinding, { eventId: 'request', input }).repeated,
      1,
    );
    assert.equal(f.host.recordUse([A.ref], f.agentBinding, { eventId: 'next', input }).recorded, 1);
    assert.equal(f.host.manifest(input, f.agentBinding).acknowledgement.length, 2);
  });
  test(`${adapter} V08-38 reset, subjects, and revisions preserve isolation`, async (t) => {
    const f = setup(t);
    const A = await create(f.memory, 'needle');
    f.host.recordUse([A.ref], f.binding, { eventId: 'one' });
    f.host.resetUse(f.binding);
    assert.equal(f.host.recordUse([A.ref], f.binding, { eventId: 'one' }).repeated, 1);
    assert.equal(f.storage.metaEntries('sdk:use:state:').length, 0);
    const other = {
      ...f.binding,
      auth: f.authority.issue({ subject: 'other', readPolicies: ['p'], writePolicies: ['p'] }),
    };
    const ref = f.host.reference(f.storage.metaGet(`sdk:ref:${A.ref}`).target, other);
    f.host.recordUse([ref], other, { eventId: 'one' });
    const next = await revise(f.memory, A.ref, 'needle revised', {}, { budget });
    assert.equal(f.storage.metaEntries('sdk:use:state:').length, 1);
    assert.equal(f.host.recordUse([next.value.ref], f.binding, { eventId: 'one' }).recorded, 1);
  });
  test(`${adapter} V08-39 cursor fixes evaluation while each page includes required text`, async (t) => {
    const f = setup(t, { activation: { propagation: 0 } });
    const c = await create(f.memory, 'condition');
    for (const text of ['needle a', 'needle b'])
      await create(f.memory, { text, links: { when: { ref: c.ref, required: true } } });
    const first = await f.memory.read(
      { query: 'needle' },
      { limit: 2, tokens: 10000, budget, depth: 0 },
    );
    assert.ok(first.cursor);
    assert.ok(first.refs.includes(c.ref));
    f.host.recordUse(first.refs, f.binding, { eventId: 'page' });
    const next = await f.memory.read(
      { query: 'needle' },
      { limit: 2, tokens: 10000, budget, depth: 0, cursor: first.cursor },
    );
    assert.ok(next.refs.includes(c.ref));
    assert.equal(first.diagnostics.evaluatedAt, next.diagnostics.evaluatedAt);
    await assert.rejects(
      f.memory.read({ query: 'different' }, { cursor: first.cursor, depth: 0, budget }),
      { code: 'CURSOR_EXPIRED' },
    );
  });
}
