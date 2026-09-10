# v0.2.1 修正・検証記録

実行日：2026-09-10（UTC）。公開の照合情報は [release.json](./release.json) に記録する。

- レビュー基準：`861995594d43ec37f01edcce1d06a328e8e2576d`
- 作業開始時のHEAD：`78d3e1567cbac4172f63900194caa74d324e047a`
- 修正commit：[`22f243f637a0f06ff18bc049243b1031bda513f4`](https://github.com/tako0614/atom-memory/commit/22f243f637a0f06ff18bc049243b1031bda513f4)

作業開始時にレビュー基準との差分を確認した。`src`、`test`、`package.json` に差分はなく、先行する変更はドキュメントと例だった。以下の3件は未修正だったため、公開APIを通した失敗試験を先に実行した。再生成、履歴保存、引用表示の順で実装し、全体回帰を実行した。

## 3件の修正前・修正後

| 問題                           | 修正前（両adapterで再現）                                    | 修正後（両adapterで確認）                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 所属変更後の再生成             | PにCを追加しても、生成入力にCがない                          | 保存された宣言的な取得計画を現在の読取状態で実行し直し、A・B・Cと現在の関係を生成器へ渡す。解除した関係から古い子を復活させない                    |
| 逐語引用の部分重複             | `[0,8)` と `[4,12)` の本文をそのまま送信し、`BBBB` を2回出力 | 同一原資料・同一版の検証済み逐語引用だけ共有証拠へ移す。`AAAABBBBCCCC` を1回出力し、両Atomの参照・引用範囲を保持。実際のハーネス入力でも重複しない |
| 共有された子を経由する履歴保存 | Pを置き換える際にBからQ側まで探索し、`HISTORY_INCOMPLETE`    | 読取状態と明示された構成計画を保持。Pの確定時にQ側の連結部分を列挙しない。保持履歴から当時の所属・子の版をページで再読する                         |

[修正前の6件の失敗ログ](./corrections-red.log)と[修正後の140件の成功ログ](./corrections-green.log)を保存した。生成器だけを入力記録mockに差し替え、保存、検索、関係取得、入力収集、パッキングは製品の実装を使っている。

## 変更したファイル

- 再生成と表示：`src/client/retrieval.ts`、`src/client/engine.ts`、`src/client/memory.ts`、`src/client/types.ts`
- 構成と保持：新規 `src/client/composition.ts`、`src/adapters/storage.ts`、`src/adapters/memory.ts`、`src/adapters/sqlite.ts`、`src/contracts.ts`
- ハーネス：`src/runtime/harness.ts`。ホストが承認した構成計画を後継操作へ渡す設定を追加
- 試験：新規 `test/client-corrections.test.mjs`、`test/api-acceptance.test.mjs`、`test/client-hardening.test.mjs`
- 実行例：新規 `examples/regeneration.mjs`、`examples/writer.mjs`
- 説明：`docs/adapters.md`、`docs/api.md`、`docs/concepts.md`、`docs/guide.md`、`docs/migration.md`、`docs/runtime.md`、`docs/release.md`
- サイト：`docs/.vitepress/config.mts`、`docs/.vitepress/theme/style.css`、`docs/index.md`。`docs/public/mark.svg` を削除し、ロゴと独自のオレンジ系配色を無彩色へ変更。コードの構文色は保持
- 版・検証：`package.json`、`package-lock.json`、`validation/README.md`、この記録と `corrections-*` の実行結果。公開照合用の `docs/public/release.json` と `validation/release.json` は公開時に更新

## 実行した回帰試験

| 検証                                         | 結果                                        | 保存先・条件                                                            |
| -------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `npm test`                                   | 140件成功、失敗・skipなし                   | Node 26.1.0。既存82件と追加58件                                         |
| `node --test test/*.test.mjs`                | 各140件成功、失敗・skipなし                 | Node 22.23.2 / 24.18.0。同じビルド済み実装                              |
| 追加29シナリオ                               | 各adapterで29件成功、計58件                 | 実 `MemoryStorage` / 実 `SqliteStorage(':memory:')`                     |
| SQLiteの旧データ・再接続                     | 成功                                        | ファイルDB。子改訂後にreceiptを消し、DBを閉じて再接続しても旧構成を再読 |
| `npm run docs:examples`                      | 12例を抽出・型検査・実行、記載出力5件を照合 | 公開APIと実例ファイル                                                   |
| `npm run docs:build`                         | 成功                                        | VitePress静的サイト                                                     |
| `npm run example` / `npm run example:writer` | 成功                                        | 基本例、決定的なWriterワークフロー                                      |
| `npm run format:check` / `git diff --check`  | 成功                                        | 型検査は各buildとdoc例でも実行                                          |
| 配布tarballを別プロジェクトへ導入            | 追加58件成功、consumer型検査成功            | パッケージの公開exportを利用、両adapter                                 |

コマンド結果とログのSHA-256は [corrections-checks.json](./corrections-checks.json) にある。

追加試験は、新規所属、retire・reviseによる解除、古い引用入力からの復活防止、空検索・空構成への追加、古いページ位置より前の追加、inspectの先頭からの再取得、生成中の改訂、予算不足、入力receiptとcache、旧計画なし、生成された子と原資料、blobの未対応診断を含む。

引用は、部分重複・包含、実際のハーネス入力、日本語、離れた範囲の省略表示、原文内の実際の繰り返し、別資料・別版・別要約、必須条件が入らない予算を検証した。履歴は、P/Qの共有子、深さ36の明示再帰と循環、取得計画の再利用、未知リンクの扱い、保持失敗のrollback、snapshot非対応時の局所manifest、後継の競合、権限失効とpurgeを検証した。

## 実LLMとmockの区別

実LLMも実行した。既にローカルにあった **Qwen2.5-7B-Instruct Q4_K_M** を **llama.cpp b10809 (`5266f24da`)** で起動し、localhostのアダプターから合成資料だけを渡した。外部サービスやコミュニティデータは使っていない。

- [実Writer結果](./corrections-live-writer.json)：ホストが段階を指定する3ステップの処理を完了。原資料の構造化、訂正、再読、旧構成の参照を実行。これは汎用の自律Writer評価ではない
- [実モデルの3方式比較](./corrections-live-evaluation.json)：同じ原資料・モデル・予算で各4ステップ実行
- [mockと規模の評価](./corrections-local-evaluation.json)：10 / 100 / 1,000 / 10,000件の無関係な資料、隣接数、同時改訂、3方式比較を実行

| 実モデルの方式     | 合計入力tokens | 必要な証拠を含む入力 | 古い情報が混入した入力 |
| ------------------ | -------------: | -------------------: | ---------------------: |
| 自動readなし       |            810 |                0 / 4 |                  0 / 4 |
| 履歴追記           |          1,460 |                4 / 4 |                  2 / 4 |
| 自動read＋記憶置換 |          1,052 |                4 / 4 |                  0 / 4 |

この表は**モデル入力**の検査であり、回答品質の採点ではない。生成された返答は記録に残している。根拠のない参照や不正確な発言もあり、比較を実行できたことを意味品質の合格として扱わない。動的な再生成の入力正しさは記録mockで検証し、その生成文の一般的な意味品質は未評価。

## 旧データ・履歴の互換性と制限

`read / search / inspect / write / edit`、自動read、記憶領域の置換、単一Atomモデルを維持した。手動ID・kind・schema・話題別spaceは新たに要求しない。既存のID、不変版、出典を変更・再採番せず、SQLiteのDDL変更も不要。

古いreceiptは監査記録のまま保持する。再取得計画のない旧派生物が失効した場合は `pending / missing-plan` とし、明示された原資料の固定版へ縮退する。元の意図を推定して自動再生成しない。移行はホストが現在の対象・取得条件を確かめて読み直し、新しい版を確定する。[移行例](../docs/migration.md)を参照。

既存の履歴manifestは引き続き読める。新しい外付け構成はホストの `composition` 計画を使う。一般のリンクだけから所属の向きは推定せず、不足時は `HISTORY_PLAN_REQUIRED`。通常の周辺探索は引き続き両方向で利用できる。

`MemoryStorage` の保持はインスタンスの寿命まで。`SqliteStorage` は再接続後も保持状態を利用できる。両者とも不変版を物理保持しており、保持登録時に連結成分を複製しない。履歴の期限と通常のcursor/receipt期限を分離した。期限後の物理GCは未実装。purgeは保守的に既存の保持snapshotをすべて失効させるため、削除対象に無関係な保持履歴も `HISTORY_EXPIRED` となる。削除・現在の閲覧許可を優先する。

snapshotを保持できないadapterでは、同じ構成計画から有限manifestを保存する。既定 `historyMaxAtoms = 256` または総予算を超える場合は `HISTORY_INCOMPLETE` とし、後継だけを公開しない。明示的に深い構成は固定深さで切らず、実際の取得は予算と続きを使う。

再取得が未完了、下位の派生物が失効、生成予算不足の場合はpendingまたはエラーを返す。blobを生成器へ渡す範囲アダプターは未実装で、メタデータだけから完了扱いしない（`unsupported-input`）。blobの実内容は既存の `inspect` 範囲取得で読める。共有引用の表示には `read.text` を使い、独自ハーネスで `items` の元本文を再追加しない。

外部の有料LLMサービス、分散保存・分散検索、新しいANN、汎用的な自律Writer、大規模な意味品質評価は今回未実施・対象外。mockの成功をそれらの実績に含めない。
