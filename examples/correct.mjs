import { memory } from './memory.mjs';
const first = await memory.write({
  changes: [
    {
      id: 'note',
      op: 'create',
      content: { text: 'コーヒーはブラックが好き。', links: [] },
      sources: [],
    },
  ],
});
const note = first.changes.note;
const edited = await memory.write({
  changes: [
    {
      id: 'note',
      op: 'revise',
      target: note.ref,
      content: { text: 'コーヒーはミルク入りが好き。', links: [] },
      sources: [],
    },
  ],
});
console.log((await memory.inspect(edited.changes.note.ref, { limit: 0 })).atom.text);
console.log((await memory.inspect(note.ref, { limit: 0 })).atom.text);
