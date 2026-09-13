# Atom Memory

> 内容と関係を版付きで保存し、文脈と受理された利用から一つの規則で活性を計算し、必要な条件を欠かさない本文集合を予算内で返す。

v0.8は、単一Atomと五つの通常API、v0.7の活性式・AvailabilityModel・own-body embeddingを維持します。取得、表示、生成入力、現在性watch、成功ackを版付きmanifestで区別し、ホストが確認した独立生成を同じeditで保存できます。readはrequired閉包と共有引用の表示費用を使い、同じ活性による有界な集合選択を行います。

通常linksと生成依存は別契約です。旧データと入力未観測のagent editには従来の保守的な消去依存を残します。モデル呼出し、Writer、費用、ジョブ、後継採用はアプリが所有します。選択用の代理目的Uは正答率や新規性の証明ではありません。

意味の正本は [規範仕様](docs/specification.md)、変更手順は [移行](docs/migration.md)、実行結果は [v0.8検証記録](validation/v0.8.0.md) です。npm公開・サイト更新の記録とは区別しています。

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

After writes, `host.indexAtoms()` can prioritize new vectors and `host.updateIndex()` consumes the revision feed. A changed Atom is indexed from its own body; changing a linked target does not re-encode an unchanged parent. Candidate providers return `PinnedRef` values only; the core rereads authoritative stored revisions and computes the score and graph propagation. Retrieval bounds live under `retrieval` (including `maxScan`), while `activation` selects a scoped availability model and controls propagation. SQLite supports scoped candidate retrieval followed by relationship expansion.

The public `AvailabilityModel<S extends Json>` has only `id`, synchronous `update(previous, acceptedAt)` and synchronous `value(state, now)`. The library owns scope, atomicity, event deduplication, purge and state serialization. Model state is canonical JSON of at most 1 KiB; callbacks do not receive query text, context, scores, graph structure or full event history. A bad state, non-finite value, thrown exception or Promise is an error, never a zero-score fallback.

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
