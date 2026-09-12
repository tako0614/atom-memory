# API リファレンス

保存する、探す、詳しく読む、思い出す、編集する。五つの操作は、同じ `memory` から使えます。

| 操作                       | 使う場面                     | 主な戻り値                     |
| -------------------------- | ---------------------------- | ------------------------------ |
| `write(content, options?)` | 一つのメモや関係を追加する   | 保存した本文、`ref`、索引状態  |
| `search(query, options?)`  | 内容で候補を探す             | `items`、次ページの `cursor`   |
| `inspect(ref, options?)`   | 特定の情報と根拠を調べる     | `atom`、周辺の `items`、出典   |
| `read(state, options?)`    | 今回モデルに渡す記憶を選ぶ   | `text`、採用した `refs`、出典  |
| `edit(callback, options?)` | 複数の変更をまとめて確定する | callback の `value`、`changes` |

以下の例は、同じクライアントで上から順に実行できます。型の定義は [TypeScript](/contracts)にあります。

例では [クイックスタート](/guide#_2-ファイルを用意する)のクライアントを使います。

```ts session
import { memory } from './memory.mjs';
```

## write

文字列、または `{ text, links }` を保存します。ID、版、時刻はライブラリが発行します。

```ts session
const rule = await memory.write('招待リンクの有効期限は24時間です。');
const topic = await memory.write('招待と参加の手順');
await memory.write({
  text: '手順に有効期限のルールを結び付ける。',
  links: { 手順: topic.ref, ルール: rule.ref },
});
console.log(rule.ref, rule.text, rule.indexing);
```

戻り値は `AtomView` の本文・関係・出典に、`operationId`、`repeated`、`indexing` が加わります。`indexing: 'pending'` は保存済みで埋め込み索引への反映待ちという意味です。語彙による検索には使えます。

同じ本文を二度 `write` すると、別の入力として保存します。入力アダプターが同じイベントを再送する場合は、イベントIDを `idempotencyKey` に指定します。同じキーと内容の再送は確定済みの結果を返し、異なる内容は `IDEMPOTENCY_CONFLICT` になります。

| オプション                         | 用途                                     |
| ---------------------------------- | ---------------------------------------- |
| `idempotencyKey`                   | プロセスをまたいで同じイベントを再送する |
| `sources: [{ ref, start?, end? }]` | 使用した資料と UTF-8 byte 範囲を示す     |
| `signal`                           | 処理をキャンセルする                     |

出典区分はホストの書き手設定に基づきます。生成物への `sources` 指定は引用の指定であり、原資料への区分変更ではありません。

## search

```ts session
const query = '招待';
const page = await memory.search(query, { limit: 2 });
console.log(page.items.map((item) => ({ ref: item.ref, text: item.text, score: item.score })));

if (page.cursor) {
  const next = await memory.search(query, { limit: 2, cursor: page.cursor });
  console.log(next.items.map((item) => item.text));
}
```

`items` はAtom自身の本文との類似度と、明示的な役割付きリンクの伝播で並べた候補です。リンク先本文を親の検索表現へ暗黙に連結しません。関係Atomも自分の本文を持つ候補であり、必要なら `inspect` で根拠を調べられます。`score` は今回のqueryへの相対的な順位づけで、事実の信頼度や絶対的重要度を表す確率ではありません。`scoreBreakdown` の `direct` と `structural` で寄与を確認できます。[計算と設定](/ranking)を参照してください。

| オプション | 既定値 | 意味                                        |
| ---------- | ------ | ------------------------------------------- |
| `limit`    | `10`   | 一ページの結果数                            |
| `depth`    | `2`    | 関係の探索深さ。ホストのranking設定で変更可 |
| `cursor`   | なし   | 確定済み候補の次ページを返す                |

`items: []` は結果がないページです。索引の反映待ちや有限範囲での近似かどうかは `diagnostics` と `cursor` を併せて確認します。`complete` 相当の診断や `coverageCertified: false` は、許可されたコーパス全体の網羅性を証明しません。

## inspect

保存・検索で得た参照が指す版を調べます。`atom` が指定した情報、`items` が関係探索で返った情報です。

```ts session
const detail = await memory.inspect(rule.ref, { depth: 1, limit: 20 });
console.log(detail.atom.text);
console.log(detail.atom.links);
console.log(detail.atom.sources);
console.log(detail.items.map((item) => item.text));
```

| オプション | 既定値       | 意味                                               |
| ---------- | ------------ | -------------------------------------------------- |
| `depth`    | `1`          | 正引き・逆引きの関係をたどる深さ。`0` は展開しない |
| `limit`    | `20`         | 一ページの結果数                                   |
| `version`  | `'observed'` | `'latest'` で同じ対象の最新版を選ぶ                |
| `range`    | なし         | blob の本文を `{ start, bytes }` で範囲取得する    |
| `cursor`   | なし         | 関係・blob の続きを読む                            |

blob の本文は `range.text`、非テキストは `range.base64` に入ります。実行例は [保存アダプター](/adapters#長い原資料を読む)にあります。過去の版も、現在の閲覧許可で検証します。

## read

今回の問いや作業の文脈から、モデルへ渡す資料を組み立てます。

```ts session
const recalled = await memory.read({ context: '招待リンクはいつ切れる？' });
console.log(recalled.text); // モデルへ渡す記憶
```

入力の `query`、`context`、`thought`、`observations` は任意です。取得できる文脈や観測を渡せば動きます。`thought` は明示的な作業中の推論テキスト、`signal` はホストが設定したエンコーダーからの検索信号です。意味のある入力が一つもなければ `INVALID_INPUT` になります。

`read` は内容で候補を探し、関係を広げ、関連度と長さを見て今回の情報を選びます。同じ証拠への重複経路を整理し、`required` の依存は本文ごと含めます。同じ出典から作った異なる要約や、別人による同文の入力は、出典一致だけでは統合しません。

| オプション | 既定値 | 意味                                   |
| ---------- | ------ | -------------------------------------- |
| `tokens`   | `4096` | 今回返す記憶領域の上限                 |
| `limit`    | `24`   | 採用する結果数の上限                   |
| `depth`    | `2`    | 関係をたどる深さ                       |
| `cursor`   | なし   | 固定済み候補を今回の予算で再パックする |

`text` は記憶の本文・参照・出典を JSON でシリアライズした領域です。`refs` と `sources` は今回採用した情報、`receipt` は入力と読取状態を追跡する記録です。関連する情報が少なければ短い結果になります。

同じ原資料・同じ版の逐語引用が重なる場合、本文は `evidence[].ranges[].text` に共有します。各 `memory` 項目の `quote: { ref, start, end, unit: 'utf8' }` が元の引用範囲を指します。離れた範囲は別要素と `omittedBefore` で表し、断片を一文に連結しません。`items` と `inspect` は元の内容を保持するため、モデルへは `text` を渡します。`items` 全体を追加すると共有前の引用が再送されます。

トークン数はホストに設定した tokenizer で数えます。既定は UTF-8 の1 byteを1 tokenとする保守的なカウンターです。実モデルの全入力と出力予約の計測は [アプリのモデル実行](/runtime)で扱います。

## edit

複数の変更を一つの非公開 draft にまとめます。callback が成功し、版や入力の前提を検証できたら、一度に確定します。

```ts session
const edited = await memory.edit((draft) =>
  draft.revise(rule.ref, '招待リンクの有効期限は48時間です。'),
);
console.log(edited.value.text); // 招待リンクの有効期限は48時間です。
```

| draft の操作                                         | 用途                   |
| ---------------------------------------------------- | ---------------------- |
| `write(content, options?)`                           | 追加                   |
| `revise(ref, content, options?)`                     | 観測版を前提に改訂     |
| `retire(ref)`                                        | 対象を廃止             |
| `search(query, options?)` / `inspect(ref, options?)` | 自分の変更を含めて読む |

他の実行には確定まで変更が見えません。失敗した draft の参照は外で使えません。戻り値 `value` 内の参照は確定後の参照に解決され、外に保持した draft 参照には `edited.resolve(ref)` を使えます。

改訂の前提版は `ref` から決まります。先行する改訂があれば `REVISION_CONFLICT` となり、callback は自動で再実行されません。現在の内容を読み直し、アプリや Writer が次の編集を判断してください。一回の callback で扱える改訂案は、一つの論理 Atom につき一つです。

`basis: 'historical'` は、過去の資料を意図的に分析する編集に使います。読取履歴は残し、改訂自身の版の前提は引き続き検証します。

## 共通の戻り値と診断

検索・参照・read は `receipt`、`diagnostics`、`usage` を返します。`usage` はその処理の消費量です。ホストは `MemoryClient.forExecution({ ledger, traces: [] })` で複数の記憶操作の予算・入力記録を共有できます。モデル呼出し全体の予算はアプリが管理します。

| フィールド                       | 読み方                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `receipt`                        | 読取状態と検索信号をホストが追跡する記録                                                                                                        |
| `cursor`                         | 続きがあるときに返る参照                                                                                                                        |
| `diagnostics.method`             | 使った取得方式                                                                                                                                  |
| `traversal` / `scanned`          | 探索の完了状態と走査数                                                                                                                          |
| `approximate`                    | 取得方式が近似かどうか                                                                                                                          |
| `index`                          | `ready`：この操作で必要なv3索引が反映済み、`pending`：反映待ちまたは調べた候補の旧索引メタデータが互換しない、`unavailable`：索引を利用できない |
| `derived`                        | 派生表現が `ready` / `pending` / `unused` のどれか                                                                                              |
| `derivedReason`                  | `pending` の理由。`dependency-stale`                                                                                                            |
| `stop`                           | 完了・ページ上限・予算・期限のいずれで止まったか                                                                                                |
| `minimumTokens` / `minimumBytes` | 出力が予算に入らないときの必要量                                                                                                                |
| `coverageCertified`              | 現在は `false`。探索完了と意味的な網羅性は別に扱う                                                                                              |

cursor は同じクエリまたは参照と探索設定で再開します。`limit` や今回の予算は変更できます。認証、読取状態、索引状態、検索信号に束縛されているため、失効した cursor は新しい検索から取り直します。

`search`・`inspect`・`read`・`edit` は `signal`、ISO日時の `deadline`、`budget` による上限設定を受け取ります。普段は既定値を使い、外部呼出しや長い処理を行うホスト側で調整できます。

## エラーへの対処

| エラー                 | 次にすること                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `INVALID_INPUT`        | 空の読取入力や範囲・件数を確認する                               |
| `INVALID_REF`          | 保存・検索・編集が発行した参照を使う                             |
| `REVISION_CONFLICT`    | 最新の内容を確認し、編集を判断し直す                             |
| `STATE_INVALIDATED`    | 生成待ちの間などに入力・権限が変化したため、新しい状態で読み直す |
| `ACCESS_DENIED`        | ホスト側の現在の閲覧・書込許可を確認する                         |
| `CURSOR_EXPIRED`       | 新しい検索・参照から開始する                                     |
| `BUDGET_EXHAUSTED`     | ページを小さくするか実行予算を調整する                           |
| `MODEL_SPACE_MISMATCH` | エンコーダーと検索信号の互換設定を確認する                       |

保存容量、操作予算、索引方式については [保存と検索](/adapters)を参照してください。

## 古くなった記憶を扱う

`read` / `search` は、入力が古くなった生成物を `items` と `text` から除外し、`stale: AtomRef[]` に参照を返します。古い候補の現在の出典を、その候補の順位・score・ページ位置へ代用しません。現在の原資料が返るのは、通常の本文候補取得または構造展開で独立に見つかった場合だけです。`diagnostics.derived` は `pending`、理由は `dependency-stale` です。検索意図を再実行したり文章を再生成したりしません。

アプリは `stale` をWriterのキューへ渡すか、`inspect` で調べ、通常の `edit` で改訂します。`inspect` は指定した版の検査であり、鮮度による除外は行わないため、`stale` は空配列です。

Atomの本文には用途に合わせた分類を入れられます。`source` 等のprovenanceは認証された出自を表す保存契約で、検索の重要度を固定する階級ではありません。
