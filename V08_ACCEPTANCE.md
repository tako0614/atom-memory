# Atom Memory v0.8 受入条件の対応表

基準: `a2f3c59098ba7f6a46ffd3903d2fc14fa43335f5` (0.7.0)。計画: `V08_PLAN.md`。意味の正本: `docs/specification.md`。この対応表だけを合格記録とせず、コマンドと結果を `validation/v0.8.0.md` に分けます。

| ID     | シナリオ                   | 決定的試験                                                                                         |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------- |
| V08-01 | 内容だけで五操作           | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-02 | 親・共有・任意関係         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-03 | 読取の副作用分離           | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-04 | observedとlogical          | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-05 | 原子的編集・CAS            | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-06 | 未使用と最大利用補正       | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-07 | 無関係な高頻度情報         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-08 | 時計と反復                 | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-09 | cold/warm一致              | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-10 | 不正な利用状態モデル       | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-11 | 数値打切りと取得上限       | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-12 | 長い上位説明と短い本文集合 | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-13 | 説明本文自体が答え         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-14 | 共有required               | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-15 | 深いrequiredと循環         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-16 | 予算に入らないrequired     | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-17 | 引用の重なり・包含         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-18 | 非同義・別資料             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-19 | 同一引用クラス             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-20 | 費用と作業上限             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-21 | 小規模oracle               | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-22 | 12候補と1提示              | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-23 | 送信前filter               | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-24 | 独立生成の一括commit       | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-25 | 同一生成A/B                | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-26 | 持越し作業状態             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-27 | 選択への間接影響           | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-28 | 偽造・scope・期限token     | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-29 | historicalとcurrent watch  | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-30 | tokenなしlegacy edit       | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-31 | 通常関連の独立本文         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-32 | 生成依存の消去             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-33 | required消失とinspect      | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-34 | 認可されない参照先         | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-35 | 新旧混在の消去             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-36 | 消去失敗・再開             | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-37 | 成功ackと再送              | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-38 | reset・主体・版            | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-39 | cursorと時間・required     | `test/v08.test.mjs` (Memory / SQLite)                                                              |
| V08-40 | packageと旧0.7移行         | `test/v08-package.test.mjs` + `scripts/check-v08-migration.mjs` + `scripts/check-v08-consumer.mjs` |

全シナリオは実取得・認可・保存・選択を使います。観測した原記録の確認にはStorageAdapterの読取も使い、認可や取得を別実装へ置き換えません。モデル応答だけは決定的stubです。

基準との比較は `scripts/evaluate-v08.mjs`。同じ固定済み取得状態へ基準とv0.8選択器、共通renderによる全列挙を接続します。Uの差、必要本文の閉包、最終費用、作業量、latencyを記録します。実LLM品質、意味検索品質、新規性の証明は別測定です。
