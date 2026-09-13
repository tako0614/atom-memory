# TypeScript

公開パッケージには型宣言が含まれています。アプリの関数には `MemoryAPI`、保存・検索で受け取る参照には `AtomRef` を使えます。

```ts runnable
import type { AtomRef, MemoryAPI } from 'atom-memory';

export async function invitationNotes(memory: MemoryAPI) {
  const page = await memory.search('招待リンク', { limit: 10 });
  return page.items.map((item) => ({ ref: item.ref, text: item.text }));
}

export async function correctNote(memory: MemoryAPI, ref: AtomRef, text: string) {
  const result = await memory.edit((draft) => draft.revise(ref, text));
  return result.value.ref;
}
```

`AtomRef` はライブラリが発行する不透明な値です。文字列を型変換して作るのではなく、`write`・`search`・`inspect`・`edit` の結果から受け取ります。

## アプリで使う型

| 型                                           | 表すもの                           |
| -------------------------------------------- | ---------------------------------- |
| `MemoryAPI`                                  | 五つの操作を持つインターフェース   |
| `MemoryContent`                              | 文字列、または本文と関係           |
| `AtomRef` / `AtomView`                       | 観測した対象への参照と表示する内容 |
| `Links` / `LinkTarget`                       | 役割付きの接続先                   |
| `MemoryState` / `ReadOptions`                | read の入力と予算・探索設定        |
| `MemoryPage` / `Inspection` / `RecallResult` | 検索・参照・read の戻り値          |
| `Draft` / `EditOutcome<T>`                   | 非公開の編集と確定結果             |
| `MemoryReceipt` / `SourceCitation`           | 入力を追跡する記録と出典           |

各フィールドと使用例は [API](/api)、全体の定義は [src/client/types.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/types.ts)を参照してください。

## ホストで使う型

| 型                                        | 設定するもの                         |
| ----------------------------------------- | ------------------------------------ |
| `HostOptions` / `ClientBinding`           | 保存・認証・書き手・既定値           |
| `ActivationOptions` / `RetrievalOptions`  | 利用活性と候補取得の宣言的な上限     |
| `UseResult`                               | 成功したモデル応答への利用ackの結果  |
| `Authorizer`                              | ホストの認証主体と権限の解決         |
| `StorageAdapter`                          | ローカル保存の読取とトランザクション |
| `EmbeddingProvider` / `CandidateProvider` | 検索表現と候補取得                   |

内部のTraceや取得計画は公開型としてexportしません。モデルの応答型・ツール型・実行結果はアプリが定義します。

## v0.6で固定した検索契約

`AtomView.text` が候補の直接検索表現です。リンク先本文を暗黙に連結せず、`links` は構造ランキングと明示的なgraph traversalに使います。`MemoryPage.stale` に入った生成候補は `items` から除外され、古い候補のscore・順位・ページ位置を現在のsourceへ移しません。アプリは参照を調べ、必要なら通常の `edit` とWriterで改訂します。

`Diagnostics.coverageCertified` は常に `false` です。`complete`、`approximate`、一つの `pending: false` は、許可されたコーパス全体の網羅性やscope全体のv3索引準備を保証しません。`CandidateProvider` は `PinnedRef[]` だけを返し、本文の読み直し、候補スコア、関係伝播、利用活性の合成はCoreが認可済みの保存内容に対して行います。候補取得の上限は `HostOptions.retrieval`（`maxScan` を含む）、利用活性は `HostOptions.activation` で宣言します。`maxEvaluationWork` は `Budget` の評価計算上限です。

`recordUse` は信頼されたホストが成功したモデル応答後に呼ぶ利用ackです。read/searchだけでは利用を記録しません。集計は主体・policy・revisionごとに指数減衰し、同じ `eventId` の再送は一度だけ受理します。半減期の変更は既存状態を `STATE_INVALIDATED` にし、`resetUse` で明示的に集計を消します。
