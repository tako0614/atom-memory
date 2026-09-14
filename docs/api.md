# API リファレンス

Atom Memory v0.9.0 の通常APIは `read`、`search`、`inspect`、`write` です。意味と失敗条件の正本は[規範仕様](/specification)、公開型は[型一覧](/contracts)を参照してください。モデル実行や自動的なWriter loopは含みません。

| 操作                           | 用途                                                 | 戻り値                                                                              |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `write({ changes }, options?)` | create / revise / retire の宣言的batchを原子的に確定 | `operationId`、`repeated`、`indexing`、change idごとの`AtomView`                    |
| `search(query, options?)`      | 同じ活性と取得境界による順位付き候補                 | `items`、`stale`、`receipt`、`cursor`、`diagnostics`、`usage`                       |
| `inspect(ref, options?)`       | 指定版と一-hopの隣接Atomを調べる                     | `atom`、`neighbors`、`readEligibility`、`receipt`、`cursor`、`diagnostics`、`usage` |
| `read(state, options?)`        | 必須条件を欠かさない本文集合を予算内で選ぶ           | `text`、`formatVersion`、`items`、`refs`、`sources`、`tokenCount` など              |

```ts runnable
import { LocalAuthority, MemoryHost } from 'atom-memory';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example',
  readPolicies: ['p'],
  writePolicies: ['p'],
  canIngestSource: true,
});
const memory = new MemoryHost({ authority }).connect({
  auth,
  writePolicy: 'p',
  actor: { type: 'human' as const },
});

const condition = (
  await memory.write({
    changes: [
      {
        id: 'condition',
        op: 'create',
        content: { text: '管理者の承認が必要です。', links: [] },
        sources: [],
      },
    ],
  })
).changes.condition;

const rule = (
  await memory.write({
    changes: [
      {
        id: 'rule',
        op: 'create',
        content: {
          text: '招待を許可する。',
          links: { 条件: { ref: condition.ref, required: true } },
        },
        sources: [],
      },
    ],
  })
).changes.rule;

const found = await memory.search('招待');
const detail = await memory.inspect(rule.ref, { limit: 0 });
const recalled = await memory.read({ query: '招待' }, { tokens: 4000 });
console.log(found.items.length, detail.readEligibility, recalled.formatVersion);

const revised = (
  await memory.write({
    changes: [
      {
        id: 'rule-revision',
        op: 'revise',
        target: rule.ref,
        content: {
          text: '招待は承認後に許可する。',
          links: { 条件: { ref: condition.ref, required: true } },
        },
        sources: [],
      },
    ],
  })
).changes['rule-revision'];
console.log(revised.text);
```

## write

```ts
memory.write(
  {
    changes: readonly MemoryChange[],
  },
  options?: WriteOptions,
): Promise<WriteOutcome>;
```

`changes` は空でない配列です。各要素は次のいずれかです。

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

