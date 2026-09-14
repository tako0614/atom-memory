# TypeScript

公開パッケージには型宣言が含まれています。アプリの境界には `MemoryAPI`、保存・検索で受け取る参照には `AtomRef` を使えます。現在の通常APIは `read`、`search`、`inspect`、`write` の四つです。

```ts runnable
import type { AtomRef, MemoryAPI } from 'atom-memory';

export async function invitationNotes(memory: MemoryAPI) {
  const page = await memory.search('招待リンク', { limit: 10 });
  return page.items.map((item) => ({ ref: item.ref, text: item.text }));
}

export async function correctNote(memory: MemoryAPI, ref: AtomRef, text: string) {
  const result = await memory.write({
    changes: [
      {
        id: 'correction',
        op: 'revise',
        target: ref,
        content: { text, links: [] },
        sources: [],
      },
    ],
  });
  return result.changes.correction.ref;
}
```

`AtomRef` はライブラリが発行する不透明な値です。文字列を型変換して作るのではなく、`write`、`search`、`inspect`、`read` の結果から受け取ります。

## アプリで使う型

| 型                                               | 表すもの                                                 |
| ------------------------------------------------ | -------------------------------------------------------- |
| `MemoryAPI`                                      | read / search / inspect / write のインターフェース       |
| `MemoryContent`                                  | 本文と完全置換のlinks                                    |
| `MemoryChange` / `MemoryWriteRequest`            | create / revise / retire の宣言的batch                   |
| `CreateChange` / `ReviseChange` / `RetireChange` | 各changeの形、sources、target、InputToken                |
| `WriteOutcome`                                   | operationId、repeated、indexing、change idごとのAtomView |
| `AtomRef` / `AtomView`                           | 観測した対象への参照と表示する内容                       |
| `Links` / `LinkTarget` / `LocalLinkTarget`       | 役割付きの既存・batch-local接続先                        |
| `MemoryState` / `ReadOptions`                    | readの入力、depth、予算・探索設定                        |
| `MemoryPage` / `Inspection` / `RecallResult`     | search / inspect / readの戻り値                          |
| `InspectionVia` / `InspectionNeighbor`           | 一-hop隣接と方向・役割・条件                             |
| `MemoryReceipt` / `SourceCitation`               | 入力を追跡する記録と出典                                 |
| `InputToken` / `HostInput`                       | ホスト発行の生成入力とその宣言                           |

`MemoryContent.links` と create/revise の `sources` は必須です。空の場合も空配列を渡します。`LocalLinkTarget.local` は同じwrite batchのchange idだけを指し、永続参照にはなりません。通常のグラフは循環できます。

## ホストで使う型

| 型                                                              | 設定するもの                               |
| --------------------------------------------------------------- | ------------------------------------------ |
| `HostOptions` / `ClientBinding`                                 | 保存・認証・書き手・既定値                 |
| `HostActor`                                                     | human / input-adapter / agent と生成origin |
| `ActivationOptions` / `RetrievalOptions`                        | 利用状態モデルと候補取得の宣言的な上限     |
| `AvailabilityModel` / `AdaptiveUseState` / `AdaptiveUseOptions` | 利用状態の状態モデルと既定モデルの設定     |
| `UseResult`                                                     | 成功したモデル応答への利用ackの結果        |
| `Authorizer`                                                    | ホストの認証主体と権限の解決               |
| `StorageAdapter`                                                | ローカル保存の読取とトランザクション       |
| `EmbeddingProvider` / `CandidateProvider`                       | 検索表現と候補取得                         |

内部のTraceや取得計画は公開型としてexportしません。モデルの応答型・tool型・実行結果はアプリが定義します。

## MemoryAPIの境界

`write` は宣言されたbatchだけを検証して原子的にcommitします。`revise` はtargetの観測版をcompare-and-swapの基準にし、`retire` は本文・links・sourcesを保存したままstateだけをretiredへ変えます。agent bindingでは各changeへhost-issued `InputToken` が必要です。humanとinput-adapterはtokenなしで保存できますが、tokenを持たないagent changeは受け付けません。

`WriteOptions.idempotencyKey` は同じsubject・policy・actorの意味的なplanにだけ再利用できます。planが変われば `IDEMPOTENCY_CONFLICT`、commit後の一致 replayは `repeated: true` です。初回commitでは期限切れtokenを拒否しますが、成功済みcommitの一致 replayはtoken期限切れ後も結果を返せます。現在認可やpurgeが変わった場合は再承認が必要です。

`inspect` はrootと一-hopの `neighbors` を返します。既定は observed版、両方向、limit 20です。`limit: 0` はrootだけで、`direction`、`roles`、`version: 'latest'`、cursor、blob `range` を指定できます。inspectには `depth` や `items` はありません。`read` と `search` は引き続き `depth` と返却件数を持ちます。

## 検索と利用状態

`AtomView.text` が候補の直接検索表現です。リンク先本文を暗黙に連結せず、`links` は構造ランキングと明示的なgraph traversalに使います。`MemoryPage.stale` に入った生成候補は `items` から除外され、古い候補のscore・順位・ページ位置を現在のsourceへ移しません。アプリは参照を調べ、必要なら新しい `revise` changeを宣言します。

`Diagnostics.coverageCertified` は常に `false` です。`complete`、`approximate`、一つの `pending: false` は、許可されたコーパス全体の網羅性やscope全体のv3索引準備を保証しません。`CandidateProvider` は `PinnedRef[]` だけを返し、本文の読み直し、候補スコア、関係伝播、利用状態の合成はCoreが認可済みの保存内容に対して行います。候補取得の上限は `HostOptions.retrieval`（`maxScan` を含む）、利用状態モデルは `HostOptions.activation` で宣言します。`maxEvaluationWork` は `Budget` の評価計算上限です。

`recordUse` は信頼されたホストが成功したモデル応答後に呼ぶ利用ackです。read/search/inspectだけでは利用を記録しません。状態は主体・policy・revisionごとにモデルが更新され、同じ `eventId` の再送は一度だけ受理します。`activation.model` の `id` は設定の一部で、意味やパラメータを変えたら新しいIDにします。保存状態と現在のIDが一致しない場合は `STATE_INVALIDATED` となり、対象scopeを `resetUse` してから読み直します。

`AvailabilityModel<S extends Json>` は `id`、同期的な `update(previous, acceptedAt)`、同期的な `value(state, now)` だけを公開します。モデルへquery・context・score・graph・全履歴を渡しません。状態は正規化JSONで1 KiB以下です。非有限の値、無効なJSON、例外、Promiseはエラーとして扱い、0へのフォールバックはしません。ライブラリがscope、原子性、dedup、purge、保存形式を所有します。

## 監査入力

`InputToken` / `HostInput` はホストの入力確定、`ReceiptManifest` / `PresentationUnit` は版付き監査記録、`AtomLink` は安全な利用不可形を含むunion、`SelectionDiagnostics` は代理目的と作業打切りを表します。`host.observe` はモデルを呼ばず、全payload・presentation・sources・inherit・watches・basis・digestをホストの宣言として記録します。モデル内部の不可観測な状態や不正なホストの申告を完全に追跡する仕組みではありません。

過去v0.8の `edit`、`Draft`、`EditOutcome` は歴史的なvalidation記録に現れますが、v0.9の公開型ではありません。過去の実行結果は現在のAPIや実LLM品質の証明に読み替えません。
