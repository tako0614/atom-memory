import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAuthority, MemoryHost } from '../dist/index.js';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture, create, revise } from './fixtures.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const only = (result, id) => result.changes[id];

test('V09 declarative batches preallocate local cycles, dedupe shared neighbors, revise and retire', async () => {
  const { memory, storage } = fixture();
  const created = await memory.write({
    changes: [
      {
        id: 'a',
        op: 'create',
        content: {
          text: 'cycle a',
          links: [
            { role: 'next', target: { local: 'b' } },
            { role: 'same-next', target: { local: 'b', at: 'observed', orderKey: 'pinned' } },
          ],
        },
        sources: [],
      },
      {
        id: 'b',
        op: 'create',
        content: { text: 'cycle b', links: { back: { local: 'a' } } },
        sources: [],
      },
      {
        id: 'shared',
        op: 'create',
        content: {
          text: 'shared relation',
          links: {
            member: [{ local: 'a' }, { local: 'a', at: 'observed' }, { local: 'b' }],
          },
        },
        sources: [],
      },
    ],
  });
  assert.deepEqual(Object.keys(created.changes), ['a', 'b', 'shared']);
  const shared = await memory.inspect(created.changes.shared.ref, { direction: 'outgoing' });
  assert.equal(shared.neighbors.length, 2);
  assert.equal(shared.neighbors.find((neighbor) => neighbor.atom.text === 'cycle a').via.length, 2);
  const oldB = storage.get(
    storage.metaGet(`sdk:ref:${created.changes.b.ref}`).target,
    storage.watermark(),
  );
  const changed = await memory.write({
    changes: [
      {
        id: 'revise-a',
        op: 'revise',
        target: created.changes.a.ref,
        content: { text: 'cycle a revised', links: [] },
        sources: [],
      },
      { id: 'retire-b', op: 'retire', target: created.changes.b.ref },
    ],
  });
  assert.equal(changed.changes['revise-a'].text, 'cycle a revised');
  assert.equal(changed.changes['revise-a'].links.length, 0, 'revision is a full replacement');
  assert.equal(changed.changes['retire-b'].state, 'retired');
  const retiredB = storage.get({ kind: 'logical', atomId: oldB.atomId }, storage.watermark());
  assert.deepEqual(retiredB.body, oldB.body);
  assert.deepEqual(retiredB.slots, oldB.slots);
  assert.deepEqual(retiredB.origins, oldB.origins);
  assert.equal((await memory.inspect(created.changes.b.ref)).atom.state, 'active');
  assert.equal(
    (await memory.inspect(created.changes.b.ref, { version: 'latest' })).atom.state,
    'retired',
  );
});

