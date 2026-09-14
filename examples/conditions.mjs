import { memory } from './memory.mjs';
const condition = (
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: '招待には管理者の承認が必要です。',
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
        content: {
          text: '外部のメンバーを招待できます。',
          links: { 条件: { ref: condition.ref, required: true } },
        },
        sources: [],
      },
    ],
  })
).changes.atom;
const recalled = await memory.read({ context: '外部のメンバーを招待したい。' });
console.log(
  recalled.items
    .map((item) => item.text)
    .sort()
    .join('\n'),
);
