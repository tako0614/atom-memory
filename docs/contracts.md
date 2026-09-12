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

| 型                                               | 設定するもの                         |
| ------------------------------------------------ | ------------------------------------ |
| `HostOptions` / `ClientBinding`                  | 保存・認証・書き手・既定値           |
| `RankingOptions` / `ScoreBreakdown`              | 関係・信号の重みと順位の内訳         |
| `Authorizer`                                     | ホストの認証主体と権限の解決         |
| `StorageAdapter`                                 | ローカル保存の読取とトランザクション |
| `EmbeddingProvider` / `CandidateProvider`        | 検索表現と候補取得                   |
| `Generator`                                      | 失効した派生表現の再生成             |
| `HarnessModel` / `ModelAction` / `ModelMutation` | モデル接続とモデルが選ぶ操作         |
| `HarnessOptions` / `HarnessResult`               | 実行設定と結果                       |

モデル接続の定義は [src/runtime/harness.ts](https://github.com/tako0614/atom-memory/blob/main/src/runtime/harness.ts)、実装例は [エージェントと Writer](/runtime)にあります。
