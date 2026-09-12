# エージェントにつなぐ

エージェントがモデルを呼ぶ前に `memory.read(state)` を呼び、その回の記憶をモデル入力へ入れます。Atomはモデルの応答形式やツールループを定義しません。

```ts runnable
import type { AtomRef, MemoryAPI, MemoryState } from 'atom-memory';

// This function belongs to the application. Its model and scheduling are injected.
export async function answer(
  memory: MemoryAPI,
  state: MemoryState,
  request: (input: { context: MemoryState; memory: string }) => Promise<string>,
  enqueueRefresh: (refs: readonly AtomRef[]) => Promise<void>,
) {
  const recalled = await memory.read(state, { tokens: 4000 });
  if (recalled.stale.length) await enqueueRefresh(recalled.stale);
  return request({ context: state, memory: recalled.text });
}
```

複数ステップのAgentも同じです。アプリが新しい文脈・観測・明示的な検討状態を渡し、モデル呼出しごとに記憶領域を入れ替えます。前回入れた記憶をそのまま次回の検索文に足す必要はありません。`thought` はホストから渡せるテキストで、モデル内部の非公開思考を自動取得する機能ではありません。

モデル入力の全体長、応答予算、タイムアウト、ツールの権限、モデル呼出し中の入力変更、再開用チェックポイントはアプリが管理します。Atomの操作予算は、その中で記憶を取得・編集する費用を制限します。

## Writerに整理を任せる

Writerはモデルの結果を検証し、`write` / `edit` を呼ぶアプリ側のAgentです。次の例は、原資料の変更で古い整理が通知され、ホストが明示的に再生成して同じAtomを改訂する流れです。

<<< ../examples/writer.mjs

```text output:writer.mjs
古い整理を通知: 1
Writer改訂後の未更新: 0
観測済み原文: 旧クライアントで認証を利用できる。
```

既定の `generate` は決定的な文字列処理です。APIの例であり、LLM品質の実証ではありません。実モデルはこのホスト関数へ渡します。モデル応答を待つ間も編集は非公開で、確定時に入力版・権限・CASを検証します。

## Sakanaでの接続

Sakanaは通常会話・警察・裁判・議会・Memory Writerで一つの `runAgent` を使います。`memory_focus` で明示されたcontext/thoughtを次のreadへ渡し、選んだ記憶は一回のモデル入力にだけ入れます。

`stale` の通知は、同じサーバー・チャンネルの既存Writerキューに入れます。同じ古いバッチからの再処理要求は重複させず、課金するモデル呼出しはWriterのスケジュール・費用制御を通ります。read中に別の生成器を起動することはありません。

Writerは公開receiptを実行中プロセスで認可確認に使い、receipt自体はcheckpointへ保存しません。checkpointにはモデルが採用した既存Atomのentry・sourceと正確なbatch ID・Atom refを保存します。readが触れたstale・拒否候補を、そのままモデル入力のaccepted lineageに含めることはありません。モデル応答後とcommit直前にreceipt認可とaccepted batch headを検証し、最終editでは採用refを `version: 'latest'` で再確認します。checkpoint復元時も正確な採用refを再束縛し、明示的なrevise対象はrevision CASで扱います。モデルリンクがない出力でも、実際に見た組織化入力の依存はdurable lineageとして保持されます。

checkpoint復元時にaccepted headが変わっていれば、キャッシュしたモデル出力を再利用せずreadから再開します。明示的なreviseはrevision CASと確定した置換版のcurrentnessを検証します。Sakanaの再処理は、同じ古いbatchから一度だけ要求し、`queued_at` を含む新しいbatch IDで原文が同じ再整理も区別します。
