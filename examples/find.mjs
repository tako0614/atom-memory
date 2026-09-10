import { memory } from './memory.mjs';

await memory.write('コーヒーはブラックが好き。');
await memory.write('旅行には小さなカメラを持っていく。');

const found = await memory.search('コーヒー');
console.log(found.items.map((item) => item.text).join('\n'));
