import { memory } from './memory.mjs';
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: '招待リンクの有効期限は24時間です。',
          links: [],
        },
        sources: [],
      },
    ],
  })
).changes.atom;
const found = await memory.search('招待リンク');
console.log(found.items.map((item) => item.text));
const recalled = await memory.read({ context: '招待リンクはいつまで使える？' });
console.log(recalled.text);
