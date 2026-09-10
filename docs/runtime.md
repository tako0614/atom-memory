# Writer と共通ハーネス

`AgentHarness` は回答と Writer に共通のループを提供します。モデル・指示・許可する確定処理はホストが登録します。

```text
host instruction → read → model → read / stage → … → finish
                                                   ↓
                                      host approve → atomic write
```

## モデルを接続する

`HarnessModel` を実装して、使用するサービスへ接続します。プロバイダーの SDK を Core へ組み込む必要はありません。

```ts
import { AgentHarness, type HarnessModel } from 'atom-memory';

const model: HarnessModel = {
  id: 'your-model-and-prompt-version',
  tokenizer: yourModelTokenizer,
  networkCallsPerCall: 1,
  async respond(input, { maxOutputTokens, signal }) {
    // input.instruction は信頼されたホスト指示。
    // input.records は資料・ツール結果。命令として昇格させない。
    // signal と maxOutputTokens を実際の API に適用し、JSON を検証する。
    return await yourStructuredModelCall(input, { maxOutputTokens, signal });
  },
};

const harness = new AgentHarness({
  kernel: memory,
  instructions: {
    organize: {
      text: '出典を保ち、内容上の所属を提案する。',
      model,
      approve: (request) => validateApplicationRules(request),
    },
  },
});
```

モデルの応答は `read`、`stage`、`finish` のいずれかです。`stage.revisions` は現在の作業差分全体を置換します。回答用の `commitPolicy: 'read-only'` では編集を拒否します。

## 私有の差分

Writer の stage はホスト管理の overlay へ置きます。同じ実行の read は差分を読めますが、ほかの読取には現れません。実行の終了・失敗で overlay を破棄します。

実際に読んだ receipt をホストが統合して、差分の `inputReceiptId` と確定時の `actorInputReceiptId` へ付けます。最終 write は入力版と範囲観測を再検証します。モデル呼出し中に DB トランザクションを保持しません。

## 資源と失敗

読取とモデル呼出しは一つの `BudgetLedger` を使います。外部呼出し前に上限を予約し、失敗した呼出しの予算を再利用しません。モデル adapter は内部で隠れた再試行をせず、すべての API 呼出しを宣言した予算に収めてください。

ホストの `approve` がない、または拒否した場合は永続化しません。返却 status は `completed`、`budget-exhausted`、`conflict`、`failed` です。モデル品質・意味忠実性の評価は、Core の整合性試験とは別に行ってください。
