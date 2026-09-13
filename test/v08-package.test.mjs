import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, MemoryStorage, LocalAuthority } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
for (const adapter of ['memory', 'sqlite'])
  test(`${adapter} V08-40 package exports and persisted observations`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-v08-package-'));
    let storage =
      adapter === 'memory' ? new MemoryStorage() : new SqliteStorage(join(dir, 'atoms.sqlite'));
    t.after(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const authority = new LocalAuthority();
    const auth = authority.issue({
      subject: 'consumer',
      readPolicies: ['p'],
      writePolicies: ['p'],
      canIngestSource: true,
    });
    const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
    const agent = { ...binding, actor: { type: 'agent' } };
    let host = new MemoryHost({ authority, storage });
    const source = await host.connect(binding).write('needle original');
    const page = await host.connect(agent).read({ query: 'needle' }, { tokens: 10000 });
    const input = host.observe(
      {
        presentations: [{ receipt: page.receipt }],
        payloadDigest: createHash('sha256').update(page.text).digest('hex'),
      },
      agent,
    );
    const output = await host.connect(agent).write('needle derived', { input });
    host.recordUse(page.refs, agent, { eventId: 'request', input });
    if (adapter === 'sqlite') {
      storage.close();
      storage = new SqliteStorage(join(dir, 'atoms.sqlite'));
    }
    host = new MemoryHost({ authority, storage });
    assert.equal(host.manifest(input, agent).generation.outputs.length, 1);
    assert.equal(host.recordUse(page.refs, agent, { eventId: 'request', input }).repeated, 1);
    assert.equal((await host.connect(agent).inspect(output.ref)).atom.text, 'needle derived');
    assert.equal((await host.connect(binding).inspect(source.ref)).atom.text, 'needle original');
    const marker = 'v08-physical-erasure-canary-982735';
    const blob = await host.ingestBlob(Buffer.from(marker), 'text/plain', binding);
    const partial = await host
      .connect(agent)
      .inspect(blob.ref, { depth: 0, range: { start: 0, bytes: 3 } });
    const manifest = host.manifest(partial.receipt, agent);
    assert.deepEqual(manifest.presentation.units[0].range, { start: 0, end: 3 });
    assert.equal(manifest.acquisition.ranges[0].end, 3);
    assert.equal(
      manifest.presentation.units[0].digest,
      createHash('sha256').update(marker.slice(0, 3)).digest('hex'),
    );
    const token = host.observe(
      {
        presentations: [{ receipt: partial.receipt }],
        payloadDigest: createHash('sha256').update(partial.range.text).digest('hex'),
      },
      agent,
    );
    const derived = await host.connect(agent).write(marker, { input: token });
    if (adapter === 'sqlite') {
      storage.compact();
      assert.equal(readFileSync(join(dir, 'atoms.sqlite')).includes(Buffer.from(marker)), true);
    }
    const pin = storage.metaGet(`sdk:ref:${blob.ref}`).target;
    const result = host.purge(pin.atomId);
    assert.equal(result.complete, true);
    await assert.rejects(host.connect(agent).inspect(derived.ref), { code: 'ACCESS_DENIED' });
    if (adapter === 'sqlite') {
      storage.compact();
      assert.equal(readFileSync(join(dir, 'atoms.sqlite')).includes(Buffer.from(marker)), false);
      assert.equal(
        readFileSync(join(dir, 'atoms.sqlite')).includes(
          Buffer.from(Buffer.from(marker).toString('base64')),
        ),
        false,
      );
    }
  });
