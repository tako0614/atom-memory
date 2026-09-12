import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';

for (const reopenLegacy of [false, true])
  test(`SQLite purge follows historical and uncited dependencies without a full scan (legacy=${reopenLegacy})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atom-purge-'));
    const path = join(dir, 'memory.sqlite');
    let storage = new SqliteStorage(path);
    try {
      const { memory, writer } = fixture({ storage });
      const source = await memory.write('private original');
      const unrelated = await memory.write('unrelated survives');
      const dependent = await writer.edit(async (draft) => {
        await draft.inspect(source.ref, { depth: 0 });
        return draft.write('uncited interpretation');
      });
      const relation = await memory.write({
        text: 'historical reference',
        links: { target: source.ref },
      });
      await memory.edit((draft) => draft.revise(relation.ref, 'current version has no link'));
      const ids = [source.ref, dependent.value.ref, relation.ref].map(
        (ref) => storage.metaGet(`sdk:ref:${ref}`).target.atomId,
      );
      const surviving = storage.metaGet(`sdk:ref:${unrelated.ref}`).target.atomId;
      if (reopenLegacy) {
        storage.close();
        const raw = new DatabaseSync(path);
        raw.exec(
          "DROP TABLE am_purge_edges;DROP TABLE am_receipt_inputs;DROP TABLE am_receipt_owners;DELETE FROM am_state WHERE key='purge-index-v1'",
        );
        raw.close();
        storage = new SqliteStorage(path);
      }
      storage.history = () => {
        throw Error('purge must not scan the entire history');
      };
      const active = fixture({ storage }).host;
      assert.deepEqual(active.purge(ids[0]).erasedAtomIds.sort(), ids.sort());
      for (const id of ids)
        assert.equal(storage.get({ kind: 'logical', atomId: id }, storage.watermark()), undefined);
      assert.equal(
        storage.get({ kind: 'logical', atomId: surviving }, storage.watermark()).body.value,
        'unrelated survives',
      );
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('purge indexes stay atomic for the pre-index SQLite write protocol', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-purge-legacy-'));
  const path = join(dir, 'memory.sqlite');
  const storage = new SqliteStorage(path);
  try {
    const { memory } = fixture({ storage });
    const source = await memory.write('source');
    const id = storage.metaGet(`sdk:ref:${source.ref}`).target.atomId;
    const revision = structuredClone(
      storage.get({ kind: 'logical', atomId: id }, storage.watermark()),
    );
    Object.assign(revision, {
      atomId: 'legacy-derived',
      revisionId: 'legacy-derived:1',
      slots: [],
      origins: [],
      provenance: { kind: 'derived', producerId: 'legacy', inputReceiptId: 'legacy-input' },
    });
    const raw = new DatabaseSync(path);
    try {
      raw.prepare('INSERT INTO am_metadata VALUES(?,?)').run(
        'receipt:legacy-input',
        JSON.stringify({
          receipt: { receiptId: 'legacy-input' },
          reads: [{ kind: 'logical', atomId: id }],
        }),
      );
      raw
        .prepare('INSERT INTO am_revisions VALUES(?,?,?,?,?,?,?,?)')
        .run(
          revision.atomId,
          revision.revisionId,
          storage.watermark(),
          revision.policyId,
          revision.schema,
          revision.state,
          JSON.stringify(revision.body),
          JSON.stringify(revision),
        );
      assert.ok(storage.purgePlan(id).revisions.some((r) => r.atomId === 'legacy-derived'));
      raw.exec('BEGIN IMMEDIATE');
      raw
        .prepare('UPDATE am_metadata SET value=? WHERE key=?')
        .run(
          JSON.stringify({ receipt: { receiptId: 'legacy-input' }, reads: [] }),
          'receipt:legacy-input',
        );
      raw.exec('ROLLBACK');
      assert.ok(
        storage.purgePlan(id).revisions.some((r) => r.atomId === 'legacy-derived'),
        'receipt and reverse index must roll back together',
      );
    } finally {
      raw.close();
    }
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
