# アーキテクチャ

Atom Memory は、アプリが扱う内容と関係を、高水準クライアントから一つの Atom ストアへ保存します。検索、モデルへの記憶供給、Writer の整理は同じ取得処理を使います。

```text
アプリ                         MemoryHarness
write / search / inspect       自動 read → モデル → 明示操作
edit / read                            │
        └──────── MemoryClient ────────┘
                         │
        候補取得 → 関係展開 → 依存検証 → パッキング
                         │
        不変版・出典・認可・原子的な編集確定
                         │
                 Memory / SQLite
```

## ホストとクライアント

`MemoryHost` は認証、保存先、エンコーダー、生成器、予算の設定を持ちます。`connect` は認証主体と書き手を束縛した `MemoryClient` を返します。クライアントは保存や検索で参照を発行し、参照の解決時に版と現在の権限を検証します。

この分担により、アプリの通常操作では内容と関係に集中できます。原資料の投入は入力アダプター、生成物の保存は生成エージェントという出自もホストで記録します。

## 取得から記憶領域まで

1. **候補取得**：本文・役割を含む検索表現を使い、許可された候補を取得する。
2. **関係展開**：正引きと逆引きで接続先をたどり、深さ・件数・訪問済みで範囲を制限する。
3. **依存検証**：使用する版、出典、生成物の入力、現在の権限を確かめる。
4. **パッキング**：関連度と本文長、同じ証拠の重複、必須条件の本文を扱い、今回の予算に収める。

`search` は候補のページ、`inspect` は特定の参照と周辺、`read` はパックした記憶領域を返します。続きには読取状態と検索信号を結び付け、別のクエリで使ったり、失効を空結果として扱ったりしないよう検証します。

## 編集の確定

`edit` は非公開 overlay で変更を作ります。Writer やアプリは自分の変更を読みながら、有限のバッチを組み立てます。確定時に改訂の前提版、参照、関係範囲、入力依存、権限を検証し、全件を原子的に保存します。

`supersede` はこの編集の一部として後継を採用し、旧構成の具体的な版を manifest に残します。作業中の検索結果をそのまま永続的な整理へ昇格させることはなく、保存する内容は明示的な編集で決まります。

## モデル入力の寿命

ハーネスはユーザー入力と作業状態を保持し、今回の記憶領域をモデル呼出しごとに選び直します。監査ログはホストに別保存し、入力の全履歴をモデルへ送り続ける構成にはしません。

呼出し前にシリアライズ済みの全入力を計測し、出力の予約も含めてウィンドウを検証します。モデルと索引などの外部処理にも、同じ実行予算・キャンセルを伝搬します。

## 実装を読む

| 関心                       | 主なファイル                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| 公開クライアントと編集     | [client/memory.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/memory.ts)       |
| 認可・読取状態・参照の管理 | [client/engine.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/engine.ts)       |
| 関係展開・依存・パッキング | [client/retrieval.ts](https://github.com/tako0614/atom-memory/blob/main/src/client/retrieval.ts) |
| 候補取得                   | [core/candidates.ts](https://github.com/tako0614/atom-memory/blob/main/src/core/candidates.ts)   |
| 不変版と編集の確定         | [core/kernel.ts](https://github.com/tako0614/atom-memory/blob/main/src/core/kernel.ts)           |
| モデル実行                 | [runtime/harness.ts](https://github.com/tako0614/atom-memory/blob/main/src/runtime/harness.ts)   |

保存方式と対応規模は [保存と検索](/adapters)、動作と実モデルの検証は [検証](/acceptance)にまとめています。
