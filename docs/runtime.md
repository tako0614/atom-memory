# エージェントにつなぐ

`MemoryHarness` は、モデルを呼ぶ前にその作業に関連する記憶を取得します。アプリがユーザーの要求を渡すと、ハーネスが `read`、モデル呼出し、モデルが選んだ操作、次の `read` を進めます。

回答だけを行うエージェントにも、メモを整理する Writer にも使えます。

## モデルには何が渡るか

```text
ホストの指示・今回のユーザー入力・初期観測
＋ 現在の作業状態
＋ 直近のツール結果
＋ 今回選んだ記憶
→ モデル呼出し
→ 検索・参照・編集などの操作
→ 記憶を選び直し、次のモデル呼出しへ
```

例えば最初は「招待リンクの期限」、次は「参加承認」を調べるなら、各ステップでその文脈に合う記憶を選びます。前回の記憶領域は今回の結果で置き換えます。

モデルに渡すのは `read.text` を展開した領域です。共有引用の証拠本文・範囲対応をそのまま使い、元の `items` を追加しません。参照名を短縮した後、固定入力・ツール形式・出力予約を含む最終シリアライズを計測します。

検索の入力には、ユーザーの要求、明示的な作業状態、新しい観測を使います。前回自動で取得した本文を丸ごと次の検索入力へ連結しないため、新しい問いに応じて候補を選び直せます。

## 自動取得を試す

