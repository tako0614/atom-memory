# アーキテクチャ

Atom Memoryは、本文・関係・不変版を保存し、現在の文脈に合う記憶を返すJavaScriptライブラリです。0.5では、モデル実行と履歴運用をアプリケーションへ分離しました。

```text
アプリ / Agent
  入力の取得、期間の選択、モデル、ツール、費用、再試行、チェックポイント
  read → モデル → 検証した write / edit → 索引更新の呼出し
                │
          MemoryClient / MemoryHost
                │
  候補取得 → 鮮度検証 → seed採用 → 構造ランキング → パッキング
                │
  不変版・出典・認可・CAS・原子的な編集確定
                │
          Memory / SQLite
```

## ライブラリが持つもの

- `text + links` によるAtom。本文・まとまり・関係は同じ形式で、再帰・多重所属を表す一般グラフです。
- 検索表現は `representationVersion: 3` のAtom自身の本文だけです。役割付きリンクは候補確定後の構造ランキングで一度だけ適用します。
- 観測済みrevisionと現在版の区別、原子的な複数編集、競合検出、再送の冪等性。
- 出典、実際に読んだ入力の記録、スコープ認可、削除による依存物の失効。
- 埋め込みproviderと候補providerを通した検索、役割・方向付きの構造ランキング。
- 取得・本文・通信などの有限予算、cursor、索引更新の操作。

## Agent / アプリが持つもの

- 何を意味単位とするか、どの関係を作るか、同じ根拠の重複をどう整理するか。
- 使用モデル、モデルの応答形式、ツール実行、文脈や明示的な検討状態の選択。
- 履歴をどの期間・件数で処理するか、いつ再整理するか、費用上限と再試行。
- どの整理を採用するか、後継の意味、履歴をいつまで保持するか。

Sakanaでは `src/ai/runtime.js` の `runAgent` を共通実行ループとし、`src/conversation/writer.js` が意味構造を作ります。Atom内に別のモデルプロトコルや実行ループはありません。

## 読取と再整理の境界

`read` / `search` は保存済み生成物の入力が古くなっていないか確認します。古い生成物を `items` や `text` へ返さず、`stale` にその参照を返します。古い候補の現在の出典を、その候補の順位・score・ページ位置へ代用しません。現在の原資料は、通常の本文候補取得または構造展開で独立に見つかった場合だけ返します。

候補の鮮度・認可はseedへ採用する前に検証し、その結果を一回の操作内でrevisionごとにキャッシュします。構造ランキングでも、新しいグラフノードを追加する前に同じ検証を行うため、staleなノードが現在の隣接ノードへ関連度を渡すことはありません。

ライブラリは古い検索を再実行して意図を推測したり、LLMで文章を生成したりしません。アプリが必要な入力を選び直し、Writerを呼び、通常の `edit` で新しい版を確定します。埋め込みの計算は検索機能の一部で、設定したproviderと予算に従います。

`inspect` は指定した版を調べる操作です。古い生成文そのものも調査でき、現在の正しい回答であることは保証しません。`read` の鮮度判定と区別します。

## 改訂と履歴

`revise` は同じAtomの新しい版を作ります。既存の観測参照は元の版を指し、logicalリンクは現在版を指します。あるAtomの旧版を指すことと、その周辺全体を過去の同じ時点へ戻すことは別です。

ライブラリは後継採用、構成の自動推定、30日などの保持期間を設定しません。必要ならアプリが通常の関係と改訂・retireを組み合わせ、保存adapterのsnapshot機能を使って保持方針を実装します。

## 監査と削除の保証

現在のpurgeは保守的です。出典、任意リンク、読取receiptに記録された入力から依存物を連鎖削除します。同じeditでAIが見た入力は全出力の監査依存になり、出典ラベルだけで個別出力の因果的独立を推定しません。

