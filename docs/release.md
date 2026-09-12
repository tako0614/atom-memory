# リリース

**atom-memory 0.3.0** を npm で公開しています。Node.js 22.13 以降の ESM プロジェクトで利用でき、TypeScript の型宣言を同梱しています。

```sh
npm install atom-memory
```

この版では、内容の検索、関係の探索、参照からの改訂、自動 read によるモデルへの記憶供給を使えます。保存先はプロセス内メモリと SQLite です。[はじめる](/guide)から試せます。

0.3.0では、Writerの `batch` 操作と過去資料向けの `basis` 指定、増分索引更新の `updateIndex`、優先索引更新の `indexAtoms`、SQLiteのスコープ付きハイブリッド検索を追加しました。変更されたAtomと直接参照元を索引化し、コンテキスト・明示的なthoughtから関連情報と関係を取得できます。purge時には無関係なAtomの索引を保持します。[長期履歴のWriter](/history)と[保存・検索設定](/adapters)を参照してください。

アプリ側の5つの基本APIは共通です。常駐処理やモデル課金はライブラリに含みません。

| 公開物                       | 参照先                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| npm パッケージ               | [atom-memory](https://www.npmjs.com/package/atom-memory)                           |
| ソースと配布 tarball         | [GitHub v0.3.0](https://github.com/tako0614/atom-memory/releases/tag/v0.3.0)       |
| パッケージ・ソースの照合情報 | [release.json](/release.json)                                                      |
| 実行した試験と環境           | [検証記録](https://github.com/tako0614/atom-memory/blob/main/validation/README.md) |

ドキュメントのサンプルは型検査・実行で確認します。ライブラリの受入試験、検索量・関係数・競合の測定、実モデルでの合成資料の比較は [検証ページ](/acceptance)にまとめています。既存アプリの更新は [移行](/migration)を参照してください。

## メンテナー向けの公開手順

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run example:history
npm run evaluate
npm pack
```

生成した tarball を空のプロジェクトへインストールし、公開 export、型、SQLite、自動 read を確認します。同じ tarball を npm へ公開し、registry から再インストールして照合します。

サイトはリポジトリの `wrangler.jsonc` を使います。`wrangler deploy --dry-run` で設定を確認し、`npm run docs:deploy` でビルドとデプロイを行います。公開 URL の本文と導線を読み戻して確認します。

npm の integrity、commit と tag、Wrangler の deployment は [公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release.json)に保存します。公開操作は通常の `check` には含めません。
