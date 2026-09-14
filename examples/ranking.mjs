import { adaptiveUse, LocalAuthority, MemoryHost, MemoryStorage } from '../dist/index.js';
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
  activation: {
    model: adaptiveUse(),
    relations: { condition: { forward: 2, reverse: 0 } },
  },
});
const memory = host.connect({ auth, writePolicy: 'notes', actor: { type: 'human' } });
const condition = (
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: '管理者の署名を受けてから実施する。',
          links: [],
        },
        sources: [],
      },
    ],
  })
).changes.atom;
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: { text: '移行の手順', links: { condition: condition.ref } },
        sources: [],
      },
    ],
  })
).changes.atom;
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: { text: '移行の決定', links: { condition: condition.ref } },
        sources: [],
      },
    ],
  })
).changes.atom;
const found = await memory.search('移行');
const related = found.items.find((item) => item.ref === condition.ref);
console.log('本文が一致しない条件も取得:', Boolean(related));
console.log('関係を通じて取得:', Boolean(related?.score));
storage.close();
