# Atom Memory v0.8 規範仕様

> 内容と関係を版付きで保存し、文脈と受理された利用から一つの規則で活性を計算し、必要な条件を欠かさない本文集合を予算内で返す。

この文書を意味の正本とする。MUSTは必須。実行結果は `validation/v0.8.0.md` に分ける。基準は `a2f3c59098ba7f6a46ffd3903d2fc14fa43335f5` (0.7.0)。計画は実装済みの証明ではない。

## 形式と責務

通常APIは `write/search/inspect/read/edit`。入力は文字列または `{text, links}`。IDと版は自動発行し、不変版を保存する。親、多重所属、n項関係も同じAtom。role名から出典・削除・重要度を推測してはならない。observedは指定版、logicalは読取snapshotのhead。inspectは指定版を別Atomで代替しない。

read/search/inspectは本文、意味links、利用状態を変更しない。索引と観測記録は補助状態。editは有限変更を原子的に保存し、失敗時にcallbackや外部処理を再実行しない。生成単位のIDとcommit IDは異なる。モデル呼出し、入力構成、Writer、費用、ジョブ、後継採用はホスト所有。Coreは自動read、モデルloop、スケジューラーを持たない。

## 活性

v0.7のown-body embeddingと本文一致 (semantic 80%、lexical 20%、欠けた信号の扱いを含む) を維持する。

```text
u_i = AvailabilityModel.value(state_i, evaluatedAt)
b_i = m_i * (1 + beta * u_i / (1 + u_i))
a = b + T^T a
score_i = a_i / sum(a)
```

Tは許可済み・現在性を満たす取得グラフ上の非負重みを出辺正規化し propagation < 1 を掛ける。出辺なしは0行。利用補正は候補取得順を変えない。source/親/古さ専用の追加採点は禁止。scoreは同じ評価内の相対値で、真偽・確率ではない。

AvailabilityModelのid/update/valueは同期、有界JSON (1 KiB)、有限非負値。Promise、例外、不正値は明示エラー。主体・policy・版を隔離し、モデルID変更は明示reset。acceptedAtは受理時刻、evaluatedAtと数値反復は別。recordUseは成功した要求への露出を記録する。同じeventIdと版は一度、reset後もdedupを保持。成功は正答の証明ではない。

## 一つのversioned manifest

contractVersion=2のmanifestは次を区別する。旧reads/currentReads/observationsは保存adapter向けの消去依存/現在性の互換投影であり、独立の意味ではない。原資料のreadsは出典依存で、通常リンクの検証を含むacquisitionと必ずしも一致しない。

| 部分            | 意味                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| acquisition     | 取得・検証・選択で触れた版、範囲、query観測 (空結果含む)、索引状態                           |
| presentation    | 表示版、最終digest、実際の本文単位・範囲・対応refs。citationだけの原資料は本文提示に数えない |
| generation      | ホストが確定したpresentation、外部原資料、継承token、payload digest、出力版                  |
| watches         | 現在性を要求するheadとquery観測                                                              |
| acknowledgement | ホストが成功を受理したevent。再送は同じeventId                                               |

host.observe(input, binding)はモデルを呼ばず不透明なInputTokenを発行する。inputはpresentations (receiptと任意の実送信refs)、sources (確定済み原資料範囲)、inherit (持越しtoken)、basis (current/historical)、watches (追加receipt)、payloadDigestを持つ。digestはホストが確定したpayloadのSHA-256。省略したrefsはそのpresentationの全本文単位。検索で触れた全候補を提示したとは記録しない。ただし使用した選択のacquisitionは生成の消去・監査依存へ保守的に継承する。

WriteOptions.inputはホストdispatcherだけが注入する。通常tool schemaへ出さない。未発行、期限切れ、別主体・scope・認可世代、purgeした入力を拒否する。入力tokenは引用リストで縮小できない。inheritの依存とwatchは新scopeやhistorical指定でも消さない。信頼したホストが全payload、外部tool結果、持越し状態を提示することが境界であり、敵対ホストやモデル内部の完全な情報流追跡は保証しない。

独立token A→a、B→bは同一editで保存できる。Aの改訂は同じcommitという理由でbをstaleにしない。同じtoken A+Bから作る全出力は両入力に依存する。tokenなしagent editは全edit入力へのlegacy依存を残す。

token付き・なしが混在したeditでは、tokenなし出力だけがtoken経由を含む全edit入力へ保守的に依存する。明示inheritした生成の保存出力も消去依存に含め、同じcommit内の保存後に正確な版を結び付ける。acquisitionだけの入力は監査・消去に残し、宣言していない現在性を自動追加しない。historicalとcurrent watchが同じ版に重なる場合はwatchを優先する。

## 辺と利用状態

