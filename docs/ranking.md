# 一つの利用可能性規則で読む

Atomの本文・関係・版が記憶の正本です。読むときは、現在の入力と受理された利用から初期活性を作り、同じグラフの関係へ伝えます。親も子も関係Atomも同じ変数として扱い、共有された同じ版を複製しません。受理利用の状態から利用可能性を計算する規則は `AvailabilityModel` で選び、既定は `adaptiveUse()` です。

## 評価式

```text
uᵢ = model.value(stateᵢ, now)
bᵢ = mᵢ × (1 + β uᵢ/(1 + uᵢ))
a = b + Tᵀa
scoreᵢ = aᵢ / sum(a)
```

`m` は本文と現在の入力との一致、`u` はその主体・policy・観測版に対するモデルの利用可能性です。`T` は役割と方向の重みを始点ごとに正規化し、`propagation` を掛けた伝播です。出辺がなければ、その行は0です。入力がすべて0なら結果も0です。`u` は候補の発見や権限の代わりにはなりません。

既定の `adaptiveUse()` は `{ mass, updatedAt, halfLifeMs }` を保存します。新しいイベントでは現在の半減期でmassを減衰させて1を加え（最大1,000,000）、`halfLifeMs` を `initialHalfLifeMs × (1 - retainedFraction)` だけ伸ばします（最大 `maxHalfLifeMs`）。`value` は現在時刻までmassを減衰させた非負有限値を返します。初期半減期は7日、既定の最大半減期は365日です。この圧縮規則は間隔のある再利用を扱うための工学的近似であり、脳の再現や経験的に最適なパラメータではありません。

本文一致は **埋め込み80% + 語彙20%** で固定します。負のcosineは0、埋め込みがなければ利用できる語彙側へ正規化します。同じ入力種類は平均し、存在する種類間も等しく平均します。`query`・`context`・`thought`・`observations`・ホストの `signal` が対象です。`thought` は呼出し元が渡せる検討状態であり、モデル内部の非公開思考を取得しません。

`m` とグラフを固定した場合、利用の増幅は生の解にも `a_base <= a_use <= (1 + β)a_base` として伝わります。正規化後に全成分が増える保証はありません。`score` は今回の有限候補内の相対値で、真偽・権限・絶対的重要度ではありません。

## 設定するもの

```ts runnable
import { LocalAuthority, MemoryHost, MemoryStorage, adaptiveUse } from 'atom-memory';
const host = new MemoryHost({
  authority: new LocalAuthority(),
  storage: new MemoryStorage(),
  activation: {
    model: adaptiveUse({
      initialHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
      maxHalfLifeMs: 365 * 24 * 60 * 60 * 1000,
    }),
    maxBoost: 0.3,
    propagation: 0.5,
    relations: {
      condition: { forward: 2, reverse: 1 },
      example: { forward: 0.3, reverse: 0.1 },
      unrelated: { forward: 0, reverse: 0 },
    },
  },
  retrieval: {
    depth: 2,
    maxSeeds: 64,
    maxNodes: 512,
    maxEdges: 4096,
    maxScan: 10000,
  },
  defaults: { maxEvaluationWork: 500000 },
});
```

7日・365日・0.3・0.5は初期既定値で、意味品質の最適値という主張ではありません。設定はホスト作成時に固定します。任意のscore callback、入力種類の重み、semantic/lexicalの調整、反復数・収束許容値の設定はありません。独自の利用可能性を使う場合は `AvailabilityModel<S extends Json>` を実装して `activation.model` に渡します。`id` は意味とパラメータを含む設定identityとして扱います。

`forward` はリンク元から対象へ、`reverse` は対象からリンク元への比率です。未指定の役割・方向は1。重みは有限・非負、`propagation` は0以上1未満です。一つしかない出辺の重みだけを増やしても正規化後の比率は変わりません。`depth: 0` は関係の取得を止め、`propagation: 0` は取得済み本文の初期活性だけで評価します。

## 取得と評価の順序

1. 候補providerが参照を提案します。ライブラリが認可されたsnapshotの本文と保存済みベクトルを読み直し、`m` を計算します。providerのscoreや本文は採用しません。
2. 素の本文一致でseedを選び、鮮度と認可を検証して有限のグラフを取得します。staleなseedや中継ノードから活性は伝えません。
3. 取得済みの全ノードについて、自身の本文から `m` を計算します。構造探索で初めて見つけた内部Atomの直接一致も失いません。read中に不足する文書ベクトルを新規生成しません。
4. 一つの時刻で利用状態を読み、`b` を作ります。利用の増幅で候補集合や探索順を選び直しません。
5. 同じ活性式を評価し、`search` は順位を、`read` は本文・必須条件・出典を予算内で返します。

同じ始点・終点・役割の重複辺は一つです。別IDの関係Atomは別ノードなので、意味的に重複した関係Atomを増やせば順位は変わり得ます。通常の二項関係はリンクで表せます。関係自身に本文・出典・改訂などが必要な場合だけAtomにします。

## モデルが読んだ利用を記録する

`read()` だけではモデルへ何が渡ったか分からないため、利用は増えません。アプリは最終的にモデル要求へ載せた本文の参照を保持し、成功したモデル応答を確認した直後に、ホストから自動通知します。AI自身の選択操作や人間の承認は不要です。