type RetireChange = {
  id: string;
  op: 'retire';
  target: AtomRef;
  input?: InputToken;
};
```

`content.links` と `sources` は完全置換です。省略せず、リンクがない場合も `links: []`、出典がない場合も `sources: []` と書きます。`revise` と `retire` の `target` は発行済みの観測refで、同じ論理Atomを一つのbatchで二度変更できません。`create` のリンクは既存の `AtomRef`、論理refまたは観測refを指定した `{ ref, at?, required?, orderKey? }`、または同じbatchの `change.id` を参照する `{ local, at?, required?, orderKey? }` です。batch-local linkは実行後のrefではなく、事前確保されたrevisionへ解決されます。循環や複数方向の関係を許可し、role名から親子や出典を推測しません。

Agent bindingの各changeには、ホストが `host.observe()` で発行した `InputToken` が必要です。人間と `input-adapter` のchangeはtokenを省略できます。tokenをtool schemaへ公開したり、任意の文字列を入力tokenとして扱ったりしません。

結果は次の形です。

```ts
interface WriteOutcome {
  operationId: string;
  repeated: boolean;
  indexing: 'pending' | 'ready';
  changes: Readonly<Record<string, AtomView>>;
}
```

`changes` は入力のchange idをキーにします。`indexing` はembedding projectionの状態であり、commitの成否ではありません。batchは全件がcommitされるか、検証・認可・CAS・予算の失敗で全件がcommitされないかのどちらかです。

### idempotencyKey

`WriteOptions` は `idempotencyKey`、`budget`、`deadline`、`signal` を受け取ります。keyを付けたcommitは、subject・write policy・actorと現在のpurge状態に束縛されます。同じkeyで意味的に同じplanを再送すると、同じ `operationId` と現在認可できるchange viewを `repeated: true` で返します。planを変えた再送は `IDEMPOTENCY_CONFLICT` です。commit前の最初の呼出しでは期限切れ・purge済み・scope違いのInputTokenを拒否しますが、commit済みplanの一致するreplayは、そのtokenが後から期限切れになっても保存された結果を回収できます。現在の認可またはpurge境界を満たさないreplayは拒否されます。

## search

```ts
search(query: string, options?: SearchOptions): Promise<MemoryPage>;
```

`SearchOptions` は `depth`、`limit`、`cursor`、`budget`、`deadline`、`signal` を持ちます。cursorは同じquery、認可、検索設定、索引状態に束縛され、条件が変わると失効します。`stale` に返るrefは候補から除外されます。`score` は同じ評価内の相対的な順位で、真偽や確率ではありません。

## inspect

```ts
inspect(ref: AtomRef, options?: InspectOptions): Promise<Inspection>;
```

`inspect` は一-hopだけを調べます。既定は `version: 'observed'`、`direction: 'both'`、`limit: 20` です。`direction` は `incoming` / `outgoing` / `both`、`roles` は役割のallowlist、`limit: 0` はrootだけ、`cursor` は隣接ページ、`range: { start, bytes }` はblob本文の範囲を指定します。inspectに `depth` や `items` はありません。隣接Atomは `neighbors: [{ atom, via }]` で返り、`via` に方向、role、`at`、`required`、任意の `orderKey` が残ります。認可できない隣接は存在を推測できる形で返しません。`readEligibility` は直接分かる必須リンク欠損の `blocked`、それ以外の `unchecked` であり、通常readの適格性証明ではありません。

## read

```ts
read(state: MemoryState, options?: ReadOptions): Promise<RecallResult>;
```

`ReadOptions` は `depth`、`tokens`、`limit`、`cursor`、`budget`、`deadline`、`signal` を持ちます。required linkの本文を閉包として含め、予算に入らなければrootを返しません。`read.text` は `formatVersion: 2` の表示で、同じ `items` の本文をモデル入力へ重ねて追加しません。`inspect` の一-hopとは別に、read/searchでは従来どおり `depth` と返却件数を指定できます。

## ホスト操作と表示

`host.observe(input, binding)` は最終payloadとの対応を記録してInputTokenを発行します。`host.manifest(receiptOrToken, binding)` は認可済みのmanifestを読みます。`host.recordUse(refs, binding, { eventId, input? })` は成功したモデル要求の利用ackで、read/searchだけでは利用状態を増やしません。`host.resetUse(binding)` は状態を消しますが、event dedupは残します。

索引は `prepareIndex` / `updateIndex` / `indexAtoms`、大きな原資料は `ingestBlob`、消去は `host.purge(atomId, options)` です。消去の未完了中は公開read/writeを拒否し、同じatomIdで再開します。物理ページ回収や外部へ送信済みの情報はホストの責務です。

`read`、`search`、`inspect` の `receipt` は入力の取得・表示・認可を記録します。`diagnostics.acquisition`、`validation`、`evaluation`、`selection` は別の段階です。`coverageCertified` は常に `false` で、`complete` や `pending: false` だけではコーパス全体の網羅や意味品質を示しません。
