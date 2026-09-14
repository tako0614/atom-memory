import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, LocalAuthority, MemoryStorage } from '../dist/index.js';
import { fixture, create, revise, retire } from './fixtures.mjs';

const error = (code) => (e) => e.code === code;
test('A01/A02 declarative flow and independent repeated content', async () => {
  const { memory: m } = fixture();
  const a = await create(m, '旧クライアントは旧APIを利用している');
  const b = await create(m, a.text);
  assert.notEqual(a.ref, b.ref);
  const p = await create(m, '旧クライアントの認証に関する情報');
  await create(m, {
    text: 'このまとまりに、この情報が含まれる',
    links: { group: p.ref, member: a.ref },
  });
  const found = await m.search('旧クライアントの認証');
  assert.ok(found.items.length);
  const detail = await m.inspect(p.ref);
  assert.ok(detail.neighbors.length >= 1);
  const recalled = await m.read({ context: '旧クライアントの認証' }, { tokens: 12000 });
  assert.ok(recalled.text.includes('旧API'));
  const edit = await m.write({
    changes: [
      {
        id: 'inside',
        op: 'create',
        content: { text: '編集の中だけの資料', links: [] },
        sources: [],
      },
    ],
  });
  const x = edit.changes.inside;
  assert.ok((await m.search('編集の中だけ')).items.some((i) => i.ref === x.ref));
  assert.equal((await m.inspect(x.ref)).atom.text, '編集の中だけの資料');
});
test('A03/A04 idempotent resend and observed-ref CAS', async () => {
  const { memory: m } = fixture();
  const a = await create(m, 'first', { idempotencyKey: 'event-1' });
  const again = await create(m, 'first', { idempotencyKey: 'event-1' });
  assert.equal(a.ref, again.ref);
  assert.ok(again.repeated);
  await assert.rejects(
    create(m, 'different', { idempotencyKey: 'event-1' }),
    error('IDEMPOTENCY_CONFLICT'),
  );
  const result = await revise(m, a.ref, 'second');
  assert.equal((await m.inspect(a.ref)).atom.text, 'first');
  assert.equal((await m.inspect(a.ref, { version: 'latest' })).atom.text, 'second');
  await assert.rejects(revise(m, a.ref, 'lost update'), error('REVISION_CONFLICT'));
  assert.equal((await m.inspect(result.value.ref)).atom.text, 'second');
});
test('A21/A22 rejected declarative batch exposes no tentative changes', async () => {
  const { memory: m } = fixture();
  await assert.rejects(
    m.write({
      changes: [
        {
          id: 'secret',
          op: 'create',
          content: { text: 'secret draft', links: { broken: { local: 'missing' } } },
          sources: [],
        },
      ],
    }),
    error('INVALID_REF'),
  );
  assert.equal((await m.search('secret draft')).items.length, 0);
});
