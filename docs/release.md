# リリースと公開手順

## v0.1.0

`atom_memory_final_v1.zip` の最終設計 v1.0 に基づく初回ライブラリ実装です。仕様原本は `spec/` に保存しています。

- npm: [atom-memory](https://www.npmjs.com/package/atom-memory)
- リポジトリ: [tako0614/atom-memory](https://github.com/tako0614/atom-memory)
- ドキュメント: [atom-memory.takos.jp](https://atom-memory.takos.jp)

## 実装と評価の境界

不変 Atom、独立 membership、CAS / 冪等 write、固定 include DAG、出典検証、現在の権限、snapshot / 継続、範囲依存、共有予算、overlay / 共通ハーネス、ローカル永続化を実装しています。

同梱の検索は語彙入口と有限候補内のベクトル比較です。実 LLM、tokenizer、埋め込みサービスはホストが接続します。分散合意、分散 ANN、ネットワーク分断耐性、研究上の新規性・意味品質・スループットの実証は今後の範囲です。ローカル版はこれらを保証したとは表示しません。

## 開発と検証

```sh
npm ci
npm run check
npm run example
npm pack --dry-run
```

ドキュメントは VitePress で静的生成します。開発ツールにのみ依存パッケージがあり、公開ライブラリの runtime dependencies は 0 です。VitePress は v2 alpha を固定した lockfile で使用しています。

Wrangler の依存する `sharp` は修正版 `0.35.4` へ override しています。上流の miniflare が修正版へ追随したら override を削除してください。

## npm へ公開

リリース対象の commit で検証後、認証した npm アカウントから公開します。

```sh
npm publish --access public
```

公開後は空のプロジェクトへ registry からインストールし、root import と `atom-memory/sqlite` の read / write を確認します。npm の同じ版は上書きせず、変更は次の版として公開します。

## ドキュメントを公開

```sh
npx wrangler whoami
npm run docs:deploy
```

`wrangler.jsonc` が `atom-memory-docs` とカスタムドメインを所有します。VitePress の生成先は `docs/.vitepress/dist`。Cloudflare Workers Static Assets が配信します。

GitHub Actions は Node.js の対応バージョンでライブラリとドキュメントを検証します。認証を伴う npm / Cloudflare の再公開は上の明示的なコマンドで行えます。
