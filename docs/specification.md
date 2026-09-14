# Atom Memory v0.9.0 規範仕様

> 内容と関係を版付きで保存し、文脈と受理された利用から一つの規則で活性を計算し、必要な条件を欠かさない本文集合を予算内で返す。

この文書を現在の意味の正本とする。MUSTは必須。v0.8の実行結果は `validation/v0.8.0.md` に分け、v0.9の決定的な実行結果は `validation/v0.9.0.md` とする。過去の計画、研究資料、隣接アプリの試験は実装済み・公開済み・実LLM品質の証明ではない。

## 形式と責務

通常APIは `write`、`search`、`inspect`、`read` である。IDとrevisionはライブラリが発行し、不変版を保存する。Atomは本文・links・sources・provenance・stateを持つ一つのaddressableな情報で、親子・多重所属・n項関係・循環を同じ形で表せる。role名から親、出典、削除、重要度、後継を推測してはならない。

`read`、`search`、`inspect` は本文・意味links・利用状態を変更しない。索引と観測記録は補助状態である。`write` は宣言された有限batchだけを検証して原子的に保存する。モデル呼出し、入力構成、Writer、費用、ジョブ、後継採用はホストまたはアプリの責務であり、Coreは自動read、モデルloop、スケジューラーを持たない。

### write batch

`write({ changes }, options)` の `changes` は空でない配列で、各changeの `id` はbatch内で一意である。

```ts
type CreateChange = {
  id: string;
  op: 'create';
  content: { text: string; links: Links };
  sources: readonly SourceCitation[];
  input?: InputToken;
};
type ReviseChange = {
  id: string;
  op: 'revise';
  target: AtomRef;
  content: { text: string; links: Links };
  sources: readonly SourceCitation[];
  input?: InputToken;
};
type RetireChange = { id: string; op: 'retire'; target: AtomRef; input?: InputToken };
```

create/reviseの `content.links` と `sources` は完全置換で、空でも必ず明示する。revise/retireの `target` は発行済みの観測版であり、同じlogical Atomを一つのbatchで二度変更できない。retireは元のbody・links・sources・originsを保存したままstateだけをretiredへ改訂する。

リンクのtargetは既存 `AtomRef`、`{ ref, at?: 'logical' | 'observed', required?, orderKey? }`、またはbatch-localな `{ local: changeId, at?, required?, orderKey? }` である。local targetは全changeのrevisionを先に割り当ててから解決するため、前後参照・循環・同じneighborへの複数roleを許可する。local idはcommit後に解決可能な参照ではない。通常graphに新しい階層roleを暗黙に導入しない。

`WriteOutcome` は `{ operationId, repeated, indexing, changes }` であり、`changes` はchange idから確定した `AtomView` へのRecordである。batchは全件commitされるか、入力、権限、CAS、budget、dependency検証の失敗で全件commitされないかのどちらかである。

### 入力tokenとactor

`host.observe(input, binding)` が発行する `InputToken` はhost-issuedの不透明なscope-bound値である。agent bindingの各change MUSTがtokenを持つ。humanとinput-adapterのchangeはtokenを省略できる。任意文字列、receipt型の偽装、別主体・別policy・別認可世代・期限切れ・purge済みtokenは受け付けない。tokenはmodel tool schemaへ公開しない。

`HostInput` は `presentations`、`sources`、`inherit`、`basis`、`watches`、`payloadDigest` を持つ。ホストは最終payload、外部tool結果、持越し状態を申告する境界を負うが、敵対的ホストやモデル内部の不可観測な状態まで完全に追跡できるとは限らない。inheritした依存とwatchはscope変更やhistorical指定で消えない。独立token A→a、B→bは同じbatchに含めても相互にstaleにならず、同じtoken A+Bから出したchangeは両入力へ依存する。tokenなしagent changeのlegacy依存は全batch入力へ保守的に残す。

### idempotency

`idempotencyKey` はsubject、write policy、actor、現在のpurge/auth境界とplanのsemantic fingerprintに束縛される。同じkeyで同じplanを再送すると、同じ `operationId` と現在認可できる結果を `repeated: true` で返す。planを変えた再送は `IDEMPOTENCY_CONFLICT`。最初のcommitでは期限切れtokenを拒否するが、commit済みplanの一致replayはtokenが後から期限切れになっても保存済み結果を回収できる。replay時も現在の認可とpurgeは検証し、読めない・消去済みの結果を復活させない。

## 活性

v0.8までのown-body embeddingと本文一致（semantic 80%、lexical 20%、欠けた信号の扱いを含む）を維持する。

```text
u_i = AvailabilityModel.value(state_i, evaluatedAt)
b_i = m_i * (1 + beta * u_i / (1 + u_i))
a = b + T^T a
score_i = a_i / sum(a)
```

Tは許可済み・現在性を満たす取得graph上の非負重みを出辺正規化し、propagation < 1を掛ける。出辺なしは0行。利用補正は候補取得順を変えない。source/親/古さ専用の追加採点は禁止する。scoreは同じ評価内の相対値で、真偽・確率ではない。

