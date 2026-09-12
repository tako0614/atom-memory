import { MemoryHost, LocalAuthority } from 'atom-memory';

// A host chooses bounded periods and invokes its model. This deterministic
// example demonstrates memory operations, not the quality of an AI Writer.
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'period-writer',
  readPolicies: ['community'],
  writePolicies: ['community'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
const binding = { auth, writePolicy: 'community' };
const input = host.connect({ ...binding, actor: { type: 'input-adapter' } });
const writer = host.connect({ ...binding, actor: { type: 'agent' } });
const periods = ['月曜: 招待期限は24時間という提案。', '木曜: 招待には管理者承認も必要。'];
let topic;
const sources = [];
for (const [index, text] of periods.entries()) {
  sources.push(await input.write(text, { idempotencyKey: `period:${index}` }));
  const result = await writer.edit(
    async (draft) => {
      for (const source of sources) await draft.inspect(source.ref, { depth: 0 });
      if (topic) await draft.inspect(topic.ref, { depth: 0 });
      // Replace this with the host's validated model response.
      /** @type {import('atom-memory').MemoryContent} */
      const content = {
        text: sources.map((source) => source.text).join('\n'),
        links: {
          根拠: sources.map((source) => ({ ref: source.ref, at: 'observed', required: true })),
        },
      };
      return topic
        ? draft.revise(topic.ref, content, {
            sources: sources.map((source) => ({ ref: source.ref })),
          })
        : draft.write(content, { sources: sources.map((source) => ({ ref: source.ref })) });
    },
    { basis: 'historical' },
  );
  topic = result.value;
  // With an embedding provider, call host.indexAtoms(result.changes.map(atom => atom.ref), writerBinding).
  // A durable application's checkpoint advances after its storage durability barrier.
}
console.log(`同じAtomを改訂した期間数: ${periods.length}`);
console.log(topic.text);
