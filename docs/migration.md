# v0.8からv0.9.0への移行

v0.9.0は、v0.8の観測・依存・活性の境界を保ったまま、公開書き込みを宣言的なbatchへ統一します。`MemoryAPI` の通常操作は `read` / `search` / `inspect` / `write` です。v0.8の `edit`、`Draft`、callback型の `EditOutcome` は公開互換層として残りません。意味の正本は[規範仕様](/specification)です。

## 変更点

| v0.8の利用                                              | v0.9.0での扱い                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `memory.write(content)` または `write({ text, links })` | `memory.write({ changes: [{ id, op: 'create', content: { text, links }, sources: [] }] })`へ移行 |
| `memory.edit(callback)` / `draft.write`                 | callbackを外し、`create` / `revise` / `retire` changeを一つのwrite batchへ宣言                   |
| `draft.revise(ref, content)`                            | `revise` changeの `target: ref`。content.linksとsourcesを完全置換として明示                      |
| `draft.retire(ref)`                                     | `retire` changeの `target: ref`。raw body・links・sourcesを保持してstateだけをretiredへ変更      |
| `EditOutcome.value` / `changes[]`                       | `WriteOutcome.changes[changeId]`。`operationId`、`repeated`、`indexing`を追加                    |
| 省略可能なlinks / sources                               | create/reviseでは必須。空でも `links: []` と `sources: []` を書く                                |
| 生成ごとの暗黙入力                                      | agentの各changeへhost-issued `InputToken` を付ける。human / input-adapterは省略可能              |
| inspectの`depth` / `items`                              | 廃止。inspectは一-hopで、`direction`、`roles`、`limit`、cursor、rangeを使う                      |
| search/readの`depth`                                    | 継続。inspectの一-hop制約とは独立                                                                |
| 旧 `InputToken` を使うwrite                             | 同じbinding、認可世代、scope、purge状態で検証。任意文字列や期限切れ初回tokenは拒否               |

## 典型的な置換

```ts
// v0.8
// const rule = await memory.write({ text: '招待を許可する。', links: {} });
// await memory.edit((draft) => draft.revise(rule.ref, { text: '承認後に許可する。', links: {} }));

const created = (
  await memory.write({
    changes: [
      {
        id: 'rule',
        op: 'create',
        content: { text: '招待を許可する。', links: [] },
        sources: [],
      },
    ],
  })
).changes.rule;

const revised = (
  await memory.write({
    changes: [
      {
        id: 'rule-revision',
        op: 'revise',
        target: created.ref,
        content: { text: '承認後に許可する。', links: [] },
        sources: [],
      },
    ],
  })
).changes['rule-revision'];
```

同じbatch内で作成したAtomへは `{ local: 'change-id' }` のlinkを使います。local idはbatchだけの名前で、commit後に独立refとして保存されません。循環・多重所属・複数roleは許可されます。role名から新しい階層や後継を推測しません。

## idempotency replay

`WriteOptions.idempotencyKey` はsubject・write policy・actorとsemantic planへ束縛されます。同じkeyで同じplanを再送すると、同じ `operationId` と現在認可できる `changes` を `repeated: true` で取得できます。planを変えると `IDEMPOTENCY_CONFLICT` です。commit前の初回呼出しでは期限切れ・purge済み・別scopeのInputTokenを拒否しますが、commit済みplanの一致replayはtokenが後から期限切れになっても結果を回収できます。replayでも現在の認可とpurgeを再確認します。

## 既存保存と索引

Atom ID・revision・出典・links・v3 own-body embedding・AvailabilityModelの同一ID状態は、対応する保存adapterが継続利用できます。公開APIの契約が不明な旧manifestや旧linksはlegacyとして保守的な消去依存を残し、roleや本文から縮小しません。過去のcursorは `CURSOR_EXPIRED` として新しい操作から取得します。新しいdisplayの `AtomLink.unavailable` unionとinspectのone-hop receiptを利用するには、旧consumerを更新してください。

入力token付きの新しいagent writeでは、hostが `observe` で最終payload、presentation、sources、inherit、watches、basis、digestを確定します。既存の生成記録を推測でtokenへ変換しません。人間またはinput-adapterによるsource writeにはtokenを付けなくてもよい一方、agent changeだけtoken必須です。

## 消去・停止の境界

`purge` は全履歴の出典、生成入力、継承、選択入力、legacy linksを逆引きします。新契約の通常linksは、role名だけを理由に消去依存へ昇格しません。dry-runで影響範囲を確認し、未完了時は停止markerを永続化して公開read/writeを拒否します。同じatomIdで再呼出し、`complete: true` を確認してから通常処理へ戻します。blob、本文、FTS/vector、利用状態、cache、保存manifestの消去とSQLite物理compact、外部backupの削除はそれぞれの所有者が行います。

## 検証

移行後は型検査、`test/v09.test.mjs`、既存の保存adapter回帰、`npm run docs:examples` を実行します。ランキングの現行出力は `validation/ranking-v0.9.0.json` と `validation/selection-v0.9.0.json`、v0.8のJSONは歴史的基準です。決定的テスト、固定embedding、proxy U、隣接アプリの試験を実LLMの回答品質、全コーパス網羅、公開済みpackage、performanceの証明へ読み替えません。

0.6以前からの利用状態変更は[旧v0.7移行資料](/migration-v07)を参照してください。ここに記載した手順はnpm公開やサイト再デプロイの承認ではありません。
