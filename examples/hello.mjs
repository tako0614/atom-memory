import { memory } from './memory.mjs';
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: 'コーヒーはブラックが好き。',
          links: [],
        },
        sources: [],
      },
    ],
  })
).changes.atom;
const recalled = await memory.read({
  context: 'コーヒーの好みに合わせて提案したい。',
});
console.log(recalled.items[0]?.text);
