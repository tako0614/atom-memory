# リリース

このドキュメントは **atom-memory 0.5.1** に対応します。0.5.0の公開API・保存形式・本文だけの検索表現v3を維持し、結果のパッキングと内部の入力記録を整理した更新です。0.5.0から新しいデータ・索引移行は不要です。0.4以前からの更新は[移行](/migration)を参照してください。

npmのバージョン・integrity・対応commitは[公開manifest](/release.json)、公開後の読戻し結果は[0.5.1の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.1.json)で確認できます。[0.5.0の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.0.json)と、それ以前の記録も保持します。ライブラリとDocsの公開は、利用アプリの本番更新を含みません。

## 0.5.1の変更

- 結果のパッキングを内部で段階的に評価できる形へ整理しました。通常のreadは従来の順位と予算・必須条件・出典の規則を維持します。
- 確定出力の入力記録の重複保存と、出力のないeditが作る未使用の永続記録を除きました。観測版・鮮度・認可・削除依存は維持します。
- 未使用の内部型・設定を整理しました。EmbeddingProviderのパッケージ直下からの型importは継続します。
- [設計レビュー](/design-review)と[合成評価の検証](/composition)を追加しました。既知の限界と、通常の検索へ採用していない研究結果を示します。

目指す設計は、**活性の与え方をカスタマイズできる、合成可能な記憶の読み出しライブラリ**です。設定は初期活性の作り方を変え、その先は同じAtom構造の伝播と本文・関係・出典の返却規則にそろえます。

ただし、**受理された利用イベントの集計・時間減衰・初期活性への接続は、0.5.1には未実装です。** 合成評価器も研究用であり、既定検索へ採用していません。モデル実行・Writer・履歴運用は引き続きアプリ側です。

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

## 公開判定

公開前には、owned docsのformatと実行可能例、型・SQLite・stale除外・明示Writer改訂、v3索引移行のfocused testsを確認します。索引の意味検索準備は、提供する全policy scopeをそれぞれのcurrent-head走査または変更フィードの終端までdrainし、各scopeの永続checkpointを確認してから判定します。一つの呼出しやchannelの `pending: false`、`complete`、`approximate` は全体のreadinessを証明しません。

実モデルの品質、paid-model gain、公開npm/siteの状態は、ローカル検証やこの文書から推測しません。検証途中の件数・外部結果は、実測記録が追加されるまで未確定として扱います。
