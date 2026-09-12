# 受入条件と検証

ライブラリの保存・検索の正しさと、Agentの意味理解は分けて検証します。

## ライブラリ

`npm run check` は型検査、Memory/SQLiteでのテスト、構造取得の比較、Docsのサンプル実行、サイトビルドを行います。

| 対象                                                                  | 主なテスト                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| 不変版、多重所属、原子編集、CAS、出典、purge                          | `test/acceptance.test.mjs`                                    |
| readが生成・暗黙の原資料置換を持たず、staleから明示改訂で復帰すること | `test/boundary.test.mjs`                                      |
| 必須条件と重なる引用の実際の本文                                      | `test/client-corrections.test.mjs`                            |
| スコープ、cursor、取消、保存互換                                      | `test/client-hardening.test.mjs`                              |
| 埋め込みと関係による取得、staleからの伝播禁止、ノード上限と辺取得     | `test/ranking.test.mjs`                                       |
| own-body索引、旧ベクトルの条件付き再利用、旧進捗の不採用、再開        | `test/index-maintenance.test.mjs`                             |
| 遅いID位置の一致を取得する既定候補入口、削除索引                      | `test/lexical-candidates.test.mjs` / `test/sqlite-*.test.mjs` |

`npm run evaluate:ranking` は同じ本文・固定ベクトル・同じ上限で、正しい構造・構造探索なし・同数の誤った関係を比較します。小さな決定的fixtureで取得の因果を分離する試験です。重複した意味をWriterが正しく整理するか、全コーパスの最適順位かは、この試験では主張しません。

## Agentと実モデル

Sakana側の `scripts/check-memory-refresh.mjs` は、古いAtomの通知、再処理の重複防止、実際のWriter実行経路、サーバー分離、モデル呼出しごとの記憶入替を検証します。モデルは決定的な応答を使います。

`check-memory-writer.mjs` と `check-agent-runtime.mjs` は保存障害後の再開、出典変更、モデル失敗、ツールの継続を検証します。Writerが実際に採用した生成記憶について、生成中の変更拒否・checkpoint再開・明示リンクなしの依存保存・訂正後の失効も確認します。実モデルとの接続はSakanaの `check-memory-writer-live.mjs` と `check-memory-embedding-live.mjs` が所有し、設定したモデルと予算で別に実行します。

0.4以前の `validation/*.json` は当時の環境・契約での履歴記録です。旧Harnessの実行結果を0.5の検証済み結果へ読み替えません。質問を見せずにWriterが構造を作れるか、構造が同じ費用で検索・回答を改善するかは、それぞれ別の品質評価です。
