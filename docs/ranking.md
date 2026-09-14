# 活性と本文集合の選択

式、用語、取得・数値評価・選択の境界は[規範仕様](/specification#活性)が正本です。v0.9.0ではv0.8までの本文一致、AvailabilityModel、伝播式を変更していません。searchは順位、readはその同じ活性を使う本文集合を返します。inspectは一-hopのgraph調査で、選択のdepthとは別です。

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

`node scripts/evaluate-ranking.mjs` は候補・活性・tokenizerを固定し、順位順の基準とv0.9の選択を比較します。結果は `validation/ranking-v0.9.0.json`。`node scripts/evaluate-v08.mjs` は名前を維持した歴史的なselection harnessで、現行結果を `validation/selection-v0.9.0.json` に出力します。取得と認可は実装を使用し、比較器だけが固定済み取得状態へ直接接続します。v0.8のJSONとvalidationは過去版の基準として保存し、現行の公開品質へ読み替えません。

Uの改善は選択用代理目的の改善です。真の情報量、正答率、独立証拠数、一般的最適性、近似比を示しません。既存の意味評価や実LLM評価をv0.9.0の新規評価として数えません。Schur合成は[研究資料](/composition)として残し、既定評価器へ追加しません。
