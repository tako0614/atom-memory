# リリース

**atom-memory 0.2.1** を npm で公開しています。Node.js 22.13 以降の ESM プロジェクトで利用でき、TypeScript の型宣言を同梱しています。

```sh
npm install atom-memory
```

この版では、内容の検索、関係の探索、参照からの改訂、自動 read によるモデルへの記憶供給を使えます。保存先はプロセス内メモリと SQLite です。[はじめる](/guide)から試せます。

0.2.1では、所属変更後の再生成に現在のメンバーを取り込み、重なる逐語引用の本文を共有し、旧構成の保存が共有の子を経由して別の整理へ広がる問題を修正しました。5つのAPIは共通です。[変更と検証の記録](https://github.com/tako0614/atom-memory/blob/main/validation/corrections.md)を参照してください。

| 公開物                       | 参照先                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| npm パッケージ               | [atom-memory](https://www.npmjs.com/package/atom-memory)                           |
| ソースと配布 tarball         | [GitHub v0.2.1](https://github.com/tako0614/atom-memory/releases/tag/v0.2.1)       |
| パッケージ・ソースの照合情報 | [release.json](/release.json)                                                      |
| 実行した試験と環境           | [検証記録](https://github.com/tako0614/atom-memory/blob/main/validation/README.md) |

ドキュメントのサンプルは型検査・実行で確認します。ライブラリの受入試験、検索量・関係数・競合の測定、実モデルでの合成資料の比較は [検証ページ](/acceptance)にまとめています。既存アプリの更新は [移行](/migration)を参照してください。

## メンテナー向けの公開手順

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run evaluate
npm pack
```

生成した tarball を空のプロジェクトへインストールし、公開 export、型、SQLite、自動 read を確認します。同じ tarball を npm へ公開し、registry から再インストールして照合します。

サイトはリポジトリの `wrangler.jsonc` を使います。`wrangler deploy --dry-run` で設定を確認し、`npm run docs:deploy` でビルドとデプロイを行います。公開 URL の本文と導線を読み戻して確認します。

npm の integrity、commit と tag、Wrangler の deployment は [公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release.json)に保存します。公開操作は通常の `check` には含めません。
