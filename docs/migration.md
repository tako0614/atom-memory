# v0.5への移行

0.5はモデル実行と履歴運用をアプリへ分離し、検索表現をAtom自身の本文へ切り替える破壊的変更です。Atomの本文・ID・revision・出典・receipt・linksは保持します。ベクトルは再生成可能なv3索引投影であり、0.4の全ベクトルや進捗をそのまま現行として扱いません。

## 公開APIの変更

| 0.4まで                                                           | 0.5での扱い                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `MemoryHarness`、HarnessModel、ModelAction、ModelMutation         | 削除。アプリの既存Agentループから `read` / `search` / `inspect` / `edit` を呼ぶ |
| `HostOptions.generator`、read時の再取得計画と一時生成cache        | 削除。`stale` を受けたアプリが入力を選び、モデルを呼び、明示的に改訂する        |
| `Draft.supersede`、`InspectOptions.successor/history/composition` | 削除。通常のリンク・revise・retireとアプリの採用・保持方針で表す                |
| `SearchOptions.historical` / `ReadOptions.historical`             | 削除。旧版を調べる操作は観測参照の `inspect`                                    |
| `historyRetentionMs` / `historyMaxAtoms`                          | 削除。保存の保持期間はホストが指定する                                          |
| `Budget.maxModelOutputTokens` / `maxHops`                         | 削除。生成出力の予算はアプリ、探索深さはranking/readのdepth                     |
| `Trace` / `AcquisitionPlan` のroot export                         | 削除。入力記録は内部の保存・監査データ                                          |
| `derived: regenerated`、`read.text` の `temporary`                | 削除。永続化したAtomと原資料を返す                                              |

五つの操作は継続し、戻り値のMemoryPageに `stale: AtomRef[]` を追加しました。独自のMemoryAPI adapterやテスト用実装もこのフィールドを返してください。廃止設定・inspectオプションは無視せず `INVALID_INPUT` で通知します。

## 古い生成物と保存データ

旧receiptは鮮度・認可・削除の監査に引き続き使います。旧取得計画と生成cacheは再実行せず、現在の原資料を確認したWriterが新しい版を確定します。元の生成文は観測参照のinspectで調査できます。

古い生成候補は `search` / `read` の `items` と `text` から省き、`stale` に参照だけを返します。古い候補のsourceを現在版へ差し替えて、古いscore・順位・ページ位置を借用することはありません。現在版が結果へ入るには、通常の本文候補取得または構造展開で独立に見つかる必要があります。

旧 `supersede` を使ったアプリでは、更新前に採用状態をアプリの関係へ移し、検索から外したい旧Atomを明示的にretireしてください。0.5は `sdk:successor:*` / `sdk:history:*` を読んで採用・保持を実行しません。旧Atomがactiveなら、新版では通常の検索候補になり得ます。旧版の厳密な構成閲覧が必要なら、そのmanifestやsnapshotをアプリ側で扱う必要があります。Sakanaの既存経路は旧supersedeを使っていません。

旧版と新版のプロセスで同時に書き込まず、移行前に保存データをバックアップしてください。0.4のcursorは設定世代の変更で失効します。旧観測参照・不変版・receiptは継続しますが、旧ベクトルはv3の意味検索準備が完了するまで現行索引の証拠になりません。

## Sakana

Sakanaの `runAgent` を唯一のモデル実行ループとして使い、`stale` から既存のMemory Writerキューへ再処理を要求します。入力の取得、モデルの選択、費用上限、再試行、完了の記録はSakana側です。同じ入力でも再整理要求は新しい仕事として識別し、同じ古いバッチからの要求は重複させません。

## 0.3以前から

0.4で導入した構造ランキングは維持しますが、候補表現は `representationVersion: 3` としてAtom自身の本文だけを使います。`indexConfig` はencoder ID・dimensionsとv3を含み、旧設定の識別子と一致しません。

既知のv2設定は、公開された0.3のExact provider固定IDと、別の0.4 IDとして認識します。新しい既定がHybridになっても、これらのlegacy IDは変わりません。一つのrevisionの旧行をv3へ再利用できるのは、(a) 旧設定がその既知ID、(b) encoderとdimensionsが一致、(c) policyが一致、(d) 旧hashが新しいown-body hashと一致、(e) vectorsが存在する場合だけです。リンク先本文を混ぜた旧行は通常hashが一致せず、再埋め込みします。「0.4のベクトルを全部再利用する」「旧行をconfigだけ書き換える」移行はしません。実装の `legacyConfig` getter がこの0.3固定IDを表します。

v3の `prepareIndex` はcursorでcurrent headをscopeごとに走査します。`updateIndex` だけが変更フィードのsequence 0からscopeごとに進みます。旧checkpointをコピーせず、旧cursorは受け付けません。再起動や `limit: 1` でも同じv3 checkpointから続けます。提供する全policy scopeを `pending: false` までdrainし、各scopeの終端を確認して初めて意味検索の準備完了を宣言します。旧索引メタデータが互換しない候補を調べた場合、その操作は `pending` を報告します。一つの呼出し、channel、候補providerの `complete` は全体readinessやコーパス網羅性を示しません。

`StorageAdapter.indexEntries` や旧 `sdk:index:*` 行を外部adapterの永続契約として新規実装することは、0.5の現行動作では要求しません。旧行や古いvector bucketは、クエリが正確なv3 configを要求する限り互換投影として無視できます。削除に伴う外部adapter型の破壊は、利用者が明示的に移行する境界です。

## 低水準契約の整理

0.5では実装されていない `SearchSignal.inputKind: 'mapped-state'` を受け付けず、検索入力は `text` 系へ限定します。`WriteResult.indexState` は削除しましたが、receipt契約は削除していません。削除したのは未使用だった `ReceiptManifest.encoderConfigId` / `indexWatermark` / `overlayHandle` です。呼出し元は公開 `WriteOutcome.indexing` と `MemoryReceipt` を使います。`MemoryHost.engine` はTypeScript上privateです。索引準備は `host.indexAtoms()` / `host.prepareIndex()` / `host.updateIndex()`、複数操作のreceipt・budget共有は `MemoryClient.forExecution(...)` を使ってください。

`basis: 'historical'` による編集、通常のstorage history、adapterが明示する任意の `retainSnapshot` / `retainedSnapshot` は継続します。これらを削除するには別の公開API・保存データ移行として判断します。

旧Kernelのreadと旧Harnessの互換実装はありません。既知のPinnedRefは、信頼されたホストから `host.reference(pinnedRef, binding)` で解決します。保存契約に残るincludeやvalidTime等の旧フィールドを、新しい公開操作の機能と混同しないでください。過去の設計は[歴史資料](/migration-architecture)、現在の責務は[アーキテクチャ](/specification)を参照してください。
