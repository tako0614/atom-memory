import { LocalAuthority, MemoryHost, MemoryStorage } from '../dist/index.js';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'demo',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const storage = new MemoryStorage();
const host = new MemoryHost({
  authority,
  storage,
  ranking: { relations: { condition: { forward: 2, reverse: 0 } } },
});
const memory = host.connect({ auth, writePolicy: 'notes', actor: { type: 'human' } });
const condition = await memory.write('管理者の署名を受けてから実施する。');
await memory.write({ text: '移行の手順', links: { condition: condition.ref } });
await memory.write({ text: '移行の決定', links: { condition: condition.ref } });
const found = await memory.search('移行');
const related = found.items.find((item) => item.ref === condition.ref);
console.log('本文が一致しない条件も取得:', Boolean(related));
console.log('構造からの寄与:', Boolean(related?.scoreBreakdown?.structural));
storage.close();
