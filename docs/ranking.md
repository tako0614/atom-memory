# 活性と本文集合の選択

式、用語、取得・数値評価・選択の境界は[規範仕様](/specification#活性)が正本です。v0.8ではv0.7の本文一致、AvailabilityModel、伝播式を変更していません。searchは順位、readはその同じ活性を使う本文集合を返します。

## ホスト設定

```ts runnable
import { LocalAuthority, MemoryHost, adaptiveUse } from 'atom-memory';
const host = new MemoryHost({
  authority: new LocalAuthority(),
  activation: {
    model: adaptiveUse({ initialHalfLifeMs: 604800000, maxHalfLifeMs: 31536000000 }),
    maxBoost: 0.3,
    propagation: 0.5,
    relations: { condition: { forward: 2, reverse: 1 }, unrelated: { forward: 0, reverse: 0 } },
  },
  retrieval: { depth: 2, maxSeeds: 64, maxNodes: 512, maxEdges: 4096, maxScan: 10000 },
  defaults: { maxEvaluationWork: 500000, maxPackingWork: 2000000 },
});
```

role weightは伝播に作用します。requiredの本文提示や出典・生成・legacyの消去依存はweightで解除しません。role名から親/source等を推定して加点しません。

## 比較と限界

選択器は共通の閉包/render/cost評価器で順位順の基準解を作り、有界な限界利得探索と単一root解を比較します。規則と作業会計は[本文集合の選択](/specification#readの集合選択)を参照してください。`selection.baselineComplete` がfalseなら基準解との保証を成立済みと読まないでください。

`node scripts/evaluate-v08.mjs` は候補・活性・tokenizerを固定し、順位順の基準、v0.8、少数候補の全列挙を比較します。結果は `validation/selection-v0.8.0.json`。取得と認可は実装を使用し、比較器だけが固定済み取得状態へ直接接続します。公開API試験は別に `test/v08*.test.mjs` で実行します。

Uの改善は選択用代理目的の改善です。真の情報量、正答率、独立証拠数、一般的最適性、近似比を示しません。既存の意味評価や実LLM評価をv0.8の新規評価として数えません。Schur合成は[研究資料](/composition)として残し、既定評価器へ追加しません。
