# Atom Memory

0.4.0: query/context/thoughtの類似度と、役割・方向の重み付きグラフ伝播で検索順位を決めます。Atomは再帰的・多重所属できる対等な形式です。LLMによる重要度採点や常駐処理は不要です。[ランキング](https://atom-memory.takos.jp/ranking)・[0.3からの移行](https://atom-memory.takos.jp/migration)を参照してください。

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

## Organize a long history

Feed bounded periods to `MemoryHarness` and let the model search, inspect and revise existing memory. A `batch` action creates or revises multiple linked Atoms in one model response, with an atomic commit. Use `basis: 'historical'` for past-source organization. The application owns scheduling, checkpoints, model selection and cost limits.

After writes, `host.indexAtoms()` prioritizes new vectors and `host.updateIndex()` incrementally indexes changes and direct dependents. SQLite supports scoped hybrid vector and lexical retrieval followed by relationship expansion.

See [long-history writing](https://atom-memory.takos.jp/history) and run `npm run example:history` for a deterministic, executable example that updates one topic across two periods.

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
