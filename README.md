# Atom Memory

0.5.0では、Atom自身の本文を検索表現にし、役割・方向の重み付きグラフ伝播を別の層で適用します。Atomは再帰的・多重所属できる対等な形式ですが、すべての関係を別Atomへ reify する必要はありません。LLMによる重要度採点や常駐処理は不要です。[ランキング](https://atom-memory.takos.jp/ranking)・[0.5への移行](https://atom-memory.takos.jp/migration)を参照してください。

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

Your agent calls `read` before each model step and supplies the returned memory to its model. Atom stores and retrieves memory; it does not run the agent. Notes, descriptions and relationships share the same store. Keep data in memory while trying things out, then use SQLite to save it on disk.

## Organize a long history

Your application selects bounded periods, invokes its model and validates an edit plan. Multiple `draft.write` / `draft.revise` calls commit atomically in one `edit`. Use `basis: 'historical'` for organization tied to observed past sources. The application owns scheduling, checkpoints, model selection and cost limits.

`read` / `search` exclude stale generated content and return its references in `stale`. The application decides whether to queue another Writer pass. Reads never generate replacement prose. Immutable revisions, source provenance, scope authorization and dependency validation remain in the library.

After writes, `host.indexAtoms()` can prioritize new vectors and `host.updateIndex()` consumes the revision feed. A changed Atom is indexed from its own body; changing a linked target does not re-encode an unchanged parent. In 0.5, the default candidate provider is `HybridCandidateProvider` when an embedding is configured and `LexicalCandidateProvider` otherwise. `ExactCandidateProvider` remains an explicit finite-scan reference. SQLite supports scoped candidate retrieval followed by relationship expansion.

Index metadata is a disposable v3 projection. A host must drain every served policy scope before calling semantic retrieval ready; `pending: false` from one call or channel is not a corpus-wide readiness certificate. Approximate diagnostics never certify corpus completeness.

See [long-history writing](https://atom-memory.takos.jp/history) and run `npm run example:history` for a deterministic, executable example that updates one topic across two periods.

## Try it

- [Hello, Memory](https://atom-memory.takos.jp/guide) — your first saved memory.
- [Short examples](https://atom-memory.takos.jp/examples) — search, corrections and conditions.
- [Connect an agent](https://atom-memory.takos.jp/runtime) — per-step recall and explicit Writer edits.
- [API reference](https://atom-memory.takos.jp/api) — methods, options and return values.

To run the examples from this repository:

```sh
npm ci
npm run build
node examples/hello.mjs
```

Run `npm run check` for the test suite and executable documentation checks. [Verification records](https://github.com/tako0614/atom-memory/blob/main/validation/README.md), [storage configuration](https://atom-memory.takos.jp/adapters), and [migration](https://atom-memory.takos.jp/migration) are available separately.

ESM · TypeScript declarations · No runtime dependencies · MIT
