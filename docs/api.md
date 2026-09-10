# 公開クライアント API

`MemoryHost.connect()` または `createMemory()` が返すクライアントは、同じAtomストア・候補取得・関係展開・版解決を利用します。`kind`、`schema`、意味分類の`space`、ID、版、`policyId`を通常引数に要求しません。

| 操作                                                                                | 契約                                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `read(state, { tokens?, limit?, depth?, cursor? })`                                 | 今回モデルへ渡す記憶を選び、本文・refs・出典・receipt・診断を返す |
| `search(query, { limit?, cursor?, historical? })`                                   | 内容による有限の候補ページ。回答は生成しない                      |
| `inspect(ref, { depth?, limit?, version?, successor?, history?, range?, cursor? })` | 観測した固定版と周辺の関係・出典を読む                            |
| `write(textOrContent, { sources?, idempotencyKey?, signal? })`                      | 一つのAtomを追加する。ID・版・時刻・操作IDはホストが発行          |
| `edit(callback, { basis?, signal?, deadline?, budget? })`                           | 非公開の差分を一度だけ検証・確定する                              |

型の全体は [契約](/contracts)、実行コードは [guide](/guide)と[Writerサンプル](/runtime)にあります。

## read の入力と出力

`state` は `query`、`context`、任意の明示的な`thought`、`observations: string[]`、ホストが検証した`signal`を受け取ります。有効な入力が一つもなければ `INVALID_INPUT`。推論テキストは不要で、原資料の出典にもなりません。

候補を内容で発見し、任意の役割付き関係を両方向に展開してから、関連度・同一版・本文長・出典の重複と必要な付随本文を扱います。同じ原資料・版・範囲の逐語引用は実際の出力から重複を除去します。部分的な重なりは出典区間の和集合にし、文の途中を切って意味を変える処理はしません。別の原資料の同文、同じ出典からの異なる要約は残します。

`required: true` の参照先は本文を含める依存です。条件本文が予算に入らない、または依存表現が失効している場合、主張を単独で返しません。`required` を指定しない一般リンクは有限の関係探索に使い、全文の固定構成にはしません。条件の必要性を自然言語だけから完全に推測できるとは主張しません。

返却する`text`は決定的にシリアライズした記憶領域です。`tokenCount`は設定したtokenizerで測定します。既定は1 UTF-8 byteを1 tokenとする参照用語彙で、実モデル固有の語彙ではありません。`read`は最終回答を作らず、意味Atom・所属を自動保存しません。

## links と refs

`{ text, links: { 資料: ref, 補足: [ref1, ref2] } }` が通常形です。同じ役割の順序・繰り返しを明示する場合は `links: [{ role: '資料', target: ref }, ...]` も使えます。三者関係を一つのAtomで保存でき、役割の交換は異なる記述として残ります。

| 使用箇所                              | 既定の意味                                   |
| ------------------------------------- | -------------------------------------------- |
| `inspect(ref)`                        | 観測した不変版                               |
| `draft.revise(ref, content)`          | 観測版をCASの前提として同じ対象を改訂        |
| 通常の`links`                         | 同じ論理対象。読む版は読取状態で解決         |
| `{ ref, at: 'observed' }`             | 観測した版へ固定。全文を無制限には展開しない |
| `inspect(ref, { version: 'latest' })` | 最新版を明示的に読む                         |
| `inspect(ref, { successor: true })`   | 認証済み編集で採用した後継へ進む             |

refはホストの登録表で検証する不透明な値です。型のbrandだけを認可とせず、偽造ref・失効した権限・abortしたdraftのrefを拒否します。通常リンクの生成時に見た版も入力receiptへ記録します。

## 編集と再送

draftは`write`、`revise`、`retire`、`supersede`、`search`、`inspect`を持ちます。自分の差分が本人の検索・参照に反映され、ほかの実行からは見えません。結果の`value`内のrefは確定後のrefへ解決し、`changes`と`resolve(ref)`も返します。

一つのcallbackでは一つの論理Atomにつき一つの改訂案を扱います。すでにstageした対象の再改訂は明示的に拒否します。有限バッチの全件を検証し、失敗時は部分公開しません。CAS競合でcallbackやLLM呼出しを再実行しません。

二回の通常writeは本文が同じでも別の出来事です。任意の`idempotencyKey`はプロセスをまたぐ原資料イベントの再送に使います。同じキーで異なる引数は `IDEMPOTENCY_CONFLICT`。SDK内部は、一回発行した要求全体を保存して明示的な`RetryableCommitError`のみ有限回再試行します。これはローカル確定境界の故障注入試験を含む契約で、リモートストレージを実装したという意味ではありません。

`basis: 'historical'`は意図的な過去資料の分析です。監査の読取依存を残し、現在性の主張とは区別します。改訂自身のCASや後継採用の競合は免除しません。

## 続き・blob・診断

cursorは検索信号、認証、読取状態、索引状態、設定へ束縛します。同じquery/refと探索設定で再開し、`limit`や今回の予算を変更できます。`read`の続きは今回の予算で再パックし、前回の本文を無制限に追加しません。`CURSOR_EXPIRED`を正常な0件に変えません。

`inspect(ref, { range: { start: 0, bytes: 4096 } })`でblobの本文を読みます。UTF-8境界を保ち、テキストは`range.text`、それ以外は`range.base64`を返します。残りはcursorで再開します。高次数の隣接関係と履歴manifestもページで読みます。

| 診断                                  | 意味                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `method`                              | 実装した候補取得方式                                                |
| `traversal`, `scanned`, `approximate` | 走査終了か上限による部分探索か                                      |
| `index`                               | `ready` / `pending` / `unavailable`。未索引は情報なしと同義ではない |
| `derived`                             | `ready` / `pending` / `regenerated` / `unused`                      |
| `minimumTokens`, `minimumBytes`       | 空ページの最小出力に必要な予算の手掛かり                            |
| `coverageCertified`                   | 常にfalse。意味的な網羅を保証しない                                 |

出力を進められない候補・隣接探索は `BUDGET_EXHAUSTED` とし、同じ未処理位置の空ページを無限に返しません。トークン不足は必要量とcursorを返すので、予算を増やして再開できます。searchのscoreは確率や事実の信頼度ではありません。
