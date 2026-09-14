import { createHash } from 'node:crypto';
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
/** @type {import('atom-memory').ClientBinding} */
const writerBinding = { ...binding, actor: { type: 'agent' } };
const writer = host.connect(writerBinding);
const periods = ['月曜: 招待期限は24時間という提案。', '木曜: 招待には管理者承認も必要。'];
let topic;
const sources = [];
for (const [index, text] of periods.entries()) {
  sources.push(
    (
      await input.write(
        { changes: [{ id: 'source', op: 'create', content: { text, links: [] }, sources: [] }] },
        { idempotencyKey: `period:${index}` },
      )
    ).changes.source,
  );
  const presentations = [];
  for (const source of sources) {
    const detail = await writer.inspect(source.ref, { limit: 0 });
    presentations.push({ receipt: detail.receipt });
  }
  const previous = topic ? await writer.inspect(topic.ref, { limit: 0 }) : null;
  if (previous) presentations.push({ receipt: previous.receipt });
  const payload = JSON.stringify({
    sources: sources.map((source) => source.text),
    previous: previous?.atom.text,
  });
  const token = host.observe(
    { presentations, payloadDigest: createHash('sha256').update(payload).digest('hex') },
    writerBinding,
  );
  // Replace this deterministic organization with the application's model output.
  /** @type {import('atom-memory').MemoryContent} */
  const content = {
    text: sources.map((source) => source.text).join('\n'),
    links: { 根拠: sources.map((source) => ({ ref: source.ref, at: 'observed', required: true })) },
  };
  const result = await writer.write(
    {
      changes: [
        {
          id: 'topic',
          ...(topic ? { op: 'revise', target: topic.ref } : { op: 'create' }),
          content,
          sources: sources.map((source) => ({ ref: source.ref })),
          input: token,
        },
      ],
    },
    { idempotencyKey: `organization:${index}` },
  );
  topic = result.changes.topic;
  // Host checkpoints advance only after its storage durability barrier.
}
console.log(`同じAtomを改訂した期間数: ${periods.length}`);
console.log(topic.text);
