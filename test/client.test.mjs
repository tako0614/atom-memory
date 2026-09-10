import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, LocalAuthority, MemoryStorage } from '../dist/index.js';
import { fixture } from './fixtures.mjs';

const error = (code) => (e) => e.code === code;
test('A01/A02 ordinary five-method flow and independent repeated content', async () => {
  const { memory: m } = fixture();
  const a = await m.write('旧クライアントは旧APIを利用している');
  const b = await m.write(a.text);
  assert.notEqual(a.ref, b.ref);
  const p = await m.write('旧クライアントの認証に関する情報');
  await m.write({
    text: 'このまとまりに、この情報が含まれる',
    links: { group: p.ref, member: a.ref },
  });
  const found = await m.search('旧クライアントの認証');
  assert.ok(found.items.length);
  const detail = await m.inspect(p.ref);
  assert.ok(detail.items.length >= 2);
  const recalled = await m.read({ context: '旧クライアントの認証' }, { tokens: 12000 });
  assert.ok(recalled.text.includes('旧API'));
  const edit = await m.edit(async (d) => {
    const x = await d.write('編集の中だけの資料');
    assert.ok((await d.search('編集の中だけ')).items.some((i) => i.ref === x.ref));
    return x;
  });
  assert.equal((await m.inspect(edit.value.ref)).atom.text, '編集の中だけの資料');
});
test('A03/A04 idempotent resend and observed-ref CAS', async () => {
  const { memory: m } = fixture();
  const a = await m.write('first', { idempotencyKey: 'event-1' });
  const again = await m.write('first', { idempotencyKey: 'event-1' });
  assert.equal(a.ref, again.ref);
  assert.ok(again.repeated);
  await assert.rejects(
    m.write('different', { idempotencyKey: 'event-1' }),
    error('IDEMPOTENCY_CONFLICT'),
  );
  const result = await m.edit((d) => d.revise(a.ref, 'second'));
  assert.equal((await m.inspect(a.ref)).atom.text, 'first');
  assert.equal((await m.inspect(a.ref, { version: 'latest' })).atom.text, 'second');
  await assert.rejects(
    m.edit((d) => d.revise(a.ref, 'lost update')),
    error('REVISION_CONFLICT'),
  );
  assert.equal((await m.inspect(result.value.ref)).atom.text, 'second');
});
test('A21/A22 draft abort is private and callback runs once', async () => {
  const { memory: m } = fixture();
  let ref;
  let calls = 0;
  await assert.rejects(
    m.edit(async (d) => {
      calls++;
      ref = (await d.write('secret draft')).ref;
      assert.equal((await m.search('secret draft')).items.length, 0);
      throw Error('abort');
    }),
  );
  assert.equal(calls, 1);
  await assert.rejects(m.write({ text: 'escape', links: { input: ref } }), error('INVALID_REF'));
});
