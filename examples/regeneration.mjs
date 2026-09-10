import assert from 'node:assert/strict';
import { MemoryHost, LocalAuthority, utf8Tokenizer } from 'atom-memory';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
// A deterministic generator shows the actual acquisition inputs; this is not an LLM evaluation.
const inputs = [];
const host = new MemoryHost({
  authority,
  generator: {
    id: 'record-inputs-v1',
    tokenizer: utf8Tokenizer,
    maxOutputTokens: 1000,
    networkCallsPerCall: 0,
    async generate(input) {
      inputs.push(input);
      return '現在の資料を取得し直しました。';
    },
  },
});
const binding = { auth, writePolicy: 'notes' };
const memory = host.connect({ ...binding, actor: { type: 'human' } });
const writer = host.connect({ ...binding, actor: { type: 'agent' } });
const topic = await memory.write('招待の手順');
const composition = { relations: [{ parent: '手順', children: ['ルール'] }] };
async function addRule(text) {
  const rule = await memory.write(text);
  await memory.write({ text: '手順で使うルール', links: { 手順: topic.ref, ルール: rule.ref } });
}
await addRule('リンクは24時間で失効する。');
await writer.edit(async (draft) => {
  await draft.inspect(topic.ref, { composition, version: 'latest' });
  await draft.write('招待の要約');
});
await addRule('参加には管理者の承認が必要。');
const recalled = await memory.read({ query: '招待の要約' }, { tokens: 10000 });
assert.ok(
  inputs.some((input) => input.sources.some((s) => s.text === '参加には管理者の承認が必要。')),
);
assert.equal(recalled.diagnostics.derived, 'regenerated');
console.log('追加したルールが再生成の入力に入りました。');
