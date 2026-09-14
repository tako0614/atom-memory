# v0.7への移行

::: info 歴史資料
このページはv0.6からv0.7へ移行した時点の契約と検証手順を保存しています。`edit`、`basis`、旧manifestの記載は当時の実装に対する歴史的なvalidationで、v0.9.0の公開APIではありません。現行の宣言的writeとInputTokenは[移行](/migration)を参照してください。
:::

v0.7は v0.6 から利用可能性の公開契約を更新します。Atomの本文・ID・revision・出典・receipt・links、v3のown-bodyベクトルと保存データは保持します。認証・policyを含む既存の保存を消去して移行する必要はありません。設定identityが変わるため古いcursorは失効させて取り直します。公開版と検証結果は[リリース記録](/release)で確認できます。

## まず確認すること

バックアップを取り、旧版と新版のプロセスを同じ保存先へ同時に書き込まないでください。移行後は次を実行して、旧0.6設定・型・候補providerの差分を確認します。

```sh
ATOM_V06_PACKAGE=/path/to/published-0.6.0-package node scripts/check-v06-migration.mjs
```

このスクリプトは利用者の既存DBを書き換えません。公開0.6.0パッケージで一時SQLite fixtureを作成・再オープンし、本文・版・v3ベクトル・legacy利用状態を読み、0.7の状態decodeと次回recordUse時のrewrite、古いcursorの失効を確認します。公開npmのmanifestや過去の検証記録は、このローカル移行結果から更新しません。

## 公開APIと設定の変更

| v0.6の利用                                                      | v0.7での扱い                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `activation.halfLifeMs`                                         | 削除。`activation.model` の既定は `adaptiveUse()`。初期半減期・最大半減期は `adaptiveUse({ initialHalfLifeMs, maxHalfLifeMs })` で設定する |
| 固定の利用状態 `h` / 半減期                                     | `AvailabilityModel<S extends Json>` の `{ id, update, value }` へ移行する。既定状態はmass・時刻・半減期を持つ                              |
| 利用状態の互換性                                                | `model.id` を状態の設定identityに含める。同じIDは継続し、異なるIDは `STATE_INVALIDATED` としてscope resetを要求する                        |
| 0.6のlegacy利用状態                                             | readでは正確にdecodeし、イベント再送では書き換えない。新しいrecordUseでだけadaptiveUse形式へrewriteする                                    |
| `retrieval`、`PinnedRef[]` provider、埋め込み80%・語彙20%の評価 | 0.6の契約を維持する。`b = m(1 + βu/(1+u))`、`a = b + Tᵀa` の評価境界も維持する                                                             |
| 旧cursor                                                        | 0.7のmodel/config identityに束縛されるため `CURSOR_EXPIRED`。新しい検索から開始する                                                        |

`recordUse` の戻り値は `{ acceptedAt, recorded, repeated }` です。利用状態は認証主体・policy・revisionごとに隔離され、同じ `eventId` の再送は一度だけ反映します。`host.resetUse(binding)` は現在の主体と許可policyの集計を消しますが、重複防止マーカーは残します。モデルの `id` やパラメータを変更して `STATE_INVALIDATED` になった場合は、明示的に `resetUse` を呼んでから読み直してください。`maxBoost` や伝播の変更だけでは利用状態をリセットしませんが、設定identityが変わるためcursorは失効します。

### AvailabilityModelと既定モデル

`activation.model` は `AvailabilityModel<S extends Json>` です。`update(previous, acceptedAt)` と `value(state, now)` は同期的・純粋で、状態は正規化JSON 1 KiB以下、値は非負有限でなければなりません。query・context・score・graph・全履歴はcallbackへ渡されません。例外、Promise、無効な状態、非有限値は操作を失敗させます。ライブラリはscope、atomicity、dedup、purgeとモデルIDの状態照合を所有します。

既定の `adaptiveUse({ initialHalfLifeMs, maxHalfLifeMs })` は、初期7日・最大365日で `{ mass, updatedAt, halfLifeMs }` を保持します。イベント時に減衰したmassへ1を加えて1,000,000で上限を設け、保持率に応じて半減期を伸ばします。legacyの0.6状態は `mass=h`、`updatedAt`、旧半減期を読み出し時に正確に解釈します。旧半減期が新しい上限を超えていても短くしません。readや古いイベントの再送は状態を書き換えず、イベントを再生しません。新しい受理イベントが来たときだけadaptiveUseの形式へ書き換えます。

アプリのモデル実行ループは引き続きアプリが所有します。モデルproviderから成功応答を受けた経路が、モデルへ渡したrefsを自動でackします。モデルのツール呼び出しや人の承認を利用イベントとして待つAPIはありません。

## 保存・索引の扱い

v3の表現は各Atom自身の本文から作られ、既存の互換なベクトル行は保持できます。encoder、dimensions、policy、own-body hashが一致する行だけを再利用し、旧形式の混在やconfigだけの書き換えは行いません。既存のstorage adapterは本文、版、出典、入力記録、v3索引を同じ境界で扱います。

索引を使うhostは、提供する全policy scopeの `prepareIndex` / `updateIndex` を再開し、各scopeのcheckpointを終端までdrainしてから意味検索をreadyと扱います。一つの `pending: false` やproviderの `complete` は全体の準備完了を示しません。移行で設定世代が変わったcursorは `CURSOR_EXPIRED` として新しい検索から開始します。

`MemoryHarness`、モデル実行、再取得計画、一時生成cache、旧 `supersede` の自動採用は v0.5 から引き続きライブラリにありません。`stale` を受けたアプリが入力を選び直し、通常の `edit` で改訂します。`basis: 'historical'`、観測版、不変版、receipt、明示的な `retainSnapshot` / `retainedSnapshot` は継続します。

## v0.5の研究・移行データを残す範囲

v0.5・v0.6で行った own-body v3、stale除外、既定候補入口、Writer入力依存の検証記録は歴史的なベースラインとして保持します。Schur合成評価、PPRの比較、保存済み埋め込みの意味評価は研究資料であり、v0.7 runtimeの実装や公開品質の証明ではありません。過去のJSON・release manifest・検証結果を v0.7 の実績として上書きしないでください。

0.4以前からの移行で必要だった本文表現v3、既知のlegacy vector設定、旧checkpointの扱いは v0.5 の検証記録で確認します。既知のlegacy行をv3へ再利用できるのは、旧設定ID・encoder・dimensions・policy・own-body hash・vectorsが一致する場合だけです。リンク先本文を混ぜた旧行は再埋め込みし、旧cursor/checkpointをコピーしません。v3の `prepareIndex` はcurrent headを、`updateIndex` はsequence 0からの変更feedをscopeごとにdrainします。v0.7ではこの保存・索引境界を引き継ぎ、利用可能性モデルと状態identityだけを追加します。既存v3ベクトルは再エンコードしません。

## Sakanaとの接続

Sakanaの `runAgent` はモデル実行、入力選択、費用、再試行、完了記録を所有します。`memory.read` の結果をモデルへ届けて成功した後、同じbindingで `host.recordUse(deliveredRefs, binding, { eventId })` を呼びます。`deliveredRefs` はSakanaの最終フィルタ後の本文・引用の参照で、取得結果全体の `recalled.refs` とは限りません。Sakanaが現在性を再検証し、失敗した要求、stale・非認可・purge済みの入力を利用へ加算しません。ライブラリのhost-only通知は、現在も読取可能な保存済みの旧観測版を受理できますが、その利用を後継版へ移しません。
