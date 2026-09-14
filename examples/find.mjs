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
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: '旅行には小さなカメラを持っていく。',
          links: [],
        },
        sources: [],
      },
    ],
  })
).changes.atom;
const found = await memory.search('コーヒー');
console.log(found.items.map((item) => item.text).join('\n'));