次の例は、モデルに届いた記憶をそのまま返すテスト用モデルです。モデルが検索操作を選ばなくても、コーヒーの好みが入力に入ることを確認できます。[クイックスタート](/guide#_2-ファイルを用意する)の `memory.mjs` と一緒に使います。外部通信は発生しません。

```ts runnable
import { MemoryHarness, utf8Tokenizer, type HarnessModel } from 'atom-memory';
import { memory } from './memory.mjs';

await memory.write('コーヒーはブラックが好き。');

const model: HarnessModel = {
  id: 'show-recalled-memory',
  tokenizer: utf8Tokenizer,
  contextWindow: 16384,
  networkCallsPerCall: 0,
  async respond(input) {
    return { kind: 'finish', output: input.memory };
  },
};
const harness = new MemoryHarness({
  memory,
  model,
  instruction: '記憶を参考に、ユーザーの好みに合わせて提案する。',
  memoryTokens: 4096,
});
const result = await harness.run({ input: 'コーヒーの好みに合わせて提案して。' });
if (result.status !== 'completed') throw new Error(result.error);
console.log(result.output);
```

`result` には `status`、`output`、`steps`、実行全体の `usage` が入ります。編集を伴う実行では、確定した Atom が `changes` に入ります。

## モデルが選べる操作

モデルアダプターは `ModelAction` を返します。ハーネスが操作を実行し、結果を次の呼出しの `observations` に渡します。

| 操作                                        | 何をするか                           |
| ------------------------------------------- | ------------------------------------ |
| `search`                                    | 内容で追加の候補を探す               |
| `inspect`                                   | 参照先の本文・関係・出典を調べる     |
| `resume`                                    | 検索や参照の続きを取得する           |
| `write` / `revise` / `retire` / `supersede` | 編集を draft に加える                |
| `continue`                                  | 作業状態を更新して次のステップへ進む |
| `finish`                                    | `output` を返して終了する            |

参照は `m1`、続きは `c1` のような実行内の短い名前でモデルへ渡します。例えば検索結果の `cursor` が `c1` なら、モデルは次の操作で続きを要求できます。

```json
{ "kind": "resume", "cursor": "c1", "limit": 10 }
```

ハーネスは対応するクエリ・読取状態を保持して再開します。`m1` や `c1` は発行済みのものだけを受理します。各操作に `state: { context, thought }` を付けると次の作業状態を更新できます。推論テキストが得られないモデルでも、ユーザー入力と観測から動きます。

## Writer に整理を任せる

Writer は、記憶を読んで説明や関係を作るエージェントです。原資料を投入するクライアントと同じホストへ接続し、書き手を生成エージェントとして設定します。

```ts
const writer = host.connect({
  auth,
  writePolicy: 'notes',
  actor: { type: 'agent', generatedOrigin: 'organization' },
});
const writerHarness = new MemoryHarness({
  memory: writer,
  model,
  instruction: '原資料の条件を保って、手順の説明と資料への関係を作る。',
});
const organized = await writerHarness.run({
  input: '招待と参加の手順を整理してください。',
  commit: 'edit',
});
```

`model` には編集操作を返すモデルを渡します。`commit: 'edit'` の間、Writer は自分の変更を検索・参照できます。書込結果には `operation` と `status: 'staged'` が付き、作成した参照を次の関係に使えます。全ステップが成功し、入力や版の前提を検証できたら一度に確定します。既定の `run` は読取専用です。

ハーネスはモデルに見せた資料の依存を記録します。引用の指定に加えて入力全体を追跡することで、資料の変更や権限失効を次のモデル呼出しや確定時に検証できます。

外付けの関係を持つ整理をモデルの `supersede` 操作で更新する場合は、ホストが `MemoryHarness` の `historyComposition` に構成計画を設定します。モデルの任意の役割宣言を、そのまま履歴の構成規則として採用しません。サンプルでは、ホストが指定した「説明と原資料を接続する」操作の結果を検証してから、構成を確定します。

[完全な Writer サンプル](https://github.com/tako0614/atom-memory/blob/main/examples/writer.mjs)では、次の流れを一続きで実行します。

1. 入力アダプターが条件付きの原資料を保存する。
2. Writer が資料を読み、説明と関係を作る。
3. 質問に必要な記憶を取得する。
4. 原資料を訂正し、新しい整理を後継として採用する。
5. 訂正後の情報を読み直す。
6. 置き換える前の整理から、当時の資料を確認する。

リポジトリで `npm run example:writer` を実行すると、決定的なテスト用モデルでこの流れを確認できます。実際のモデルを使う場合は次の手順へ進んでください。

## ローカルモデルで動かす

リポジトリの [llama.cpp アダプター](https://github.com/tako0614/atom-memory/blob/main/examples/llama-cpp.mjs)と [実行例](https://github.com/tako0614/atom-memory/blob/main/examples/live.mjs)を使えます。GGUF モデルを llama-server で起動し、`LLAMA_URL` を指定します。

まずサンプルを取得します。

```sh
git clone https://github.com/tako0614/atom-memory.git
cd atom-memory
npm ci
npm run build
```

`hf` と `llama-server` をインストール済みの環境では、検証に使ったモデルを次のように起動できます。モデルファイルのダウンロードには数GBのディスク容量が必要です。

```sh
hf download Qwen/Qwen2.5-7B-Instruct-GGUF \
  --revision bb5d59e06d9551d752d08b292a50eb208b07ab1f \
  --include 'qwen2.5-7b-instruct-q4_k_m-*.gguf' --local-dir ./models/qwen
llama-server -m ./models/qwen/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf \
  -c 8192 --parallel 1 --host 127.0.0.1 --port 8080 --no-context-shift
```

起動後、別ターミナルで接続を確認し、Writer を実行します。

```sh
curl --fail http://127.0.0.1:8080/health
LLAMA_URL=http://127.0.0.1:8080 LLAMA_CONTEXT=8192 LLAMA_MODEL_ID=Qwen2.5-7B-Instruct-Q4_K_M npm run example:live
```

サンプルは合成した運用メモを使います。ホストが「説明を作る → 関係を作る → 終了する」という段階を指定し、モデルが本文・役割・参照を生成します。実行結果の比較は [検証ページ](/acceptance)にあります。

アダプターは [llama.cpp のサーバー API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)でチャット形式を適用し、実際に送る入力のトークンを数えます。`LLAMA_API_KEY` が設定されていれば認証に使い、キャンセルは HTTP リクエストへ伝搬します。モデル呼出しの区切りで記憶を更新する構成です。

## 予算を設定する

`memoryTokens` は各ステップの記憶領域、`maxOutputTokensPerStep` は各応答の予約、`run({ budget })` は実行全体の上限です。

```ts
const result = await harness.run({
  input: '招待リンクの有効期限と参加条件を確認して案内文を作る。',
  budget: {
    maxModelCalls: 6,
    maxModelInputTokens: 48000,
    maxModelOutputTokens: 6000,
    maxNetworkCalls: 24,
    deadline: new Date(Date.now() + 300000).toISOString(),
  },
  signal: AbortSignal.timeout(300000),
});
```

自動取得、明示ツール、埋め込み、再生成、モデル呼出し、確定の再試行は同じ予算へ計上します。llama.cpp の例は一ステップにつき前処理3通信とモデル1通信を数えます。

モデルアダプターは、指示・ツール形式・資料を含めた実際の送信内容を `serialize` で定義します。全入力と出力予約がモデルのウィンドウを超えたら `CONTEXT_WINDOW_EXCEEDED` で停止します。大きい固定入力は、アプリ側で分割するか明示的に保留できます。

## 作業状態と監査を保持する

モデルに渡す直近の観測は既定2件、一件64KiBまでです。ホスト側の監査ログは既定128件・1MiB・1時間で、`harness.audit(runId)` から確認できます。ログはモデル入力とは別に保持します。

モデル呼出し前後に、利用済み資料の権限と依存を検証します。権限が失効したら実行を止めて保持ログを除去し、新しい権限で再構成する経路へ進めます。外部モデルへ送信済みの情報の管理は、接続先を含めたホスト側で行います。

## 長期履歴とまとめての編集

`batch` は複数の `write` / `revise` と関係の追加を1回のモデル応答にまとめます。ホストから `basis: 'historical'` を指定し、期間をまたいで過去の整理を維持・更新できます。[長期間の履歴をWriterで整理する](/history)に実行例、参照名の扱い、確定・再開・費用の境界をまとめています。
