# ホストから生成入力を記録する

モデル呼出しとpayload構成はアプリが所有します。以下は一要求の例で、モデルloopやAgent frameworkは実装しません。意味の正本は[規範仕様](/specification#一つのversioned-manifest)です。

```ts runnable
import { createHash } from 'node:crypto';
import { LocalAuthority, MemoryHost } from 'atom-memory';
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example',
  readPolicies: ['p'],
  writePolicies: ['p'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
const raw = { auth, writePolicy: 'p', actor: { type: 'input-adapter' as const } };
const binding = { ...raw, actor: { type: 'agent' as const } };
(
  await host.connect(raw).write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: '招待には管理者の承認が必要。',
          links: [],
        },
        sources: [],
      },
    ],
  })
).changes.atom;
const memory = host.connect(binding);
const recall = await memory.read({ query: '招待' }, { tokens: 4000 });
const payload = JSON.stringify({ question: '招待の条件は？', memory: recall.text });
const input = host.observe(
  {
    presentations: [{ receipt: recall.receipt, refs: recall.refs }],
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
  },
  binding,
);
// Replace this deterministic stub with the application's request function.
const request = async (_payload: string) => '管理者の承認が必要です。';
const result = await request(payload);
// Use the same eventId when retrying this acknowledgement.
host.recordUse(recall.refs, binding, { eventId: 'example-request-1', input });
(
  await memory.write({
    changes: [
      {
        id: 'atom',
        op: 'create',
        content: {
          text: result,
          links: [],
        },
        sources: [],
        input,
      },
    ],
  })
).changes.atom; // The dispatcher injects input; it is not a model tool argument.
```

送信前に本文を除いた場合はpresentations.refsも実送信に合わせます。ただし使用したreadのacquisitionは選択依存として保持します。citation参照だけの資料全文を送ったとは記録しません。digestはホストの申告と実payloadを監査するための対応で、モデル内部を物理的に検知するものではありません。

前段から作業状態を持ち越す要求では `inherit: [previousInput]` を指定します。basisをhistoricalにしても継承したwatchは消えません。独立した要求は別tokenで観測し、同じwrite batchの各agent changeへ対応する `input` を付けます。同じ要求がA/Bを見た場合、引用をa→A、b→Bと分けても生成依存は両入力のままです。humanとinput-adapterのchangeはtokenを省略できます。

writeへ `idempotencyKey` を付けると、同じsubject・policy・actorで同じsemantic planを再送できます。planを変えた再送はconflictです。commit前の期限切れtokenは拒否されますが、commit済みplanの一致replayは、後からtokenが期限切れになっても同じ `operationId` とchangesを回収できます。現在の認可・purge境界はreplayでも検証されます。

入力tokenはbinding・認可世代・有効期限・purgeで検証します。入力未確定のtoken、任意文字列、他scopeのtokenは受け付けません。信頼したホストが全入力、外部tool結果、持越し状態を申告することが境界です。

## 小さなWriter例

<<< ../examples/writer.mjs

```text output:writer.mjs
古い整理を通知: 1
Writer改訂後の未更新: 0
観測済み原文: 旧クライアントで認証を利用できる。
```

モデル呼出し、再試行、費用、ジョブ、後継採用はホストへ残します。この例の決定的stubは実LLMの品質評価ではありません。