```ts runnable
import { LocalAuthority, MemoryHost } from 'atom-memory';
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'reader',
  readPolicies: ['community'],
  writePolicies: ['community'],
  canIngestSource: true,
});
const binding = { auth, writePolicy: 'community', actor: { type: 'human' as const } };
const host = new MemoryHost({ authority });
const memory = host.connect(binding);
const atom = await memory.write('公開前には条件を確認する');
const recalled = await memory.read({ context: '公開前の条件' });
// 実際には、最終フィルタ後の本文・引用をモデルへ渡し、成功応答と現在性を確認してから呼ぶ。
const deliveredRefs = recalled.refs.filter((ref) => ref === atom.ref);
const use = host.recordUse(deliveredRefs, binding, { eventId: 'run-1:model:0' });
if (use.recorded !== 1) throw new Error('Expected one accepted use');
```

探索候補や伝播で触れただけのAtomは通知しません。パッキング後にアプリが本文を除いた場合、その参照も除きます。引用の本文を別のevidenceに載せた場合は、その参照を含めます。同じモデル要求の同じ観測版は一度だけ加算し、次の検索から反映します。

`recordUse(refs, binding, { eventId })` は `{ acceptedAt, recorded, repeated }` を返します。時刻と重みは外部入力にせず、サーバー受理時刻と固定重量1を使います。再試行では同じeventIdを使います。アプリは成功応答と未通知イベントを既存checkpointへ保存し、通知だけを再試行できるようにします。providerの処理後に通信が切れ、成功を観測できなかった要求まで記録できる保証はありません。read/searchだけでは `update` は呼ばれません。

利用状態は `(subject, policy, revisionId)` ごとです。認証handle更新後の保存済み参照も、同じsubjectと現在の読取権限を満たす場合だけ通知できます。これはhost-only操作に限り、通常のread・inspect・editの参照認可は緩めません。旧観測版の利用は後継版へ継承せず、purge対象の利用状態と再試行記録も同時に削除します。

モデルIDを変えた場合、既存状態を別の意味へ変換しないため `STATE_INVALIDATED` です。`host.resetUse(binding)` でその主体と現在選択したpolicyの集計を明示リセットします。古い通知の二重加算を防ぐ記録は残します。`maxBoost` や伝播の設定を変えても、利用状態のモデルIDが同じなら状態のresetは不要ですが、既存cursorは設定identityの変更で失効します。

## 数値予算と再利用

評価器は `d = b + Tᵀa − a` という符号付き残差を補正します。文脈・利用・グラフが変わっても同じ処理で補正し、負の差も扱います。前の未正規化の活性は、有界のプロセス内cacheにだけ保持します。毎回現在の認可・鮮度・ノード・辺を取得し直し、同じ版の値だけを初期値として使います。cacheを捨てても十分な予算で同じ解へ収束します。

数値作業の既定予算は `maxEvaluationWork: 500000`。初期化と最終誤差確認すらできなければ `BUDGET_EXHAUSTED`、補正の途中で予算が尽きれば有限な近似結果を返します。

| 診断                      | 意味                                             |
| ------------------------- | ------------------------------------------------ |
| `evaluatedAt`             | 利用状態を固定した時刻                           |
| `evaluationConverged`     | 正規化L1誤差の上限が1e-6以下になったか           |
| `numericErrorL1Upper`     | 実際に取得した固定グラフ上の正規化L1数値誤差上限 |
| `stop: 'numeric-budget'`  | 補正予算内で数値目標へ達しなかった               |
| `usage.maxEvaluationWork` | 課金した数値作業量。壁時計時間ではない           |

この数値上限は、実際に保存した丸め後の遷移係数に対するものです。propagationが1に極端に近く、外向き丸めで収縮を確認できない場合や、中間計算が非有限になる場合は入力を拒否します。候補の取り逃し・未取得の辺・Writerの意味的な誤りは、この誤差に含みません。`coverageCertified` は常にfalseです。十分な予算がないwarm評価には古い入力の影響が誤差範囲内で残り得ます。

モデル実装の失敗は安全に隠しません。`update` または `value` が例外を投げる、Promiseを返す、無効なJSON状態を作る、非負有限でない値を返す場合は操作を失敗させます。利用可能性を0にして処理を続けるフォールバックはありません。モデルのcallbackへ最終score、query/context、候補グラフ、全履歴は渡しません。

cursorには完成した候補順・score・評価時刻を固定します。途中で利用が増えても同じcursorを再評価しません。追加予算で評価し直す場合は新しいread/searchを始めます。必要な条件・権限・出典・purgeの検証は、活性やcacheによって省略しません。

## 検証と研究の範囲

<<< ../examples/ranking.mjs

```text output:ranking.mjs
本文が一致しない条件も取得: true
関係を通じて取得: true
```

`npm run evaluate:ranking` は、同じ本文・固定ベクトル・予算で関係による根拠取得を比較します。利用の長期的な品質改善や実モデルの費用削減は、この試験からは判断しません。

[合成評価](/composition)の内部消去・復元は研究用です。0.7の通常評価器は上の残差補正であり、Schur前処理を既定にしていません。研究内のv0.5 PPR比較は凍結した参照実装を使います。独自性の主張には、本文取得・更新・cacheの検証まで含む同条件の実測が必要です。
