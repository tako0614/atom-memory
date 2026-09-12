# 関係とベクトルで順位を決める

Atomは同じ形式のノードと役割付きリンクからなるグラフです。木に限定せず、複数のまとまりへの所属、再帰的なまとまり、一般リンクの循環を表せます。重要度はLLMに毎回採点させず、今回の入力との近さと、そこからつながる関係で計算します。

## 計算の流れ

1. `query`・`context`・`thought`・`observations`・ホストの `signal` ごとに関連度を計算します。本文の一致と埋め込みのcosine類似度を使います。
2. 候補の上位をseedとし、許可されたsnapshot内で正引き・逆引きの関係を集めます。
3. 役割と方向の重みに従って関連度を伝播し、順位を確定します。
4. `search` はこの順位で返します。`read` と自動readは同じ順位から本文・出典・必須条件を予算内に詰めます。

`inspect` は指定した参照と関係を直接読む操作です。ランキング設定で実際の関係を隠したり、順位を付け直したりしません。

## 類似度と伝播

各入力の類似度は、既定で **埋め込み80% + 語彙20%** です。cosineは負数を0にします。埋め込みがない場合は利用できる語彙側へ正規化します。明示的に語彙の重みを0にすると語彙による代用も無効になります。

同じ種類の入力は平均し、種類間をホスト指定の重みで平均します。観測を大量に追加しても、観測という種類の重み自体は増えません。既定は各種類1です。`thought` は呼出し元が渡す明示的な検討状態であり、モデル内部の思考を取り出す機能ではありません。

seedの合計を1に正規化した値を `s`、各ノードから出る重みを合計1に正規化した遷移を `P` とすると、計算は次のとおりです。

```text
r₀ = s
rₖ₊₁ = (1 − α) s + α (Pᵀ rₖ + danglingMass × s)
α = 0.5
```

行き先のないノードの値はseedへ戻します。複数経路の寄与は合算し、同じ始点・終点・役割の重複リンクは一回として数えます。異なる役割はそれぞれの重みを持ちます。循環もこの有限の反復で扱います。

`scoreBreakdown.direct` は最後の反復のseed項、`structural` は伝播項で、合計が `score` です。行き先のない値の再配分も `structural` に含みます。信頼度や正しさの確率ではありません。LLMへ渡す `read.text` に採点用の数値は追加しません。

## 設定

```ts runnable
import { LocalAuthority, MemoryHost, MemoryStorage } from 'atom-memory';
const host = new MemoryHost({
  authority: new LocalAuthority(),
  storage: new MemoryStorage(),
  ranking: {
    signals: { context: 2, thought: 1, observations: 1 },
    semantic: 0.8,
    lexical: 0.2,
    propagation: 0.5,
    relations: {
      condition: { forward: 2, reverse: 1 },
      example: { forward: 0.3, reverse: 0.1 },
      unrelated: { forward: 0, reverse: 0 },
    },
    depth: 2,
    maxSeeds: 64,
    maxNodes: 512,
    maxEdges: 4096,
    maxIterations: 32,
    tolerance: 1e-6,
  },
});
```

`forward` はリンクを持つAtomから対象へ、`reverse` は対象からリンク元へ進む重みです。未指定の役割・方向は1。0の方向には伝播しません。重みは有限の非負値、`propagation` は0以上1未満です。`depth: 0` は構造探索を止めます。`propagation: 0` はseedのみの順位です。

## 有限の探索とページング

最大64 seed、512ノード、4096リンク、深さ2、32反復またはL1差分1e-6で打ち切ります。加えて各操作の予算を守ります。候補取得には残り候補数・bytesの半分まで、関係取得にはその後の残りの半分までを使い、本文返却に予算を残します。上限へ達した部分グラフでも順位を確定し、`diagnostics.approximate` で近似を示します。`maxScan` は一つの検索全体の候補走査上限です。

最初の結果の前に順位を固定します。cursorは固定した候補の次ページを返し、後から候補を増やして順位を変えません。`complete` はこの有限結果の返却完了を表し、全資料の網羅を意味しません。本文一件を返す予算もなければ `BUDGET_EXHAUSTED` です。cursorのsnapshot・権限・検索設定・索引世代の変更は検証されます。

`required` な条件・証拠は通常の順位とは別の採用条件です。主張と必須本文を一緒に収められない場合は、その主張を返しません。重要そうなノードからアクセス権を越えて情報を取得することもありません。

## 動く例と検証

<<< ../examples/ranking.mjs

```text output:ranking.mjs
本文が一致しない条件も取得: true
構造からの寄与: true
```

`npm run evaluate:ranking` は同じ本文・固定ベクトル・予算で、正しい関係、構造探索なし、同数の誤った関係を比較します。構造による取得の因果を調べる試験で、LLM Writerが実際の履歴を正しく構造化する品質評価とは分けています。