| 記録                 | 伝播              | 本文同時提示       | 消去依存                                 |
| -------------------- | ----------------- | ------------------ | ---------------------------------------- |
| 通常links            | 設定したrole/方向 | なし               | legacyはあり、新しい検証済み契約ではなし |
| required             | 通常linksと同じ   | 再帰閉包を要求     | フラグだけでは追加しない                 |
| 出典範囲             | 明示linkのみ      | 追跡可能な引用情報 | あり                                     |
| 生成・継承・選択入力 | なし              | なし               | あり                                     |
| 利用イベント         | なし              | なし               | 本文の導出依存にはしない                 |

staleは宣言した現在性が崩れたこと。blockedは必須本文を今回返せないこと。retireは現在読取から外す改訂。purgeはアクセス停止と保存物の消去。これらを同義にしてはならない。historical入力は新headだけで失効しないが、認可とpurgeは免除しない。

通常リンク先が不許可・欠損ならその辺で伝播しない。独立した本文は返せる。公開linkは利用可能形と `{role, unavailable:true, required, at, orderKey?}` のunion。利用不可形にtarget ID、本文、具体的理由を載せない。inspectは認可された元本文を調べられ、read適格性と区別する。

retireは元の本文・出典・linksを保存して状態だけを改訂する。既に利用不可の通常リンクも黙って削らず、そのまま保持する。この例外で新しい参照先や本文を追加してはならない。

purgeは全履歴の出典・生成入力・継承・選択入力とlegacyの全linksを逆引きする。通常linksを一括で除外してはならない。新旧判定は明示contractで行い、roleや本文で推測しない。旧依存を狭めるには正しく再観測して新しい版を作る。過去版の依存は残る。

purgeはdry-runで影響数とlegacy依存を示す。作業上限・失敗時は読取停止を先に永続化し未完了を返す。再呼出しで再開する。本文/blob/索引/vector/利用状態/cache/保存presentation・generationの対象内容を消去する。物理ページ回収はSQLite compact、バックアップと外部送信済み情報はホスト責任。

## readの集合選択

候補、活性、snapshotを固定する。root集合Sのrequired最小閉包C(S)はpinned revisionを一度だけ訪問する。循環は有限に処理。requiredが欠損・不許可・staleならrootをblockedとし、ref名だけで本文提示済みにしない。未評価のrequired本文の活性は0。

U(S)は返す異なる本文単位の既存活性の和。通常identityはpinned revision。同一原資料/版/範囲の検証済み逐語引用で帰属、役割、required条件も一致する場合のみ一クラスとし、重みは最大値。元refsは残す。重なる別範囲は費用を共有しても別単位。別資料の同文、別生成文を統合しない。

cost(S) = tokenizer.count(render(C(S))) <= memoryTokenBudget。共通requiredは一度表示。同一原資料・版の重なる逐語範囲はevidenceで共有し、範囲、帰属、役割、条件、出典対応、省略区間を含める。itemsをtextへ再追加しない。scoreや監査ログはモデル用textに入れない。表示のformatVersionは2。

選択は順位順の閉包packerを基準解として保存し、限界利得 deltaU/max(1,deltaCost) で実行可能rootを追加する。同点はdeltaU、最終費用、固定pinned参照順。評価できた単一rootも比較。最良の実行可能解を保持し、U同値では安い解を選ぶ。全シリアライズで費用を検証する。作業予算切れは保持した解と未完了診断を返す。基準解を完了できなかった場合はbaselineComplete=falseを明示する。

maxPackingWorkの単位は候補比較1、閉包のnode訪問1、slot訪問1、本文/metadata準備のUTF-8 byte数、render処理の素材byte数 (共有引用の比較1ずつを含む)、最終シリアライズbyte数、tokenizerへ渡すbyte数。再評価でも課金し、予約できない大きさのrender/tokenizerを実行しない。内部実装はmemoizeしてよいが、組合せ検討を無課金にしてはならない。標準上限は2,000,000。tokenizer自体の内部CPU時間は信頼したcallbackの責務。

Uは選択用代理目的で、正答率、真の情報量、独立証拠数ではない。一般的最適性・近似比・上流の意味重複への順位不変性を主張しない。比較を完了した同一状態の基準解以上のUのみ保証する。

## cursor・診断・互換性

最初の操作でsnapshot、binding、索引、query、活性設定、利用状態、evaluatedAt、取得グラフ、数値評価を固定。searchは固定順の続き。readは未返却rootから選択し、各ページにrequired全文を含める。別ページでは共通条件が再表示され得る。query/設定/認可/索引の変更はcursor失効。旧版cursorも失効する。

diagnostics.acquisition / validation / evaluation / selectionを分ける。coverageCertifiedは常にfalse。数値誤差は取得グラフのみの保証。全コーパス網羅、意味品質、新規性へ拡大しない。

ID、版、出典、適合するv3 own-body embedding、同じAvailabilityModel.idの利用状態を保持する。新しい表示・unavailable unionには移行例を用意する。旧manifestは推測して縮小せずlegacyとして解釈する。公開ゲートは40シナリオ、既存回帰、SQLite再接続、旧packageで生成したDB、docs抽出実行と空consumer。skip/未実行は合格へ数えない。実LLM品質は別測定。公開・再デプロイ・利用者DB消去は別の明示指示が必要。