この分離では削除保証を弱めていません。細かい独立性が必要なWriterは、原子的なコミットの大きさだけでなく、モデルへ渡す入力の単位を設計します。一般の関連と削除依存の契約をさらに変える場合は、別の保存・削除仕様として扱います。

一つのreceipt manifestには、モデルが見た `reads`、currentnessを検査する subset、queryの observations、出力の所属、認可、historical basisを記録します。これらは同じイベント内の別の意味です。観測・鮮度・出典・erase lineageを別の新しいframeworkへ分割することは0.5の要件ではありません。引用リストやモデルのlinksだけでerase lineageを狭めず、opaqueなWriter editでは見えた入力全体を保守的な依存として残します。

## 表現・関係・検証の判断境界

隣接Atomの本文を親の埋め込みや語彙表現へ連結する方式は、関係weightが0でも候補入口に影響し、同じリンクを候補取得と構造伝播で二重に数え、対象改訂だけで親を再エンコードする依存を作ります。0.5ではこの暗黙の経路を削除し、本文一致を `direct`、リンク経由の寄与を `structural` として分けます。代替案を戻す場合は、表現方式を版管理し、役割・方向ごとの寄与を指定した同条件評価で、構造探索を超える利益を示すことが先です。

Atomは addressable な意味を持つ不変版ですが、数学的に唯一の「最小意味単位」を定めません。通常の二項関係は役割付きリンクで表します。関係自身に本文・出典・改訂・認可・n項参加者・リンクが必要な場合だけ、関係を別Atomへ reify します。一つのレコード形を採用することは、すべての関係をノードへ変換する方針ではありません。重複やWriterの粒度が順位へ与える影響は、Agent側の意味設計と評価で確認します。

`score` は query への相対関連度です。真偽、因果独立性、絶対的重要度を保証しません。候補providerは既定で、embeddingなしなら `LexicalCandidateProvider`、embeddingありなら `HybridCandidateProvider` を使います。`ExactCandidateProvider` は明示的な有限走査の基準であり、近似診断や `complete` はコーパス全体の網羅性を証明しません。

表現v3への移行では、旧Atom本文・revision・receipt・linksを意味データとして保ち、索引を投影として再生成します。既知のv2設定からの一行再利用は、本文hash、policy、encoder、dimensionsが一致する場合に限ります。`prepareIndex` はcursor付きでcurrent headを走査し、`updateIndex` だけがsequence 0の変更フィードを使います。旧進捗やcursorをコピーせず、全policy scopeをそれぞれの走査または変更フィードの終端までdrainしてから意味検索の準備完了を宣言します。一つの呼出し・channelの `pending: false` は全体のreadinessではありません。旧索引メタデータが互換しない候補を調べた場合も `pending` として報告します。

残る検証仮説は、(1) own-body候補と明示的グラフ展開でrelation-only evidenceのrecall・費用が保てるか、(2) Writerが将来の質問を知らずに適切な粒度・関係を作れるか、(3) 関係Atomの重複がseed massや順位を歪めないか、(4) 長期履歴のscope別drainが再起動・encoder失敗後も完了するか、です。既存の決定的な構造評価は(1)のグラフ因果を部分的に示すだけで、実モデル品質・有料モデル差・本番公開を示しません。

## 実装を読む

| 責務                  | 実装                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公開操作と編集        | [client/memory.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/memory.ts)                                                                                              |
| 認可・参照・取得状態  | [client/engine.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/engine.ts)                                                                                              |
| 鮮度検証・本文構築    | [client/retrieval.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/retrieval.ts)                                                                                        |
| グラフ取得・順位      | [client/ranking.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/ranking.ts) / [core/ranking.ts](https://github.com/tako0614/atom-memory/blob/main/src/core/ranking.ts) |
| 原子保存・出典・purge | [core/store.ts](https://github.com/tako0614/atom-memory/blob/main/src/core/store.ts)                                                                                                    |

公開APIは[操作一覧](/api)、移行は[0.5への移行](/migration)を参照してください。
