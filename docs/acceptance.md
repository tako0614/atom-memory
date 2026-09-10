# 受入条件と検証

v0.2はA01–A36を新しい公開APIとハーネスで検証します。旧F01–F20はKernelと明示的なLegacyAgentHarnessの回帰試験として維持します。テストの追加と実行結果を区別し、実施したコマンド・環境・未実行項目はリポジトリの`validation/README.md`に記録します。

| ID  | 新APIで確認する条件                                | テストファイル                       |
| --- | -------------------------------------------------- | ------------------------------------ |
| A01 | 分類・手動IDなしの5操作                            | client                               |
| A02 | 同文の独立入力は別source                           | client / api-acceptance              |
| A03 | 確定後の応答喪失でも同じ操作を再送                 | client-hardening                     |
| A04 | refからCASを自動設定、競合拒否                     | client                               |
| A05 | 未知schema・任意関係を探索                         | api-acceptance                       |
| A06 | 役割交換・三者・繰り返し保持                       | api-acceptance                       |
| A07 | ID順後方の正解、有限走査の続き                     | api-acceptance / client-hardening    |
| A08 | 埋め込み設定下の語彙入口、索引準備の続き           | api-acceptance / client-hardening    |
| A09 | ID変更で非同点の順序が変わらない                   | api-acceptance                       |
| A10 | 明示検索なしで自動read                             | api-acceptance                       |
| A11 | 18ステップ、記憶置換・観測上限・監査容量           | client-hardening                     |
| A12 | 話題変更で以前の自動取得本文を再投入しない         | api-acceptance                       |
| A13 | 問いと仮説の両方の信号を保持                       | api-acceptance                       |
| A14 | thoughtなし、入力なしと0件の区別                   | api-acceptance                       |
| A15 | 同じ次元の異なる空間、偽造signalを拒否             | api-acceptance                       |
| A16 | モデルのsearch/inspectの続きをホストが再開         | api-acceptance                       |
| A17 | 出典重複を実際の最終packで除去                     | api-acceptance                       |
| A18 | 同じ出典の異なる要約は残す                         | api-acceptance                       |
| A19 | 必須条件の本文、失効した条件の主張を省く           | api-acceptance / client-hardening    |
| A20 | 循環・高次数を有限ページで取り切る                 | api-acceptance / client-hardening    |
| A21 | 本人だけがprivate draftを読める                    | client / Writerサンプル              |
| A22 | CAS・新規挿入競合・abort、callback一回             | client / api-acceptance              |
| A23 | モデルの偽ref・source区分を拒否                    | api-acceptance                       |
| A24 | 子改訂・新規関係の失効、明示生成器と原資料への復帰 | api-acceptance                       |
| A25 | UTF-8 blobの実内容を範囲読取                       | api-acceptance / client-hardening    |
| A26 | 明示後継採用後の現在と旧構成を区別                 | api-acceptance                       |
| A27 | 子改訂・所属解除後も旧構成を再現                   | api-acceptance                       |
| A28 | receiptを除いても不変manifestで履歴を読む          | api-acceptance                       |
| A29 | 独立親は明示採用まで並存                           | api-acceptance                       |
| A30 | 偽後継・同時選択・循環・不完全captureを拒否        | api-acceptance / client-hardening    |
| A31 | 失効・purgeをref/cache/作業状態に反映              | api-acceptance / client-hardening    |
| A32 | 無効cursor・索引未準備・走査限界の区別             | api-acceptance / client-hardening    |
| A33 | 最終全入力＋出力予約のウィンドウ上限               | api-acceptance                       |
| A34 | 自動取得・明示ツール・確定再試行の共有予算         | api-acceptance / client-hardening    |
| A35 | SQLite既存ID・版・出典・membership保持、再接続     | client-hardening                     |
| A36 | 原資料→Writer→質問→訂正→再読→旧構成                | api-acceptance / examples/writer.mjs |

ファイル名はすべて`test/<名前>.test.mjs`です。ローカル検索量・隣接数・同時改訂を増やす測定と、同じ資料・モデル・総予算での「自動readなし / 履歴追記 / 記憶置換」の比較は`npm run evaluate`で再現し、`validation/local-evaluation.json`へ記録します。

この比較の自動指標は入力内の必要根拠、input tokens、旧情報の残留、条件本文です。モデル回答の意味品質をこの指標で代用しません。実LLMは`LLAMA_URL`を明示した別の実行で、応答も記録します。Qwen2.5-7B-Instruct Q4_K_Mによる合成資料の実行結果と、先行する小型モデル等の失敗例を検証記録へ保存しています。一般のモデル品質保証ではありません。

## 旧APIの回帰条件

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
