# Atom Memory

A TypeScript library that gives agents relevant memory for each model call. Store notes and their relationships, retrieve the evidence a task needs, and keep track of where it came from—even after a correction.

`MemoryHarness` selects a fresh memory block before each model call. An agent can also search for more information, inspect a particular source, or propose edits. All of these operations use the same Atom store.

```sh
npm install atom-memory
```

Node.js 22.13+, ESM, TypeScript declarations, no runtime dependencies. Use the in-process store to get started or SQLite to keep data on disk.

## Save and recall

Once the host has [configured a client](https://atom-memory.takos.jp/setup), application code is short:

```ts
await memory.write('Invitation links expire after 24 hours.');

const found = await memory.search('Invitation links');
console.log(found.items.map((item) => item.text));

const recalled = await memory.read({ context: 'When do invitation links expire?' });
// Pass recalled.text to your model as reference material.
```

`search` returns candidates to inspect. `read` selects relevant material within a token budget for the model's current task. The [runnable example](examples/basic.mjs) imports its client from a separate [host setup file](examples/memory.mjs).

## Connect information

A note, a topic description, and a relationship are all Atoms. Describe a connection in text and attach references with the roles that make sense for your data:

```ts
const rule = await memory.write('Invitation links expire after 24 hours.');
const topic = await memory.write('Invitation and onboarding procedures');
await memory.write({
  text: 'The invitation procedure includes the link expiry rule.',
  links: { topic: topic.ref, rule: rule.ref },
});
```

Search discovers content. Relation traversal finds connected information in either direction and preserves the roles. You can add another connection without rewriting the topic or copying its notes.

| When you want to…                                 | Use                        |
| ------------------------------------------------- | -------------------------- |
| Give a model relevant memory for its current task | `read(state, { tokens })`  |
| Find candidate notes and relationships            | `search(query, { limit })` |
| Examine a returned Atom, its source and neighbors | `inspect(ref, { depth })`  |
| Save a note or relationship                       | `write(content)`           |
| Revise or organize several Atoms together         | `edit(callback)`           |

## Learn and run

- [Getting started](https://atom-memory.takos.jp/guide): save, connect, search and correct a note.
- [API reference](https://atom-memory.takos.jp/api): examples, options, returned values and errors.
- [Agents and Writer](https://atom-memory.takos.jp/runtime): automatic recall and a runnable llama.cpp connection.
- [Storage and search](https://atom-memory.takos.jp/adapters): SQLite, embeddings and resource limits.
- [Migration](https://atom-memory.takos.jp/migration) for existing installations; [verification](https://atom-memory.takos.jp/acceptance) for test and model-evaluation results.

To run the repository examples:

```sh
npm ci
npm run check
npm run example
npm run example:writer
```

The basic and Writer examples run locally with deterministic behavior. `npm run example:live` connects to a configured llama.cpp server; setup is in the [agent guide](https://atom-memory.takos.jp/runtime#ローカルモデルで動かす).

MIT License.
