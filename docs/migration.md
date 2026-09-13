# v0.6への移行

v0.6は v0.5 からの公開契約の更新です。Atomの本文・ID・revision・出典・receipt・links、v3のown-bodyベクトルと保存データは保持します。認証・policyを含む既存の保存を消去して移行する必要はありません。cursorは評価設定に束縛されるため、版の更新時に失効させて取り直します。

## まず確認すること

バックアップを取り、旧版と新版のプロセスを同じ保存先へ同時に書き込まないでください。移行後は次を実行して、旧0.5設定・型・候補providerの差分を確認します。

```sh
ATOM_V05_PACKAGE=/path/to/published-0.5.1-package node scripts/check-v05-migration.mjs
```

このスクリプトは保存データを書き換えません。公開npmのmanifestや過去の検証記録は、このローカル移行結果から更新しません。

## 公開APIと設定の変更

| v0.5の利用                                     | v0.6での扱い                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `RankingOptions` / `ScoreBreakdown`            | 削除。`activation` と `retrieval` を宣言し、Coreの単一評価器が順位を計算する                             |
| `HostOptions.ranking` / トップレベル `maxScan` | 削除。候補・グラフ上限は `HostOptions.retrieval.maxScan` などへ移す                                      |
| providerが返す score・本文・関係重み           | 削除。`CandidateProvider` は `PinnedRef[]` だけを返し、Coreが保存本文を再読して採点する                  |
| 独自のscore callback・任意decay callback       | 削除。本文一致、利用活性、`Tᵀ` 伝播を `a = D(h)m + Tᵀa` で評価する                                       |
| 候補取得の設定                                 | `retrieval: { maxSeeds, maxNodes, maxEdges, maxScan, depth }` へ移す                                     |
| 利用イベントの外部補正                         | `host.recordUse(refs, binding, { eventId })` を成功したモデル応答後に呼ぶ。read/searchだけでは加算しない |

`recordUse` の戻り値は `{ acceptedAt, recorded, repeated }` です。利用状態は認証主体・policy・revisionごとに隔離され、同じ `eventId` の再送は一度だけ反映します。`host.resetUse(binding)` は現在の主体と許可policyの集計を消しますが、重複防止マーカーは残します。半減期を変更して `STATE_INVALIDATED` になった場合は、明示的に `resetUse` を呼んでから読み直してください。`maxBoost` の変更だけではリセットしません。

アプリのモデル実行ループは引き続きアプリが所有します。モデルproviderから成功応答を受けた経路が、モデルへ渡したrefsを自動でackします。モデルのツール呼び出しや人の承認を利用イベントとして待つAPIはありません。

## 保存・索引の扱い

v3の表現は各Atom自身の本文から作られ、既存の互換なベクトル行は保持できます。encoder、dimensions、policy、own-body hashが一致する行だけを再利用し、旧形式の混在やconfigだけの書き換えは行いません。既存のstorage adapterは本文、版、出典、入力記録、v3索引を同じ境界で扱います。

索引を使うhostは、提供する全policy scopeの `prepareIndex` / `updateIndex` を再開し、各scopeのcheckpointを終端までdrainしてから意味検索をreadyと扱います。一つの `pending: false` やproviderの `complete` は全体の準備完了を示しません。移行で設定世代が変わったcursorは `CURSOR_EXPIRED` として新しい検索から開始します。

`MemoryHarness`、モデル実行、再取得計画、一時生成cache、旧 `supersede` の自動採用は v0.5 から引き続きライブラリにありません。`stale` を受けたアプリが入力を選び直し、通常の `edit` で改訂します。`basis: 'historical'`、観測版、不変版、receipt、明示的な `retainSnapshot` / `retainedSnapshot` は継続します。

## v0.5の研究・移行データを残す範囲

v0.5で行った own-body v3、stale除外、既定候補入口、Writer入力依存の検証記録は歴史的なベースラインとして保持します。v0.5のSchur合成評価、PPRの比較、保存済み埋め込みの意味評価は研究資料であり、v0.6 runtimeの実装や公開品質の証明ではありません。過去のJSON・release manifest・検証結果を v0.6 の実績として上書きしないでください。

0.4以前からの移行で必要だった本文表現v3、既知のlegacy vector設定、旧checkpointの扱いは v0.5 の検証記録で確認します。既知のlegacy行をv3へ再利用できるのは、旧設定ID・encoder・dimensions・policy・own-body hash・vectorsが一致する場合だけです。リンク先本文を混ぜた旧行は再埋め込みし、旧cursor/checkpointをコピーしません。v3の `prepareIndex` はcurrent headを、`updateIndex` はsequence 0からの変更feedをscopeごとにdrainします。v0.6ではこの保存・索引境界を引き継ぎ、評価設定と利用状態だけを追加します。

## Sakanaとの接続

Sakanaの `runAgent` はモデル実行、入力選択、費用、再試行、完了記録を所有します。`memory.read` の結果をモデルへ届けて成功した後、同じbindingで `host.recordUse(deliveredRefs, binding, { eventId })` を呼びます。`deliveredRefs` はSakanaの最終フィルタ後の本文・引用の参照で、取得結果全体の `recalled.refs` とは限りません。Sakanaが現在性を再検証し、失敗した要求、stale・非認可・purge済みの入力を利用へ加算しません。ライブラリのhost-only通知は、現在も読取可能な保存済みの旧観測版を受理できますが、その利用を後継版へ移しません。
