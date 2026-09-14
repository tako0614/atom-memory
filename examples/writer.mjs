import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryHost, LocalAuthority } from 'atom-memory';

// This is application code. Inject a real model here; Atom does not define its
// protocol, choose it or decide when another generation should run.
export async function writerScenario(generate = async (source) => `認証の整理: ${source}`) {
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'example',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const host = new MemoryHost({ authority });
  const binding = { auth, writePolicy: 'p' };
  const memory = host.connect({ ...binding, actor: { type: 'input-adapter' } });
  /** @type {import('atom-memory').ClientBinding} */
  const agentBinding = { ...binding, actor: { type: 'agent', generatedOrigin: 'organization' } };
  const writer = host.connect(agentBinding);
  const source = (
    await memory.write({
      changes: [
        {
          id: 'source',
          op: 'create',
          content: { text: '旧クライアントで認証を利用できる。', links: [] },
          sources: [],
        },
      ],
    })
  ).changes.source;
  const organize = async (ref, previous) => {
    const inspection = await writer.inspect(ref, { version: 'latest', limit: 0 });
    const observed = inspection.atom;
    const input = host.observe(
      {
        presentations: [{ receipt: inspection.receipt, refs: [observed.ref] }],
        payloadDigest: createHash('sha256').update(observed.text).digest('hex'),
      },
      agentBinding,
    );
    const text = await generate(observed.text);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid model output');
    const eventId = randomUUID(); // Persist this ID with a request if its ack may be retried.
    host.recordUse([observed.ref], agentBinding, { eventId, input });
    /** @type {import('atom-memory').MemoryContent} */
    const content = {
      text,
      links: { 根拠: { ref: observed.ref, at: 'observed', required: true } },
    };
    return writer.write({
      changes: [
        {
          id: 'organization',
          ...(previous ? { op: 'revise', target: previous } : { op: 'create' }),
          content,
          input,
          sources: [{ ref: observed.ref }],
        },
      ],
    });
  };
  const created = await organize(source.ref);
  const options = { tokens: 10000, depth: 2 };
  const first = await memory.read({ query: '認証' }, options);
  const correction = await memory.write({
    changes: [
      {
        id: 'source',
        op: 'revise',
        target: source.ref,
        content: { text: '旧クライアントで認証を利用できない。', links: [] },
        sources: [],
      },
    ],
  });
  const pending = await memory.read({ query: '認証' }, options);
  assert.ok(pending.stale.includes(created.changes.organization.ref));
  // The host chooses to refresh now. Production agents can enqueue this instead.
  await organize(correction.changes.source.ref, created.changes.organization.ref);
  const reread = await memory.read({ query: '認証' }, options);
  assert.match(reread.text, /利用できない/);
  assert.deepEqual(reread.stale, []);
  const observed = await memory.inspect(source.ref, { limit: 0 });
  return { source, first, pending, reread, observed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await writerScenario();
  console.log(`古い整理を通知: ${result.pending.stale.length}`);
  console.log(`Writer改訂後の未更新: ${result.reread.stale.length}`);
  console.log(`観測済み原文: ${result.observed.atom.text}`);
}
