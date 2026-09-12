# リリース

このドキュメントは **atom-memory 0.5.0** に対応します。Atom自身の本文だけを使う表現v3、語彙・ベクトル索引を使う既定の候補取得、stale候補の除外を含みます。既存データの移行ではscopeごとの索引準備が必要です。

npmのバージョン・integrity・対応commitは[公開manifest](/release.json)、公開後の読戻し結果は[0.5.0の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.0.json)で確認できます。0.4.0の公開記録は `validation/release.json` に保持します。ライブラリとDocsの公開は、利用アプリの本番更新を含みません。

0.5ではAtomを保存・改訂・関係・検索のライブラリに絞りました。モデル実行、読取中のLLM再生成、後継採用と履歴の運用APIはアプリ側へ移します。破壊的変更は[移行](/migration)を参照してください。

## 公開前の検証

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run example:history
npm run format:check
ATOM_V04_PACKAGE=/path/to/published-0.4.0-package node scripts/check-v04-migration.mjs
npm pack
```

作ったtarballを空のプロジェクトへインストールし、公開export・型・SQLite・古い記憶の通知と明示改訂を確認します。npm公開とサイトのデプロイは通常のcheckに含めません。

新しい公開物のcommit・tag・integrity・サイトの状態を確認してから、公開記録を更新します。過去の検証記録を新しい版の実績として上書きしません。

## 0.5の公開判定

公開前には、owned docsのformatと実行可能例、型・SQLite・stale除外・明示Writer改訂、v3索引移行のfocused testsを確認します。索引の意味検索準備は、提供する全policy scopeをそれぞれのcurrent-head走査または変更フィードの終端までdrainし、各scopeの永続checkpointを確認してから判定します。一つの呼出しやchannelの `pending: false`、`complete`、`approximate` は全体のreadinessを証明しません。

実モデルの品質、paid-model gain、公開npm/siteの状態は、ローカル検証やこの文書から推測しません。検証途中の件数・外部結果は、実測記録が追加されるまで未確定として扱います。
