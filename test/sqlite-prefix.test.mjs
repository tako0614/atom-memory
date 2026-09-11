import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../dist/adapters/sqlite.js';

test('metadata prefix scans preserve literal and supplementary Unicode keys', () => {
  const storage = new SqliteStorage(':memory:');
  try {
    const keys = ['sdk:cache:a', 'sdk:cache:b', 'sdk:index:a', '😀:a', '😀:b', '😁:a',
      'a[*%_:one', 'a[*%_:two', 'aOTHER:one', '\u{10ffff}', '\u{10ffff}:a'];
    for (const key of keys) storage.metaSet(key, { key });
    for (const prefix of ['sdk:cache:', '😀:', 'a[*%_', '\u{10ffff}', 'missing:', '']) {
      assert.deepEqual(storage.metaEntries(prefix).map(([key]) => key).sort(), keys.filter((key) => key.startsWith(prefix)).sort());
    }
  } finally { storage.close(); }
});
