import { memory } from './memory.mjs';

await memory.write('コーヒーはブラックが好き。');

const recalled = await memory.read({
  context: 'コーヒーの好みに合わせて提案したい。',
});

console.log(recalled.items[0]?.text);
