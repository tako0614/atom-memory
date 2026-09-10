import { MemoryHost, LocalAuthority } from 'atom-memory';

// Host setup: authorization and source identity are bound once.
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example-host',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
const memory = host.connect({ auth, writePolicy: 'notes', actor: { type: 'human' } });

const fact = await memory.write('旧クライアントは旧APIを利用している');
const group = await memory.write('旧クライアントの認証に関する情報');
await memory.write({
  text: 'このまとまりに、この情報が含まれる',
  links: { group: group.ref, member: fact.ref },
});
const page = await memory.search('旧クライアントの認証', { limit: 10 });
if (page.items[0])
  console.log((await memory.inspect(page.items[0].ref, { depth: 1, limit: 20 })).atom.text);
const recalled = await memory.read({ context: '旧クライアントの認証' }, { tokens: 4096 });
console.log(recalled.text);
const edited = await memory.edit((draft) =>
  draft.revise(fact.ref, '訂正：旧クライアントは新APIへ移行する'),
);
console.log((await memory.inspect(edited.value.ref)).atom.text);
console.log((await memory.inspect(fact.ref)).atom.text); // Observed old revision.
