# API リファレンス

五つの通常操作を維持します。意味と失敗条件の正本は[規範仕様](/specification)、公開型は[型一覧](/contracts)を参照してください。

| 操作                     | 用途                     | 戻り値                                         |
| ------------------------ | ------------------------ | ---------------------------------------------- |
| write(content, options?) | 本文とlinksを追加        | AtomView、operationId、repeated、indexing      |
| search(query, options?)  | 同じ活性による順位       | items、receipt、cursor、diagnostics            |
| inspect(ref, options?)   | 指定した観測版の調査     | atom、周辺items、readEligibility、receipt      |
| read(state, options?)    | 条件を欠かさない本文集合 | text、formatVersion、refs、sources、tokenCount |
| edit(callback, options?) | 有限変更の原子的確定     | value、changes、operationId、resolve           |

```ts runnable
import { LocalAuthority, MemoryHost } from 'atom-memory';
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example',
  readPolicies: ['p'],
  writePolicies: ['p'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
const binding = { auth, writePolicy: 'p', actor: { type: 'human' as const } };
const memory = host.connect(binding);
const condition = await memory.write('管理者の承認が必要です。');
const rule = await memory.write({
  text: '招待を許可する。',
  links: { 条件: { ref: condition.ref, required: true } },
});
const found = await memory.search('招待');
const detail = await memory.inspect(rule.ref, { depth: 0 });
const recalled = await memory.read({ query: '招待' }, { tokens: 4000 });
console.log(found.items.length, detail.readEligibility, recalled.formatVersion);
await memory.edit((draft) =>
  draft.revise(rule.ref, {
    text: '招待は承認後に許可する。',
    links: { 条件: { ref: condition.ref, required: true } },
  }),
);
```

## write

`write(content: MemoryContent, options?: WriteOptions): Promise<WriteOutcome>`。文字列または `{text, links}` を渡し、発行されたrefを受け取ります。

## search

`search(query: string, options?: SearchOptions): Promise<MemoryPage>`。順位の続きを取得する場合は返されたcursorを同じqueryで使います。

## inspect

`inspect(ref: AtomRef, options?: InspectOptions): Promise<Inspection>`。既定はobserved版。大きい原資料はrangeで範囲を指定します。

## read

`read(state: MemoryState, options?: ReadOptions): Promise<RecallResult>`。モデル入力には返されたtextを一回だけ組み込みます。入力確定は[ホスト連携](/runtime)を参照してください。

## edit

`edit(callback, options?: EditOptions): Promise<EditOutcome<T>>`。draftのwrite/revise/retireをまとめます。結果のvalueとchangesは確定後のrefです。

## 主なオプション

| 型                          | フィールド                                                      |
| --------------------------- | --------------------------------------------------------------- |
| OperationOptions            | cursor、limit、signal、deadline、budget                         |
| SearchOptions / ReadOptions | depth。readはtokens (既定4096)も指定                            |
| InspectOptions              | version: observed/latest、depth、range: start/bytes             |
| WriteOptions                | idempotencyKey、sources: ref/start/end、signal、ホスト専用input |
| EditOptions                 | basis: current/historical                                       |

sourcesは引用の範囲です。生成の全入力を上書きせず、原資料への昇格にもなりません。InputTokenを使わないagent editは全edit入力を保守的に保持します。

## ホスト操作

`host.observe(input, binding)` は最終payloadとの対応を記録しInputTokenを返します。`host.manifest(receiptOrToken, binding)` は認可された観測内容を調べます。入力の形と継承は[ホスト連携](/runtime)、保存互換性は[移行](/migration)を参照してください。

`host.recordUse(refs, binding, {eventId, input?})` は成功したモデル要求の露出を通知します。input指定時は確定済みpresentationと照合します。再送は同じeventId。`host.resetUse(binding)` は利用状態を消しdedupを残します。readだけでは利用を増やしません。

索引は `prepareIndex` / `updateIndex` / `indexAtoms`、大きな原資料は `ingestBlob`。消去は `host.purge(atomId, {dryRun?, maxWork?})`。結果のcomplete、affectedAtomIds、erasedAtomIds、legacyDependencies、reasonを確認します。未完了時の再開はホストの責務です。

## 表示と診断

`read.text` はformatVersion=2のJSON表示です。itemsの元本文を重ねてモデルへ追加しないでください。unavailable linkにはrefがありません。inspectのreadEligibilityは、直接判明した必須条件欠損ならblocked、それ以外はuncheckedです。inspectは通常readの適格性証明ではありません。

diagnosticsのacquisition、validation、evaluation、selectionは別段階です。数値誤差は取得済みグラフに限定します。selection.utilityは既存活性から計算した代理目的Uであり、正答率ではありません。selection.baselineComplete=falseは基準解を完成する予算もなかったことを示します。