test('V09 generation grouping is order-independent and local links do not merge inputs', async () => {
  const f = fixture();
  const source = await create(f.memory, 'generation source');
  const observed = await f.writer.inspect(source.ref, { limit: 0 });
  const parentInput = f.host.observe(
    {
      presentations: [{ receipt: observed.receipt }],
      payloadDigest: digest('parent generation'),
    },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const childInput = f.host.observe(
    { inherit: [parentInput], payloadDigest: digest('child generation') },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const reversed = await f.writer.write({
    changes: [
      {
        id: 'child',
        op: 'create',
        content: { text: 'child output', links: [] },
        sources: [],
        input: childInput,
      },
      {
        id: 'parent',
        op: 'create',
        content: { text: 'parent output', links: [] },
        sources: [],
        input: parentInput,
      },
    ],
  });
  const parentPinned = f.storage.metaGet(`sdk:ref:${reversed.changes.parent.ref}`).target;
  assert.ok(
    f.host
      .manifest(childInput, { ...f.binding, actor: { type: 'agent' } })
      .generation.inheritedOutputs.some(
        (candidate) => candidate.revisionId === parentPinned.revisionId,
      ),
  );

  const other = await create(f.memory, 'other generation source');
  const otherObserved = await f.writer.inspect(other.ref, { limit: 0 });
  const otherInput = f.host.observe(
    {
      presentations: [{ receipt: otherObserved.receipt }],
      payloadDigest: digest('other generation'),
    },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const leftInput = f.host.observe(
    {
      presentations: [{ receipt: observed.receipt }],
      payloadDigest: digest('left generation'),
    },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const crossed = await f.writer.write({
    changes: [
      {
        id: 'left',
        op: 'create',
        content: { text: 'cross_scope left', links: { peer: { local: 'right' } } },
        sources: [],
        input: leftInput,
      },
      {
        id: 'right',
        op: 'create',
        content: { text: 'cross_scope right', links: { peer: { local: 'left' } } },
        sources: [],
        input: otherInput,
      },
    ],
  });
  const agentBinding = { ...f.binding, actor: { type: 'agent' } };
  assert.deepEqual(
    f.host.manifest(leftInput, agentBinding).generation.outputs.map((output) => output.revisionId),
    [f.storage.metaGet(`sdk:ref:${crossed.changes.left.ref}`).target.revisionId],
  );
  assert.deepEqual(
    f.host.manifest(otherInput, agentBinding).generation.outputs.map((output) => output.revisionId),
    [f.storage.metaGet(`sdk:ref:${crossed.changes.right.ref}`).target.revisionId],
  );
  assert.equal(
    (
      await f.writer.inspect(crossed.changes.left.ref, {
        direction: 'outgoing',
      })
    ).neighbors[0].atom.ref,
    crossed.changes.right.ref,
  );
  await revise(f.memory, source.ref, 'generation source changed');
  const current = await f.writer.search('cross_scope', { depth: 0 });
  assert.deepEqual(
    current.items.map((item) => item.ref),
    [crossed.changes.right.ref],
  );
  assert.deepEqual(current.stale, [crossed.changes.left.ref]);
  const purged = f.host.purge(f.storage.metaGet(`sdk:ref:${source.ref}`).target.atomId);
  assert.ok(
    !purged.erasedAtomIds.includes(
      f.storage.metaGet(`sdk:ref:${crossed.changes.right.ref}`).target.atomId,
    ),
  );
  assert.equal((await f.writer.inspect(crossed.changes.right.ref)).atom.text, 'cross_scope right');
});

for (const adapter of ['memory', 'sqlite'])
  test(`V09 ${adapter} retire preserves unavailable raw slots and origins`, async (t) => {
    const storage = adapter === 'sqlite' ? new SqliteStorage(':memory:') : undefined;
    const f = fixture(storage ? { storage } : {});
    t.after(() => f.storage.close());
    const source = await create(f.memory, 'source removed outside the normal purge closure');
    const root = await create(
      f.memory,
      {
        text: 'retire me exactly',
        links: { evidence: { ref: source.ref, at: 'observed', required: true } },
      },
      { sources: [{ ref: source.ref }] },
    );
    const sourceTarget = f.storage.metaGet(`sdk:ref:${source.ref}`).target;
    const rootTarget = f.storage.metaGet(`sdk:ref:${root.ref}`).target;
    const before = structuredClone(f.storage.get(rootTarget, f.storage.watermark()));
    // Test-only legacy damage: a normal purge follows the origin and erases the owner too.
    f.storage.erase([sourceTarget.atomId]);
    const result = await f.memory.write({
      changes: [{ id: 'retired', op: 'retire', target: root.ref }],
    });
    assert.equal(result.changes.retired.state, 'retired');
    assert.equal(result.changes.retired.links[0].unavailable, true);
    assert.ok(
      result.changes.retired.sources.every((citation) => citation.ref !== source.ref),
      'an unavailable origin is not exposed as a still-readable citation',
    );
    const after = f.storage.get(
      { kind: 'logical', atomId: rootTarget.atomId },
      f.storage.watermark(),
    );
    assert.equal(after.state, 'retired');
    assert.deepEqual(after.body, before.body);
    assert.deepEqual(after.slots, before.slots);
    assert.deepEqual(after.origins, before.origins);
  });

test('V09 inspect is one-hop, pageable, version-exact, scoped and fully receipted', async () => {
  const f = fixture();
  const batch = await f.memory.write({
    changes: [
      {
        id: 'root',
        op: 'create',
        content: {
          text: 'root',
          links: {
            outgoing: { local: 'neighbor' },
            'outgoing-again': { local: 'neighbor', at: 'observed' },
            unreturned: { local: 'other' },
          },
        },
        sources: [],
      },
      {
        id: 'neighbor',
        op: 'create',
        content: {
          text: 'reciprocal neighbor',
          links: {
            incoming: { local: 'root' },
            'incoming-again': { local: 'root', at: 'observed' },
          },
        },
        sources: [],
      },
      {
        id: 'other',
        op: 'create',
        content: { text: 'other outgoing neighbor', links: [] },
        sources: [],
      },
    ],
  });
  const root = batch.changes.root;
  const both = await f.memory.inspect(root.ref);
  assert.equal(both.neighbors.length, 2);
  const reciprocal = both.neighbors.find(
    (neighbor) => neighbor.atom.ref === batch.changes.neighbor.ref,
  );
  assert.ok(reciprocal);
  assert.deepEqual(
    new Set(reciprocal.via.map((via) => `${via.direction}:${via.role}`)),
    new Set([
      'outgoing:outgoing',
      'outgoing:outgoing-again',
      'incoming:incoming',
      'incoming:incoming-again',
    ]),
  );
  assert.ok(both.usage.maxAtoms >= 3);
  const manifest = f.host.manifest(both.receipt, f.binding);
  assert.equal(manifest.presentation.units.length, 3);
  assert.equal(manifest.presentation.units[0].metadata.inspectionRoot, true);
  assert.deepEqual(
    manifest.presentation.units.find((unit) => unit.ref === reciprocal.atom.ref).metadata.via,
    reciprocal.via,
  );

  const firstOutgoing = await f.memory.inspect(root.ref, { direction: 'outgoing', limit: 1 });
  assert.ok(firstOutgoing.cursor);
  const firstOutgoingManifest = f.host.manifest(firstOutgoing.receipt, f.binding);
  assert.equal(firstOutgoingManifest.presentation.units.length, 2);
  assert.equal(
    firstOutgoingManifest.reads.length,
    2,
    'an unreturned outgoing neighbor remains cursor state, not a recorded read',
  );

  const rootOnly = await f.memory.inspect(root.ref, { limit: 0 });
  assert.deepEqual(rootOnly.neighbors, []);
  assert.equal(rootOnly.cursor, undefined);
  assert.equal(rootOnly.usage.maxAtoms, 1);
  const rootOnlyManifest = f.host.manifest(rootOnly.receipt, f.binding);
  assert.equal(rootOnlyManifest.presentation.units.length, 1);
  assert.deepEqual(
    rootOnlyManifest.reads.map((read) => read.revisionId),
    [f.storage.metaGet(`sdk:ref:${root.ref}`).target.revisionId],
    'issuing the linked neighbor ref does not record its body as read',
  );

  const selfWrite = await f.memory.write({
    changes: [
      {
        id: 'self',
        op: 'create',
        content: { text: 'self relation', links: { self: { local: 'self' } } },
        sources: [],
      },
    ],
  });
  const selfInspection = await f.writer.inspect(selfWrite.changes.self.ref);
  assert.equal(selfInspection.neighbors[0].atom.ref, selfInspection.atom.ref);
  assert.equal(
    f.host.manifest(selfInspection.receipt, { ...f.binding, actor: { type: 'agent' } }).presentation
      .units.length,
    1,
  );
  assert.doesNotThrow(() =>
    f.host.observe(
      {
        presentations: [{ receipt: selfInspection.receipt }],
        payloadDigest: digest('self output'),
      },
      { ...f.binding, actor: { type: 'agent' } },
    ),
  );

  const relation = await create(f.memory, {
    text: 'versioned relation',
    links: [
      { role: 'pinned-old', target: { ref: root.ref, at: 'observed' } },
      { role: 'logical-current', target: root.ref },
    ],
  });
  const latest = await revise(f.memory, root.ref, 'root revised');
  const oldIncoming = await f.memory.inspect(root.ref, {
    direction: 'incoming',
    roles: ['pinned-old', 'logical-current'],
  });
  assert.equal(oldIncoming.neighbors[0].atom.ref, relation.ref);
  assert.deepEqual(
    oldIncoming.neighbors[0].via.map((via) => via.role),
    ['pinned-old'],
  );
  const latestIncoming = await f.memory.inspect(root.ref, {
    version: 'latest',
    direction: 'incoming',
    roles: ['pinned-old', 'logical-current'],
  });
  assert.equal(latestIncoming.atom.ref, latest.value.ref);
  assert.deepEqual(
    latestIncoming.neighbors[0].via.map((via) => via.role),
    ['logical-current'],
  );

  for (let index = 0; index < 4; index++)
    await create(f.memory, { text: `page ${index}`, links: { page: latest.value.ref } });
  let page = await f.memory.inspect(latest.value.ref, {
    direction: 'incoming',
    roles: ['page'],
    limit: 1,
  });
  const firstCursor = page.cursor;
  assert.ok(firstCursor);
  await assert.rejects(
    f.memory.inspect(latest.value.ref, {
      direction: 'outgoing',
      roles: ['page'],
      limit: 1,
      cursor: firstCursor,
    }),
    { code: 'CURSOR_EXPIRED' },
  );
  const seen = new Set(page.neighbors.map((neighbor) => neighbor.atom.ref));
  while (page.cursor) {
    page = await f.memory.inspect(latest.value.ref, {
      direction: 'incoming',
      roles: ['page'],
      limit: 1,
      cursor: page.cursor,
    });
    page.neighbors.forEach((neighbor) => seen.add(neighbor.atom.ref));
  }
  assert.equal(seen.size, 4);

  const expiring = await f.memory.inspect(latest.value.ref, {
    direction: 'incoming',
    roles: ['page'],
    limit: 1,
  });
  f.authority.update(f.auth, {
    subject: 'owner',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  await assert.rejects(
    f.memory.inspect(latest.value.ref, {
      direction: 'incoming',
      roles: ['page'],
      limit: 1,
      cursor: expiring.cursor,
    }),
    { code: 'ACCESS_DENIED' },
  );

  f.authority.update(f.auth, {
    subject: 'owner',
    readPolicies: ['p', 'hidden'],
    writePolicies: ['p', 'hidden'],
    canIngestSource: true,
  });
  const hidden = f.host.connect({ ...f.binding, writePolicy: 'hidden' });
  await create(hidden, { text: 'secret inbound', links: { secret: latest.value.ref } });
  const narrow = f.host.connect({ ...f.binding, readPolicies: ['p'] });
  assert.deepEqual(
    (
      await narrow.inspect(latest.value.ref, {
        direction: 'incoming',
        roles: ['secret'],
      })
    ).neighbors,
    [],
  );
  assert.equal(
    (
      await hidden.inspect(latest.value.ref, {
        direction: 'incoming',
        roles: ['secret'],
      })
    ).neighbors.length,
    1,
  );
});

test('V09 SQLite idempotency survives a discarded acknowledgement, reconnect and expired input', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-v09-replay-'));
  const path = join(dir, 'atoms.sqlite');
  const authority = new LocalAuthority();
  const grant = {
    subject: 'writer',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  };
  const auth = authority.issue(grant);
  const human = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const agent = { auth, writePolicy: 'p', actor: { type: 'agent' } };
  let storage = new SqliteStorage(path);
  t.after(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let host = new MemoryHost({ authority, storage, cursorTtlMs: 1000 });
  const sourceResult = await host.connect(human).write({
    changes: [
      {
        id: 'source',
        op: 'create',
        content: { text: 'durable source', links: [] },
        sources: [],
      },
    ],
  });
  const source = sourceResult.changes.source;
  const sourcePinned = storage.metaGet(`sdk:ref:${source.ref}`).target;
  const presented = await host.connect(agent).inspect(source.ref, { limit: 0 });
  const input = host.observe(
    {
      presentations: [{ receipt: presented.receipt }],
      payloadDigest: digest('durable output'),
    },
    agent,
  );
  const request = {
    changes: [
      {
        id: 'output',
        op: 'create',
        content: { text: 'durable output', links: [] },
        sources: [{ ref: source.ref }],
        input,
      },
    ],
  };
  const first = await host.connect(agent).write(request, { idempotencyKey: 'request-42' });
  assert.equal(first.repeated, false);
  storage.close();

  const renewedAuth = authority.issue(grant);
  const renewedAgent = { auth: renewedAuth, writePolicy: 'p', actor: { type: 'agent' } };
  storage = new SqliteStorage(path);
  host = new MemoryHost({ authority, storage, cursorTtlMs: 1000 });
  const renewedSource = host.reference(sourcePinned, renewedAgent);
  const replayRequest = {
    changes: [
      {
        ...request.changes[0],
        sources: [{ ref: renewedSource }],
      },
    ],
  };
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  let replay;
  try {
    replay = await host.connect(renewedAgent).write(replayRequest, {
      idempotencyKey: 'request-42',
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(replay.repeated, true);
  assert.equal(replay.operationId, first.operationId);
  assert.notEqual(replay.changes.output.ref, first.changes.output.ref);
  assert.equal(
    (await host.connect(renewedAgent).inspect(replay.changes.output.ref)).atom.text,
    'durable output',
  );
  await assert.rejects(
    host.connect(renewedAgent).write(
      {
        changes: [
          {
            ...replayRequest.changes[0],
            content: { text: 'different output', links: [] },
          },
        ],
      },
      { idempotencyKey: 'request-42' },
    ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const outputPinned = storage.metaGet(`sdk:ref:${replay.changes.output.ref}`).target;
  host.purge(outputPinned.atomId);
  await assert.rejects(
    host.connect(renewedAgent).write(replayRequest, { idempotencyKey: 'request-42' }),
    { code: 'ACCESS_DENIED' },
  );
});

test('V09 rejects partial write shapes, empty batches, inspect depth and tokenless agent retirement', async () => {
  const f = fixture();
  const special = await f.memory.write(
    {
      changes: [
        {
          id: '__proto__',
          op: 'create',
          content: { text: 'special local id', links: [] },
          sources: [],
        },
      ],
    },
    { idempotencyKey: 'special-local-id' },
  );
  assert.equal(Object.hasOwn(special.changes, '__proto__'), true);
  assert.equal(special.changes.__proto__.text, 'special local id');
  const specialReplay = await f.memory.write(
    {
      changes: [
        {
          id: '__proto__',
          op: 'create',
          content: { text: 'special local id', links: [] },
          sources: [],
        },
      ],
    },
    { idempotencyKey: 'special-local-id' },
  );
  assert.equal(specialReplay.repeated, true);
  assert.equal(Object.hasOwn(specialReplay.changes, '__proto__'), true);
  await assert.rejects(f.memory.write({ changes: [] }), { code: 'INVALID_INPUT' });
  await assert.rejects(
    f.memory.write({
      changes: [{ id: 'missing-links', op: 'create', content: { text: 'x' }, sources: [] }],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    f.memory.write({
      changes: [
        {
          id: 'missing-sources',
          op: 'create',
          content: { text: 'x', links: [] },
        },
      ],
    }),
    { code: 'INVALID_INPUT' },
  );
  const target = await create(f.memory, 'retirement target');
  await assert.rejects(
    f.writer.write({
      changes: [{ id: 'retire', op: 'retire', target: target.ref }],
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(f.memory.inspect(target.ref, { depth: 1 }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.memory.inspect(target.ref, { version: 'invalid' }), {
    code: 'INVALID_INPUT',
  });

  const presented = await f.writer.inspect(target.ref, { limit: 0 });
  const input = f.host.observe(
    {
      presentations: [{ receipt: presented.receipt }],
      payloadDigest: digest('retire'),
    },
    { ...f.binding, actor: { type: 'agent' } },
  );
  const retired = await f.writer.write({
    changes: [{ id: 'retire', op: 'retire', target: target.ref, input }],
  });
  assert.equal(retired.changes.retire.state, 'retired');

  const adapter = f.host.connect({ ...f.binding, actor: { type: 'input-adapter' } });
  const source = await adapter.write({
    changes: [
      {
        id: 'trusted-source',
        op: 'create',
        content: { text: 'trusted input', links: [] },
        sources: [],
      },
    ],
  });
  assert.equal(only(source, 'trusted-source').provenance.origin, 'source');
});
