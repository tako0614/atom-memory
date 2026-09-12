# 移行

## v0.3 から v0.4

5操作 (`write`・`search`・`inspect`・`read`・`edit`) と `MemoryHarness` を使うコードは、同じ保存先へ接続して更新できます。AtomのID・不変版・出典をコピーし直す必要はありません。

### 検索

- `search`・`read`・自動readは[共通の構造ランキング](/ranking)を使います。`search` も関係でつながった情報を返します。旧来の内容だけの探索は `depth: 0` で指定できます。
- `read` の既定深さは1から2へ変わります。ホストの `ranking.depth` で既定を変更できます。
- `score` の尺度が変わり、`scoreBreakdown` を追加しました。旧版の数値を閾値として引き継がないでください。
- 候補取得・関係取得・本文返却で予算を配分します。順位は結果返却前に固定し、cursorはその有限結果を返します。`maxScan` をページごとの全履歴走査に使う処理は、直接 `inspect` やホスト側の入力処理へ移してください。
- `inspect` は指定した版と関係の直接読取のままです。必須の証拠・条件、削除、権限の規則も検索順位とは別に適用します。

### ベクトルと進捗

埋め込みの設定識別子を検索順位の設定から分離しました。重みや候補取得方式を変えるだけでは、保存ベクトルを再計算しません。既存の派生物の根拠も、順位設定だけでは失効しません。

0.3と同じエンコーダーID・次元数・表現形式を使い、旧設定を解決できる場合、`prepareIndex` / `updateIndex` が既存の索引metadataと進捗を有限ページで移します。本文hashと権限を確認できるベクトルは再利用します。migrationの続きも永続化します。旧版の候補provider・tokenizer・generatorを同時に変更すると、旧設定の識別子を復元できず再索引になる場合があります。まず従来の設定で移行を完了し、その後に設定を変更してください。

独自StorageAdapterが旧ベクトルを移すには、`indexEntries` の有限・スコープ付き列挙を実装します。標準Memory/SQLite adapterは対応済みです。エンコーダーや検索表現が変わった場合は再索引が必要です。新しいAtomや改訂は従来どおり `indexAtoms` / `updateIndex` で反映します。

移行前にDBをバックアップし、旧プロセスと新プロセスから同時に書き込まないでください。0.3へ戻す場合、索引metadataが新しい設定になっているため旧版側で再索引が必要です。Atomの本文や原資料を作り直す必要はありません。

### 廃止した公開API

| 廃止した経路                                 | 移行先                                        |
| -------------------------------------------- | --------------------------------------------- |
| `AtomKernel` / `HostOptions.kernel`          | `MemoryHost({ storage, authority, limits? })` |
| Kernelのselector型read                       | `search` / `inspect` / `read`                 |
| `AgentHarness` の別名 / `LegacyAgentHarness` | `MemoryHarness`                               |
| `content()` / `membership()` helper          | `write({ text, links })` / `edit`             |
| 旧read/index/overlay型                       | [現在の公開型](/contracts)                    |

旧低水準実装を併用する互換レイヤーはありません。トランザクション・不変版・監査・物理purgeは内部の保存処理として残しています。

既知の旧 `PinnedRef` は、信頼されたホストで `host.reference(pinnedRef, binding)` を使って新しい `AtomRef` へ解決できます。通常の関係はlogical、特定の根拠版を固定する関係は `{ ref, at: 'observed' }` を指定します。

## 以前の版

0.3で導入したバッチWriterと増分索引は[長期Writer](/history)を参照してください。0.2.1の出典共有・構成宣言・再生成計画は現在も必要です。根拠を確認せず古い派生物へ取得計画を後付けせず、新しい版をWriterで確定します。

v0.1の設計と型は[当時のソース](https://github.com/tako0614/atom-memory/tree/0c5a5aeb29b1a11195cb74d562f00c5dd6edec15/spec)に保存しています。[元の設計文書](/migration-architecture)は歴史資料です。現在のAPIは [API](/api) と [公開型](/contracts)を参照してください。
