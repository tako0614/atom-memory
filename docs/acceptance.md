# 受入条件と検証

0.3.0では157テストが合格しています。増分索引・ベクトル検索に加え、複数Atomのまとめての編集、期間をまたぐ改訂、失敗時の一括取り消し、参照と書き込み権限のテストを追加しています。今回のリリース情報は[公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release.json)を参照してください。以下の実モデル測定は過去版の記録であり、0.3.0の新しい実モデル評価ではありません。

公開API、検索、編集、ハーネスの動作を決定的なテストで確認し、実モデルの回答は別の評価として記録します。0.2.1ではNode 22・24・26で各140テストが合格しています。再生成・共有引用・履歴の追加29シナリオは、MemoryStorageとSqliteStorageの両方で実行しました。環境・コマンド・出力は [検証記録](https://github.com/tako0614/atom-memory/blob/main/validation/corrections.md)から参照できます。

## 実行する

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run evaluate
```

`check` はライブラリのテスト、ドキュメントのコードの型検査・実行、サイトビルドを行います。`evaluate` は合成資料で検索量・関係数・競合を増やし、必要な根拠と入力の消費量を計測します。

## 受入条件

| ID  | 新APIで確認する条件                                     | テストファイル                       |
| --- | ------------------------------------------------------- | ------------------------------------ |
| A01 | 分類・手動IDなしの5操作                                 | client                               |
| A02 | 同文の独立入力は別source                                | client / api-acceptance              |
| A03 | 確定後の応答喪失でも同じ操作を再送                      | client-hardening                     |
| A04 | refからCASを自動設定、競合拒否                          | client                               |
| A05 | 未知schema・任意関係を探索                              | api-acceptance                       |
| A06 | 役割交換・三者・繰り返し保持                            | api-acceptance                       |
| A07 | ID順後方の正解、有限走査の続き                          | api-acceptance / client-hardening    |
| A08 | 埋め込み設定下の語彙入口、索引準備の続き                | api-acceptance / client-hardening    |
| A09 | ID変更で非同点の順序が変わらない                        | api-acceptance                       |
| A10 | 明示検索なしで自動read                                  | api-acceptance                       |
| A11 | 18ステップ、記憶置換・観測上限・監査容量                | client-hardening                     |
| A12 | 話題変更で以前の自動取得本文を再投入しない              | api-acceptance                       |
| A13 | 問いと仮説の両方の信号を保持                            | api-acceptance                       |
| A14 | thoughtなし、入力なしと0件の区別                        | api-acceptance                       |
| A15 | 同じ次元の異なる空間、偽造signalを拒否                  | api-acceptance                       |
| A16 | モデルのsearch/inspectの続きをホストが再開              | api-acceptance                       |
| A17 | 逐語引用を最終本文の共有証拠へまとめる                  | api-acceptance / client-corrections  |
| A18 | 同じ出典の異なる要約は残す                              | api-acceptance                       |
| A19 | 必須条件の本文、失効した条件の主張を省く                | api-acceptance / client-hardening    |
| A20 | 循環・高次数を有限ページで取り切る                      | api-acceptance / client-hardening    |
| A21 | 本人だけがprivate draftを読める                         | client / Writerサンプル              |
| A22 | CAS・新規挿入競合・abort、callback一回                  | client / api-acceptance              |
| A23 | モデルの偽ref・source区分を拒否                         | api-acceptance                       |
| A24 | 現在の取得条件を再実行し、新しい子を生成入力へ含める    | api-acceptance / client-corrections  |
| A25 | UTF-8 blobの実内容を範囲読取                            | api-acceptance / client-hardening    |
| A26 | 明示後継採用後の現在と旧構成を区別                      | api-acceptance                       |
| A27 | 子改訂・所属解除後も旧構成を再現                        | api-acceptance                       |
| A28 | receiptが失効しても保持snapshot・旧manifestで履歴を読む | api-acceptance / client-corrections  |
| A29 | 独立親は明示採用まで並存                                | api-acceptance                       |
| A30 | 偽後継・同時選択・循環・不完全captureを拒否             | api-acceptance / client-hardening    |
| A31 | 失効・purgeをref/cache/作業状態に反映                   | api-acceptance / client-hardening    |
| A32 | 無効cursor・索引未準備・走査限界の区別                  | api-acceptance / client-hardening    |
| A33 | 最終全入力＋出力予約のウィンドウ上限                    | api-acceptance                       |
| A34 | 自動取得・明示ツール・確定再試行の共有予算              | api-acceptance / client-hardening    |
| A35 | SQLite既存ID・版・出典・membership保持、再接続          | client-hardening                     |
| A36 | 原資料→Writer→質問→訂正→再読→旧構成                     | api-acceptance / examples/writer.mjs |

ファイル名はすべて`test/<名前>.test.mjs`です。ローカル検索量・隣接数・同時改訂を増やす測定と、同じ資料・モデル・総予算での「自動readなし / 履歴追記 / 記憶置換」の比較は`npm run evaluate`で再現し、`validation/local-evaluation.json`へ記録します。

この比較の自動指標は入力内の必要根拠、input tokens、旧情報の残留、条件本文です。モデル回答の意味品質をこの指標で代用しません。実LLMは`LLAMA_URL`を明示した別の実行で、応答も記録します。Qwen2.5-7B-Instruct Q4_K_Mによる合成資料の実行結果と、先行する小型モデル等の失敗例を検証記録へ保存しています。一般のモデル品質保証ではありません。

## 実モデルでの比較

0.2.1でQwen2.5-7B-Instruct Q4_K_M と同じ合成資料・総予算を使い、4ステップの実行を比較しました。以下はモデルへ送った入力の検査です。

| 経路                 | 入力 tokens 合計 | 必要な証拠を入力に含むステップ | 古い情報が入力に残ったステップ |
| -------------------- | ---------------- | ------------------------------ | ------------------------------ |
| 自動 read なし       | 810              | 0 / 4                          | 0                              |
| 履歴を追記           | 1,460            | 4 / 4                          | 2                              |
| 自動 read と記憶置換 | 1,052            | 4 / 4                          | 0                              |

今回の回答は採点していません。根拠のない参照や不正確な発言もあるため、入力に証拠があることを回答品質の合格として扱いません。[実応答と入力の記録](https://github.com/tako0614/atom-memory/blob/main/validation/corrections-live-evaluation.json)を公開しています。0.2.0時点の回答レビューは[過去の評価記録](https://github.com/tako0614/atom-memory/blob/main/validation/live-review.json)に残しています。

[ローカルモデルの起動手順](/runtime#ローカルモデルで動かす)に従い、同じ接続設定で `npm run evaluate:live` を実行できます。接続先を設定していないテストでは、実 LLM は実行しません。

## 測定範囲

ローカルの語彙検索は10・100・1,000・10,000件で、ID順の最後に置いた正解が先頭になることを確認しました。関係数10・100・300では続きから全件を取得し、同じ版への同時改訂2・8・32件では一件だけが確定しました。[0.2.1の測定値](https://github.com/tako0614/atom-memory/blob/main/validation/corrections-local-evaluation.json)は実行環境と併せて参照してください。

これらはローカル保存と取得の検証です。分散保存・ネットワーク分断・ANNの品質は対象外です。既存データの回帰条件 F01–F20 は [移行ページ](/migration#既存データと低水準-api-の回帰条件)にまとめています。
