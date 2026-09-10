# 自動readとWriter

`MemoryHarness`（公開名`AgentHarness`も同じ実装）は、各モデル呼出し前に高水準クライアントの`read`を実行します。モデルが検索ツールを選ばなくても記憶が入ります。

```text
固定のホスト指示・今回の原入力・初期観測
+ 明示的な作業状態
+ 直近の必須の観測
+ 今回選び直した記憶
→ モデル → 明示検索・参照・編集 → 次の自動read
```

前回の記憶ブロックは置き換えます。検索信号は元の要求・作業状態・観測から作り、前回の自動取得本文を機械的に再投入しません。推論状態が過去の記憶から影響を受けることまで分離できるとは主張しません。

## 動く最小ハーネス

```ts runnable
import {
  MemoryHost,
  LocalAuthority,
  MemoryHarness,
  utf8Tokenizer,
  type HarnessModel,
} from 'atom-memory';
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
  actor: { type: 'human' },
});
await memory.write('認証には管理者の承認が必要です');
const model: HarnessModel = {
  id: 'documentation-mock',
  tokenizer: utf8Tokenizer,
  contextWindow: 16384,
  networkCallsPerCall: 0,
  async respond(input) {
    return { kind: 'finish', output: input.memory };
  },
};
const harness = new MemoryHarness({ memory, model, instruction: '記憶を資料として利用する。' });
const result = await harness.run({ input: '認証の条件は？' });
if (result.status !== 'completed') throw new Error(result.error);
console.log(result.output);
```

これは決定的mockです。意味品質の評価には使いません。モデルの応答は`search`、`inspect`、`resume`、編集操作、`continue`、`finish`です。モデルには`m1`などの実行内参照名と`c1`などの継続名を発行し、実在しない値を拒否します。権限・出典区分・IDをモデルに割り当てさせません。

`run({ commit: 'edit' })`はホストがその実行の編集を許可する設定です。一つのprivate overlayで全ステップを実行し、最後に一度だけ確定します。既定は`read-only`。入力に触れた全receiptを保持し、生成物の前提・情報流を検証します。単独の生成エージェント用クライアントに、ホストが渡していない外部モデル入力まで自動追跡する機能はありません。モデルを経由する処理にはこのハーネス、または同じ実行traceを管理するホストを使ってください。

## 完全なWriterサンプル

原資料→Writerの整理→質問→訂正→再読→旧まとまりの参照を一続きで実行します。`npm run example:writer`は決定的モデル、`npm run example:live`は設定済みローカルモデルを使います。

<<< ../examples/writer.mjs

## 実際のローカルモデル接続

`examples/llama-cpp.mjs`は[llama.cppの公式サーバー契約](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)に接続します。`/props`でウィンドウを確認し、`/apply-template`でモデル固有のチャット形式を適用してから、`/tokenize`で数えた同じtoken ID列を`/completion`へ送ります。固定指示とツール形式を含む直列化済み入力を数え、出力上限を予約します。操作JSONのschemaを指定し、`actionKinds`でホストが許可した操作の一部だけへ制限できます。取得本文の制御token区切りはJSON内でescapeし、指示領域への構造的な昇格を防ぎます。APIキーは任意の`LLAMA_API_KEY`から読み、AbortSignalをHTTPリクエストへ渡します。各ステップの前処理3通信とモデル1通信を共有予算へ計上します。Writerと比較例は1実行5分の期限を指定します。

ホストが用意したGGUFモデルとllama-serverを使用します。モデルの取得や外部サービスへのデータ送信はこのコマンドでは自動実行しません。

```sh
hf download Qwen/Qwen2.5-7B-Instruct-GGUF \
  --revision bb5d59e06d9551d752d08b292a50eb208b07ab1f \
  --include 'qwen2.5-7b-instruct-q4_k_m-*.gguf' --local-dir ./models/qwen
llama-server -m ./models/qwen/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf \
  -c 8192 --parallel 1 --host 127.0.0.1 --port 8080 --no-context-shift
# サーバーが model loaded を出した後、別ターミナルで実行
curl --fail http://127.0.0.1:8080/health
LLAMA_URL=http://127.0.0.1:8080 LLAMA_CONTEXT=8192 LLAMA_MODEL_ID=Qwen2.5-7B-Instruct-Q4_K_M npm run example:live
LLAMA_URL=http://127.0.0.1:8080 LLAMA_CONTEXT=8192 LLAMA_MODEL_ID=Qwen2.5-7B-Instruct-Q4_K_M npm run evaluate:live
```

サンプルは合成資料のみを送ります。実LLM Writerでは、ホストが書込結果から記述・関係・終了の現在段階を明示し、許可する操作を絞ります。モデルが本文と役割と参照を生成します。任意の編集タスクを自律計画できるという試験ではありません。接続先を明示していない検証では **実LLMは未実行** と報告します。固定モデル・単一スロットのサーバーが対象で、隠れ状態や生成中の任意位置へ文脈を差し込むアダプターではありません。

## 予算と保持

自動read、明示ツール、依存検証、埋め込み、任意の再生成、確定再試行、モデル呼出しは一つの`BudgetLedger`を共有します。`tokens`は今回の記憶領域、`limit`は結果数、runの`budget`は実行全体です。外部呼出し前に上限を予約し、失敗した呼出しも消費します。adapter内部で未計上の再試行をしないでください。

最終シリアライズした全入力と出力予約がウィンドウを超えると`CONTEXT_WINDOW_EXCEEDED`で止まり、固定入力を黙って切りません。直近の観測は既定2件、1件64KiBまで。ホストが保持する監査ログは既定128件・1MiB・1時間までで、モデルへ全履歴を連結しません。`audit(runId)`も現時点の権限を確認します。

モデルへ次の入力を渡す前とモデル応答後に、過去に利用した状態の依存を再検証します。失効時は実行を停止し、保持ログを除去します。新しい権限に合わせて再実行・再構成できます。すでに外部へ送った情報を回収する機能ではありません。
