# リリース

**atom-memory 0.6.0をnpmへ公開しました。** v0.5の本文・版・出典・receipt・v3ベクトルと保存データを維持し、宣言的な `activation` / `retrieval`、利用ack、単一の線形評価器へ更新しています。設定と候補providerには破壊的変更があります。移行手順は[移行](/migration)を参照してください。

npmのバージョン・integrity・対応commitは[公開manifest](/release.json)、サイトのデプロイと読戻しは[0.6.0の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.6.0.json)で確認できます。[0.5.1](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.1.json)・[0.5.0](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.0.json)と、それ以前の記録も保持します。ライブラリとDocsの公開は、利用アプリの本番更新を含みません。

## v0.6で受け入れる変更

- `HostOptions.activation`（既定は半減期7日、最大増幅0.3、伝播0.5）と `HostOptions.retrieval` を追加しました。候補providerは `PinnedRef[]` だけを返し、Coreが保存本文を再読して評価します。
- `host.recordUse(refs, binding, { eventId })` と `host.resetUse(binding)` を追加しました。成功したモデル応答後のackだけが主体・policy・revisionごとの利用集計を更新し、read/searchだけでは増えません。
- 評価器は `a = D(h)m + Tᵀa` の一つに固定し、`maxEvaluationWork` で数値計算を制限します。Schur合成と凍結した参照実装は研究資料に残します。
- v3保存・索引、freshness、認可、削除依存は維持します。半減期変更は `STATE_INVALIDATED` として明示的なresetを要求し、`maxBoost`変更だけではリセットしません。

モデル実行・Writer・履歴運用は引き続きアプリ側です。アプリがモデルへ返したrefsを成功として受理した後、ホストが利用ackを発行します。利用イベントをモデルのツールや人の承認に待たせません。

## 0.6.0の検証

134件のテスト、16件の研究用テスト、16件の実行可能なドキュメント例と7件の出力照合が合格しました。Node 22・24のCI、梱包したtarballと空のキャッシュからのnpmインストールで、ESM・型・SQLite・利用の隔離と重複抑止を確認しています。

公開済み0.5.1の保存データからの移行試験では、3件の版と観測refを維持し、3件のv3ベクトルを再エンコード・フィード再生なしで再利用しました。古いcursorは失効します。数値誤差の保証は取得済みの固定グラフに対するもので、全資料の検索完全性や実モデルの意味品質を保証しません。

再検証には次を使います。

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
