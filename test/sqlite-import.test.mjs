import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

test('replayable SQLite import flushes before an external checkpoint and retains rollback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atom-import-'));
  const path = join(dir, 'memory.sqlite');
  let source, reopened;
  try {
    source = new SqliteStorage(path, { synchronous: 'NORMAL' });
    source.metaSet('import:1', { value: 'source' });
    assert.throws(
      () =>
        source.transaction(() => {
          source.metaSet('import:2', 'uncommitted');
          throw new Error('abort');
        }),
      /abort/,
    );
    source.flush();
    reopened = new SqliteStorage(path);
    assert.deepEqual(reopened.metaGet('import:1'), { value: 'source' });
    assert.equal(reopened.metaGet('import:2'), undefined);
    assert.ok(reopened.metaGet('sqlite:durability-barrier'));
    assert.throws(() => new SqliteStorage(':memory:', { synchronous: 'OFF' }), /Invalid/);
  } finally {
    reopened?.close();
    source?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
