# read / write

公開型の全体は [TypeScript 契約](/contracts)、実行可能な例は [はじめる](/guide)を参照してください。

## read(request, auth)

`selector` は `refs`、`relations`、`search` のいずれかです。`requestedPolicyIds` は検索範囲の要求であり、権限の付与ではありません。

```ts
const result = await memory.read(
  {
    selector: { kind: 'search', query: '所属の解除', context: '集合の設計' },
    context: { requestedPolicyIds: ['notes'], consistency: { mode: 'snapshot' } },
    budget: { ...defaultBudget, maxAtoms: 16, maxHops: 2 },
    render: 'evidence',
  },
  auth,
);
```

### 出力と継続

`atoms` は有限の版のページです。`evidence` は原資料・抽出・関係、`mixed` は区分を明示した生成物も文脈へ含めます。`raw` は ContextPack を作りません。取得した資料はホスト命令と分離して扱ってください。

`contextPack.serialized` が最終シリアライズ結果、`tokenCount` が指定 tokenizer による実測です。既定の `utf8Tokenizer` は **1 UTF-8 byte = 1 token の語彙**です。LLM の token 数として使う場合は、対象モデルの tokenizer を渡してください。

`continuation` がある場合は、同じ selector・context・render・認証で続きを要求します。ページ予算は変更できます。版と検索状態は維持されます。`CURSOR_EXPIRED` の後に、ライブラリが勝手に最新状態から再開することはありません。

```ts
const next = await memory.read({ ...request, continuation: result.continuation }, auth);
```

独立した後続 query を同じ snapshot で読む場合は、`consistency: { mode: 'snapshot', snapshotToken: result.receipt.snapshotToken }` を指定します。

### 診断

| フィールド                  | 読み方                                                  |
| --------------------------- | ------------------------------------------------------- |
| `traversal`                 | 宣言した範囲の終了・途中・近似検索を区別                |
| `indexState`                | 埋め込み未作成、空間の不一致などは `lagging`            |
| `derivedState`              | 依存が古い、または検証予算が不足した派生物は `pending`  |
| `stopReason`                | 完了、ページ上限、予算、期限など                        |
| `semanticCoverageCertified` | 常に `false`。0 件を不存在や意味的網羅の証明にしない    |
| `usage`                     | この実装が返す追加情報。候補・bytes・モデル・token 消費 |

### 予算

`maxAtoms`、`maxCandidates`、`maxBytes`、`maxNetworkCalls`、`maxModelCalls`、モデル入出力 tokens、`maxContextTokens`、`maxHops`、`deadline` を指定します。最小出力単位が予算に入らない場合は空ページと途中状態が返るため、同じ予算で無制限に再試行しないでください。

検索候補は有限の ID 順ウィンドウです。埋め込みを設定した場合、その候補内で query・context・reasoningState の非負 cosine の最大値を使い、同点は ID 順です。全件 ANN や最適な検索品質の保証ではありません。

## write(request, auth)

```ts
await memory.write(
  {
    idempotencyKey: 'note:correct:2',
    guards: [],
    revisions: [
      {
        atomId: 'note',
        revisionId: 'note:2',
        expectedHead: 'note:1',
        content: content('source', '訂正された原文', 'notes'),
      },
    ],
  },
  auth,
);
```

`expectedHead: null` は未作成時のみ成功します。既存の版を上書きしません。バッチ内の全件が検証を通った場合だけ確定し、失敗時は全件不成立です。同じ主体・冪等キー・要求の再送は同じ operation を返します。内容変更は `IDEMPOTENCY_CONFLICT` です。

権限境界をまたぐ永続的な関係・派生物を拒否します。モデルは `policyId`、出典区分、producer を権限として使えません。producer はホストで上書きします。

`guards` の `head` は固定版、`query-observation` は `inspectReceipt()` で取得できる検索範囲の観測 ID です。空検索も観測を残し、後からの挿入を検出します。

## 出典の範囲

```ts
import { origin, pin, sourceCoverage } from 'atom-memory';
const cited = origin(pin('note', 'note:1'), originalText, 0, 12);
const coverage = sourceCoverage([cited, anotherOrigin]);
```

`sourceCoverage` は同じ原資料・版の区間を和集合にします。生成抽出や要約を、同じ出典という理由だけで同じ意味として削除しません。同じ版の重複経路も検索スコアへ加点しません。

## 管理面

`putBlob()`、`purge()`、`index()`、receipt の検査、overlay はホスト用です。エージェントへ自由なツールとして公開しないでください。

`purge(atomId)` は過去版を含めて読取を拒否し、参照・原資料・入力 receipt に依存する Atom を保守的に連鎖消去します。cursor・該当 receipt・埋め込み・blob・overlay も無効化します。SQLite のページ回収は `storage.compact()`、外部バックアップやホストログの削除はホストが管理します。

エラーは `AtomMemoryError.code` で処理できます。非対応の snapshot、原子性、範囲 guard は、それぞれ `CONSISTENCY_UNAVAILABLE`、`ATOMICITY_UNAVAILABLE`、`GUARD_VALIDATION_UNAVAILABLE` です。
