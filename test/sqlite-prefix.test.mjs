import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../dist/adapters/sqlite.js';
import { fixture } from './fixtures.mjs';

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

test('transient cleanup does not load durable write traces', () => {
  const storage=new SqliteStorage(':memory:');
  try {
    const {host}=fixture({storage});
    for(let i=0;i<200;i++){
      storage.metaSet(`sdk:trace:durable-${i}`,{id:`durable-${i}`,createdAt:0,large:'x'.repeat(10000)});
      storage.metaSet(`receipt:durable-${i}`,{receipt:{receiptId:`durable-${i}`},reads:[]});
    }
    storage.metaSet('sdk:trace:expired',{id:'expired',createdAt:0});
    storage.metaSet('sdk:trace:recent',{id:'recent',createdAt:Date.now()});
    const entries=storage.metaEntries.bind(storage);
    storage.metaEntries=(prefix)=>{assert.notEqual(prefix,'sdk:trace:','retention must filter durable keys before loading bodies');return entries(prefix);};
    host.engine.trimTransientMetadata();
    assert.equal(storage.metaGet('sdk:trace:expired'),undefined);
    assert.ok(storage.metaGet('sdk:trace:recent'));
    assert.equal(entries('sdk:trace:durable-').length,200);
  } finally {storage.close();}
});