AvailabilityModelの `id`、同期 `update` / `value`、JSON 1 KiB上限、有限非負値、例外・Promise・不正値の失敗伝播、subject/policy/revision隔離、eventId dedup、明示resetは継続する。成功したモデル応答をhostが `recordUse` したときだけ利用状態を更新し、read/search/inspectだけでは増やさない。

## versioned manifest

contractVersion=2のmanifestは次を区別する。旧 `reads` / `currentReads` / `observations` は保存adapter向けの互換投影であり、独立した意味ではない。

| 部分              | 意味                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `acquisition`     | 取得・検証・選択で触れた版、範囲、query観測、索引状態                     |
| `presentation`    | 表示版、最終digest、実際の本文単位・範囲・対応refs                        |
| `generation`      | hostが確定したpresentation、外部原資料、継承token、payload digest、出力版 |
| `watches`         | 現在性を要求するheadとquery観測                                           |
| `acknowledgement` | hostが成功を受理したevent。再送は同じeventId                              |

`sources` は明示した原資料範囲であり、通常linksの取得候補やcitationだけの原資料全文提示と同義ではない。`InputToken` は作成時に入力とoutputを結び付けるが、引用リストを狭めて依存を偽装する機能ではない。

## links、stale、retire、purge

| 記録                 | 伝播              | 本文同時提示       | 消去依存                     |
| -------------------- | ----------------- | ------------------ | ---------------------------- |
| 通常links            | 設定したrole/方向 | なし               | 新契約ではなし、legacyはあり |
| `required`           | 通常linksと同じ   | required閉包を要求 | flagだけでは追加しない       |
| 出典範囲             | 明示citationのみ  | 追跡可能な引用情報 | あり                         |
| 生成・継承・選択入力 | なし              | なし               | あり                         |
| 利用event            | なし              | なし               | 本文導出依存にはしない       |

`stale` は宣言した現在性が崩れた状態、`blocked` は必須本文を今回返せない状態、`retire` は現在readから外すrevision、`purge` はアクセス停止と保存物消去であり、同義ではない。通常link先が不許可・欠損ならそのedgeは伝播せず、公開 `AtomLink` は `{ role, unavailable: true, required, at, orderKey? }` という安全な形を使う。利用不可形にtarget ID、本文、具体的理由を載せない。inspectは認可された元本文を調べられるが、read適格性の証明にはならない。

retireは元のbody・sources・linksを保存し、既に利用不可の通常linkも黙って削除しない。この例外で新しいtargetや本文を追加してはならない。purgeは全履歴の出典・生成入力・継承・選択入力とlegacy linksを逆引きする。role名や本文から旧依存を推測して狭めない。未完了時は停止markerを永続化し、公開read/writeを拒否して同じatomIdで再開する。

## inspect

inspectは一-hopのbounded operationである。既定値は `version: 'observed'`、`direction: 'both'`、`limit: 20`。`direction` は incoming/outgoing/both、`roles` はrole filter、`limit: 0` はrootのみ、cursorはneighbor page、`range` はblobのbyte範囲である。inspectには `depth` や `items` はなく、返り値は `atom`、`neighbors: [{ atom, via: [{ direction, role, at, required, orderKey? }] }]`、`receipt`、`readEligibility`、`stale`、`diagnostics`、`usage` を持つ。logical targetは現在head、observed targetは指定revisionへ束縛する。

## readの集合選択

候補、活性、snapshotを固定する。root集合Sのrequired最小閉包C(S)はpinned revisionを一度だけ訪問し、循環を有限に処理する。requiredが欠損・不許可・staleならrootをblockedとし、ref名だけで本文提示済みにしない。read/searchは `depth` と件数を受け取るが、inspectの一-hop制約とは別である。

`cost(S) = tokenizer.count(render(C(S))) <= memoryTokenBudget`。共通required本文は一度だけ表示し、同一原資料・版・範囲の検証済み引用だけをevidenceとして費用共有する。itemsの本文を `text` へ重ねず、scoreや監査logをmodel textへ入れない。表示formatVersionは2。

選択は順位順の閉包packerを基準解とし、限界利得 / 限界費用で実行可能rootを追加する。有界budgetで未完了なら保持した解と `selection.baselineComplete: false` を返す。Uは選択用代理目的であり、正答率、真の情報量、独立証拠数、一般的最適性、近似比ではない。`coverageCertified` は常にfalse。

## cursor、診断、互換性

最初の操作でsnapshot、binding、索引、query、活性設定、利用状態、evaluatedAt、取得graph、数値評価を固定する。search/read/inspectのcursorはquery・options・認可・索引・設定に束縛され、変更時は失効する。diagnosticsの `acquisition`、`validation`、`evaluation`、`selection` を分け、数値誤差は取得graphだけに限定する。

旧v0.8の `edit` / `Draft` は現在の公開APIへ互換層として残さない。過去manifest・validation・researchは歴史資料としてlegacy解釈し、role名や引用から依存を縮小しない。過去版cursorは失効させて新しい操作から始める。公開、再デプロイ、利用者DB消去、実LLM品質評価はこの仕様の実行結果に含めない。
