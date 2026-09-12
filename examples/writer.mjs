import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
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
  const writer = host.connect({
    ...binding,
    actor: { type: 'agent', generatedOrigin: 'organization' },
  });
  const source = await memory.write('旧クライアントで認証を利用できる。');
  const organize = (ref, previous) =>
    writer.edit(async (draft) => {
      const observed = (await draft.inspect(ref, { version: 'latest', depth: 0 })).atom;
      const text = await generate(observed.text);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid model output');
      /** @type {import('atom-memory').MemoryContent} */
      const content = {
        text,
        links: { 根拠: { ref: observed.ref, at: 'observed', required: true } },
      };
      const options = { sources: [{ ref: observed.ref }] };
      return previous ? draft.revise(previous, content, options) : draft.write(content, options);
    });
  const created = await organize(source.ref);
  const options = { tokens: 10000, depth: 2 };
  const first = await memory.read({ query: '認証' }, options);
  const correction = await memory.edit((draft) =>
    draft.revise(source.ref, '旧クライアントで認証を利用できない。'),
  );
  const pending = await memory.read({ query: '認証' }, options);
  assert.ok(pending.stale.includes(created.value.ref));
  // The host chooses to refresh now. Production agents can enqueue this instead.
  await organize(correction.value.ref, created.value.ref);
  const reread = await memory.read({ query: '認証' }, options);
  assert.match(reread.text, /利用できない/);
  assert.deepEqual(reread.stale, []);
  const observed = await memory.inspect(source.ref, { depth: 0 });
  return { source, first, pending, reread, observed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await writerScenario();
  console.log(`古い整理を通知: ${result.pending.stale.length}`);
  console.log(`Writer改訂後の未更新: ${result.reread.stale.length}`);
  console.log(`観測済み原文: ${result.observed.atom.text}`);
}
