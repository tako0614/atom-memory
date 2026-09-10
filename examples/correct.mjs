import { memory } from './memory.mjs';

const note = await memory.write('コーヒーはブラックが好き。');
const edited = await memory.edit((draft) => draft.revise(note.ref, 'コーヒーはミルク入りが好き。'));

console.log((await memory.inspect(edited.value.ref)).atom.text);
console.log((await memory.inspect(note.ref)).atom.text);
