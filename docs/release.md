# リリース

このドキュメントは **atom-memory 0.6 (upcoming)** の受入方針です。v0.5の本文・版・出典・receipt・v3ベクトルと保存データを維持し、宣言的な `activation` / `retrieval`、利用ack、単一の線形評価器を追加します。npm公開済みとは扱わず、公開版・integrity・対応commitは公開manifestが更新されるまで未確定です。移行手順は[移行](/migration)を参照してください。

npmの過去版のバージョン・integrity・対応commitは[公開manifest](/release.json)と[0.5.1の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.1.json)で確認できます。これらは v0.5 の履歴であり、v0.6の公開を示しません。[0.5.0の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.0.json)と、それ以前の記録も保持します。ライブラリとDocsの公開は、利用アプリの本番更新を含みません。

## v0.6で受け入れる変更

- `HostOptions.activation`（既定は半減期7日、最大増幅0.3、伝播0.5）と `HostOptions.retrieval` を追加しました。候補providerは `PinnedRef[]` だけを返し、Coreが保存本文を再読して評価します。
- `host.recordUse(refs, binding, { eventId })` と `host.resetUse(binding)` を追加しました。成功したモデル応答後のackだけが主体・policy・revisionごとの利用集計を更新し、read/searchだけでは増えません。
- 評価器は `a = D(h)m + Tᵀa` の一つに固定し、`maxEvaluationWork` で数値計算を制限します。Schur合成と凍結した参照実装は研究資料に残します。
- v3保存・索引、freshness、認可、削除依存は維持します。半減期変更は `STATE_INVALIDATED` として明示的なresetを要求し、`maxBoost`変更だけではリセットしません。

モデル実行・Writer・履歴運用は引き続きアプリ側です。アプリがモデルへ返したrefsを成功として受理した後、ホストが利用ackを発行します。利用イベントをモデルのツールや人の承認に待たせません。

## 公開前の検証

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run example:history
npm run format:check
ATOM_V05_PACKAGE=/path/to/published-0.5.1-package node scripts/check-v05-migration.mjs
npm pack
```

作ったtarballを空のプロジェクトへインストールし、公開export・型・SQLite・古い記憶の通知と明示改訂を確認します。npm公開とサイトのデプロイは通常のcheckに含めません。

新しい公開物のcommit・tag・integrity・サイトの状態を確認してから、公開記録を更新します。過去の検証記録を新しい版の実績として上書きしません。

## 公開判定

公開前には、owned docsのformatと実行可能例、型・SQLite・stale除外・明示Writer改訂、v3索引移行のfocused testsを確認します。索引の意味検索準備は、提供する全policy scopeをそれぞれのcurrent-head走査または変更フィードの終端までdrainし、各scopeの永続checkpointを確認してから判定します。一つの呼出しやchannelの `pending: false`、`complete`、`approximate` は全体のreadinessを証明しません。

実モデルの品質、paid-model gain、公開npm/siteの状態は、ローカル検証やこの文書から推測しません。検証途中の件数・外部結果は、実測記録が追加されるまで未確定として扱います。
