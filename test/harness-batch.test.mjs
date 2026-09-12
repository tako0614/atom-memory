import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHarness, MemoryStorage, utf8Tokenizer } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';
const model = (respond) => ({
  id: 'batch-test',
  tokenizer: utf8Tokenizer,
  contextWindow: 65536,
  networkCallsPerCall: 0,
  respond,
});
const run = {
  input: 'historytopic',
  commit: 'edit',
  basis: 'historical',
  budget: { maxContextTokens: 60000, maxModelInputTokens: 120000, maxModelOutputTokens: 12000 },
};
for (const backend of ['memory', 'sqlite']) {
  const setup = (t) => {
    const storage = backend === 'memory' ? new MemoryStorage() : new SqliteStorage(':memory:');
    t.after(() => storage.close?.());
    const f = fixture({ storage });
    return {
      ...f,
      writer: f.host.connect({
        ...f.binding,
        actor: { type: 'agent', generatedOrigin: 'organization' },
      }),
    };
  };
  test(`${backend}: one response writes linked Atoms and a later period revises the same group`, async (t) => {
    const { memory, writer } = setup(t);
    await memory.write('historytopic January: Ada proposed a library.');
    const first = new MemoryHarness({
      memory: writer,
      instruction: 'Organize evidence.',
      maxOutputTokensPerStep: 6000,
      model: model(async (input) => {
        const source = input.memory.memory.find((row) => row.text.includes('January')).ref;
        return {
          kind: 'batch',
          operations: [
            {
              kind: 'write',
              as: 'fact',
              content: 'historytopic: Ada proposed a library.',
              sources: [{ ref: source }],
            },
            {
              kind: 'write',
              as: 'group',
              content: 'historytopic arrangement: library design.',
              sources: [{ ref: source }],
            },
            {
              kind: 'write',
              content: {
                text: 'historytopic membership.',
                links: { group: '$group', member: '$fact' },
              },
              sources: [{ ref: source }],
            },
          ],
          output: { processed: 'January' },
        };
      }),
    });
    const one = await first.run(run);
    assert.equal(one.status, 'completed', one.error);
    assert.equal(one.steps, 1);
    assert.equal(one.changes.length, 3);
    const group = one.changes.find((row) => row.text.includes('arrangement'));
    assert.equal(one.changes.find((row) => row.text.includes('membership')).links.length, 2);
    await memory.write('historytopic July: Ada added SQLite support to the same library.');
    let step = 0;
    const later = new MemoryHarness({
      memory: writer,
      instruction: 'Update the existing arrangement.',
      maxOutputTokensPerStep: 6000,
      model: model(async (input) => {
        if (++step === 1) return { kind: 'search', query: 'historytopic', limit: 20 };
        const rows = input.observations.at(-1).items;
        const existing = rows.find((row) => row.text.includes('arrangement'));
        const source = rows.find((row) => row.text.includes('July'));
        return {
          kind: 'batch',
          operations: [
            {
              kind: 'revise',
              as: 'group',
              ref: existing.ref,
              content: 'historytopic arrangement: library design now includes SQLite.',
              sources: [{ ref: source.ref }],
            },
            {
              kind: 'write',
              content: { text: 'historytopic July addition.', links: { group: '$group' } },
              sources: [{ ref: source.ref }],
            },
          ],
          output: 'July processed',
        };
      }),
    });
    const two = await later.run(run);
    assert.equal(two.status, 'completed', two.error);
    assert.equal(two.steps, 2);
    const revised = two.changes.find((row) => row.text.includes('arrangement'));
    assert.notEqual(revised.ref, group.ref);
    assert.equal((await memory.inspect(group.ref)).items[0].text, group.text);
    assert.equal(
      (await memory.inspect(group.ref, { version: 'latest' })).items[0].text,
      revised.text,
    );
  });
  test(`${backend}: batch errors roll back earlier steps, invalid refs, duplicate aliases and source spoofing`, async (t) => {
    const { memory, writer } = setup(t);
    for (const bad of [
      { kind: 'write', content: { text: 'bad', links: { x: '$later' } } },
      { kind: 'write', as: 'first', content: 'duplicate alias' },
      { kind: 'write', content: { text: 'spoof', provenance: { origin: 'source' } } },
      { kind: 'batch', operations: [] },
    ]) {
      let step = 0;
      const harness = new MemoryHarness({
        memory: writer,
        instruction: 'Organize.',
        model: model(async () =>
          ++step === 1
            ? { kind: 'write', content: 'historytopic prior step' }
            : {
                kind: 'batch',
                operations: [{ kind: 'write', as: 'first', content: 'historytopic staged' }, bad],
                output: null,
              },
        ),
      });
      const result = await harness.run(run);
      assert.equal(result.status, 'failed');
      assert.equal((await memory.search('historytopic')).items.length, 0);
    }
  });
  test(`${backend}: read-only, operation limit and local alias lifetime apply to batches`, async (t) => {
    const { memory, writer } = setup(t);
    const action = {
      kind: 'batch',
      operations: [{ kind: 'write', as: 'a', content: 'historytopic staged' }],
      output: null,
    };
    const readOnly = new MemoryHarness({
      memory: writer,
      instruction: 'Read.',
      model: model(async (input) => {
        assert.ok(input.tools.every((tool) => tool.kind !== 'batch'));
        return action;
      }),
    });
    assert.equal((await readOnly.run({ input: 'historytopic' })).error, 'ACCESS_DENIED');
    const bounded = new MemoryHarness({
      memory: writer,
      instruction: 'Write.',
      maxBatchOperations: 1,
      model: model(async () => ({
        ...action,
        operations: [...action.operations, { kind: 'write', content: 'too many' }],
      })),
    });
    assert.equal((await bounded.run(run)).error, 'LIMIT_EXCEEDED');
    let step = 0;
    const staged = new MemoryHarness({
      memory: writer,
      instruction: 'Write.',
      model: model(async (input) => {
        if (++step === 1) return { kind: 'batch', operations: action.operations };
        assert.equal(input.observations.at(-1).operation, 'batch');
        assert.match(input.observations.at(-1).results[0].ref, /^m\d+$/);
        return { kind: 'write', content: { text: 'bad reuse', links: { x: '$a' } } };
      }),
    });
    assert.equal((await staged.run(run)).error, 'INVALID_REF');
    assert.equal((await memory.search('historytopic')).items.length, 0);
  });
}
