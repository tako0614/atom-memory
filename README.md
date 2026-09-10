# Atom Memory

Give your agent something to remember.

Atom Memory is a TypeScript library for saving notes, finding relevant information, and bringing it back into an agent's context. Start with a sentence. Connect related notes. Update them when things change.

```sh
npm install atom-memory
```

## Hello, Memory

```ts runnable
import { memory } from './memory.mjs';

await memory.write('I like my coffee black.');

const recalled = await memory.read({ context: 'Suggest a coffee I would enjoy.' });
console.log(recalled.items[0]?.text);
// I like my coffee black.
```

The [quickstart](https://atom-memory.takos.jp/guide) includes both this application code and the `memory.mjs` setup file. It runs locally with Node.js 22.13+. No model or API key is needed for this first example.

## A few operations. Plenty to build.

| You want to…                       | Use              |
| ---------------------------------- | ---------------- |
| Remember a note                    | `write(content)` |
| Find relevant notes                | `search(query)`  |
| Check a note and its sources       | `inspect(ref)`   |
| Select memory for the current task | `read(state)`    |
| Correct or organize notes          | `edit(callback)` |

Use `MemoryHarness` to select a fresh memory block before each model call. Notes, descriptions and relationships share the same store. Keep data in memory while trying things out, then use SQLite to save it on disk.

## Try it

- [Hello, Memory](https://atom-memory.takos.jp/guide) — your first saved memory.
- [Short examples](https://atom-memory.takos.jp/examples) — search, corrections and conditions.
- [Connect an agent](https://atom-memory.takos.jp/runtime) — automatic recall and a working llama.cpp adapter.
- [API reference](https://atom-memory.takos.jp/api) — methods, options and return values.

To run the examples from this repository:

```sh
npm ci
npm run build
node examples/hello.mjs
```

Run `npm run check` for the test suite and executable documentation checks. [Verification records](validation/README.md), [storage configuration](https://atom-memory.takos.jp/adapters), and [migration](https://atom-memory.takos.jp/migration) are available separately.

ESM · TypeScript declarations · No runtime dependencies · MIT
