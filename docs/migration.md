# 移行

このページは既存の Atom Memory を更新する方向けです。新規利用は [はじめる](/guide)から進めてください。

## v0.1 からの変更

v0.2 は `MemoryHost` が発行する高水準クライアントを中心に使います。自動の記憶取得を `read`、候補の明示検索を `search`、正確な参照を `inspect`、追加を `write`、一括編集を `edit` に分けています。

基準 commit は `0c5a5aeb29b1a11195cb74d562f00c5dd6edec15` です。低水準の `AtomKernel.read` は従来の契約を維持します。名前の一致だけで新しい `memory.read` と置き換えないでください。

| v0.1 の経路                               | 移行先                                               |
| ----------------------------------------- | ---------------------------------------------------- |
| Kernel の `read({ selector: search })`    | クライアントの `search(query)`                       |
| Kernel の `read({ selector: refs })`      | クライアントの `inspect(ref)`                        |
| アプリが read 結果を文脈へ追加            | `MemoryHarness` の自動 read と記憶領域の置換         |
| 手動 ID・版・expectedHead の write バッチ | `write(content)` と `edit(draft => ...)`             |
| `AgentHarness` の records 追記            | `MemoryHarness`。旧実装の名前は `LegacyAgentHarness` |
| membership 専用の関係探索                 | 任意の役割付きリンクの正引き・逆引き                 |

公開名 `AgentHarness` は現在 `MemoryHarness` の別名です。従来のハーネスを明示的に使うコードは `LegacyAgentHarness` へ import を変更します。

## 1. 同じ保存先へホストを接続する

既存の Kernel を `new MemoryHost({ kernel: existingKernel })` に渡します。認証と書込先をホストへ束縛し、[クライアント設定](/setup)と同じ形で接続します。

```ts
const host = new MemoryHost({ kernel: existingKernel });
const memory = host.connect({
  auth,
  writePolicy: 'notes',
  actor: { type: 'human' },
});
```

既存 Atom のコピー・再採番・再分類は不要です。SQLite の ID、不変版、出典をそのまま保持します。各操作はこの同じホストと保存先を使ってください。

## 2. 参照と編集を移す

新しい保存と検索からは高水準の `AtomRef` を受け取ります。既知の旧 `PinnedRef` を移す場合は、信頼されたホストで `host.reference(pinnedRef, binding)` を呼びます。raw ID からの移行はホストの認証の下で行います。

改訂は `draft.revise(ref, content)` に変更します。観測版が自動的に書込の前提となり、競合時はエラーを返します。callback を再実行していたアプリでは、モデル呼出しなどの外部操作も含め、競合後の再判断をホスト側で扱ってください。

## 3. 関係を確認する

旧 membership の slots は一般の役割付きリンクとして読みます。元の ID、版、origins、役割を消さずに探索できます。schema メタデータは保存しますが、通常の検索や関係探索の必須条件にはしません。

通常の `links` は論理的な対象へ接続します。`{ ref, at: 'observed' }` は特定の版への固定リンクです。どちらも旧 Kernel の `include` による全文の固定構成とは意味が異なります。

旧 `include` を使った固定構成は低水準 Kernel で明示的に維持できます。固定構成のバッチ内循環は拒否し、一般リンクの相互参照は訪問済み管理と予算で扱います。

## 4. ハーネスを切り替える

`MemoryHarness` に新しいクライアントと `HarnessModel` を渡します。モデル呼出し前の自動 read と、前回の記憶領域の置換が実行されます。[接続例](/runtime)を参照してください。

現在のユーザー入力、作業状態、新しい観測を分けて渡します。過去の records 全体をモデル入力として連結する処理は外し、監査の保存をモデル入力から分離します。検索・参照の継続は発行済み cursor に対応する `resume` 操作へ接続します。

## 歴史資料

元の設計資料と型は、当時の判断や既存データを調べるために保存しています。「公開APIは read/write だけ」「schema で探索の意味を切り替える」という部分は v0.2 の要求で更新されています。

- [元の設計 v1.0](/migration-architecture)
- [元の TypeScript 契約](https://github.com/tako0614/atom-memory/blob/main/spec/contracts.ts)
- [API 再設計の要求](https://github.com/tako0614/atom-memory/blob/main/spec/api-v0.2/README.md)

現在の使い方は [guide](/guide)・[API](/api)、実装の構成は [アーキテクチャ](/specification)を参照してください。移行処理は公開済みデータの消去やパッケージの上書きを行いません。

## 既存データと低水準 API の回帰条件

A35 は、既存 SQLite の ID・不変版・出典・membership を保持し、再接続後に高水準の参照と履歴を解決できることを検証します。F01–F20 は低水準 Kernel と旧ハーネスの回帰条件です。

| ID  | 検証内容                                                       |
| --- | -------------------------------------------------------------- |
| F01 | B の実体を共有して P / Q へ独立に所属                          |
| F02 | 所属追加で親・祖先の版を変えない                               |
| F03 | membership の retirement が別所属や子を削除しない              |
| F04 | 固定 include の履歴維持、古い派生物の検出                      |
| F05 | 同じ expected head の同時改訂で一方だけ成功                    |
| F06 | 動的所属の循環を有限に読み、関係を保持                         |
| F07 | 固定 include のバッチ内循環を適用前に拒否                      |
| F08 | 新しい所属の挿入で検索範囲依存を無効化                         |
| F09 | 出典範囲の和集合と同一版・重複経路の一意化                     |
| F10 | from / to、否定、条件、付随参照を文脈へ保持                    |
| F11 | 共有予算、子への予約、ページ・token 上限                       |
| F12 | 空の途中結果を網羅・不存在の証明にしない                       |
| F13 | 継続中の版固定、再起動後の snapshot / cursor、埋め込み遅延診断 |
| F14 | snapshot 非対応で `CONSISTENCY_UNAVAILABLE`                    |
| F15 | 原子性非対応で変更前に `ATOMICITY_UNAVAILABLE`                 |
| F16 | Writer 失敗時の差分非公開、正常時の一回確定                    |
| F17 | scope、cursor、旧版、派生物、モデル待機中の権限失効            |
| F18 | Writer による source 自己申告を拒否                            |
| F19 | 同一要求の冪等性と同一キーの内容変更拒否                       |
| F20 | 原資料・派生物・過去版・古い blob の管理消去                   |

SQLite の再オープン試験は、保存先への再接続後も ID・版・receipt が変わらないことを確認します。分散ネットワーク分断・保存移動・独立書込スループットの試験を実施したという意味ではありません。

検索品質・意味忠実性・実 LLM の回答品質は、この決定的な試験と別の評価対象です。F09 / F10 は構造と出典の整合性を検証し、再分割後の回答品質が完全に同じと証明するものではありません。
