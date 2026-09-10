# 保存・検索アダプター

## 同梱する保存

| adapter         | 用途                         | 保証                                                                             |
| --------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `MemoryStorage` | 参照実装、試験、一時的な実行 | プロセス内 snapshot・原子バッチ                                                  |
| `SqliteStorage` | ローカルの永続メモリ         | 不変版履歴、短い SQLite トランザクション、再起動後の receipt / cursor / 冪等キー |

SQLite は WAL と `synchronous=FULL` を使います。同じ DB を複数プロセスから使う場合も、write は DB のトランザクションで確定します。ローカルの commit 順を、分散環境の全世界時刻とは扱いません。

メモリ adapter の検索は参照用の走査です。SQLite は版 ID と関係の索引を持ち、語彙入口は正規化された本文への部分一致です。ベクトル検索も有限候補内の参照実装です。大規模データ向けの FTS / ANN、分散配置・移動・複製は別 adapter の実装と評価が必要です。

## 埋め込み

```ts
const memory = new AtomKernel({
  authority,
  storage,
  tokenizer: answerModelTokenizer,
  embedding: {
    id: 'encoder-v1:space-768',
    dimensions: 768,
    tokenizer: encoderTokenizer,
    networkCallsPerCall: 1,
    async embed(texts, signal) {
      return yourEncoder(texts, { signal });
    },
  },
});

await memory.index(pin('note', 'note:1'), auth, defaultBudget);
```

`index()` は明示的なホスト操作です。原資料の write は高価な埋め込みの完了を待ちません。索引未作成の新情報も語彙・有限候補の入口に残り、診断は `lagging` になります。

空間 ID と次元が一致するベクトルだけを比較します。入力の query / context / reasoningState は存在するものを同じ encoder へ渡します。異なるモデルの隠れ状態を自動的に比較しません。

## 独自 adapter の責任

`StorageAdapter` は内部インターフェースです。`transaction()` は同期の短い操作に限定します。`get` と `scan` は指定 watermark の版を返し、現在の purge を適用してください。保存先を変えても Atom ID は変えません。

`capabilities` で提供できる保証を宣言します。snapshot・原子バッチ・範囲 guard の非対応を隠してはいけません。リモートの非同期ストレージを接続する場合は、同期ローカル契約の置換だけで済むとせず、通信予算・整合性・短い確定のプロトコルまで実装してください。

## ローカル参照実装の上限

既定では一 Atom 64 KiB、slot / origin 各 128、write バッチ 256、write 要求 2 MiB、一 read の候補上限 10,000 です。ホストの `limits` で設定できます。一つの継続 context の依存 manifest にも候補上限を適用します。これは操作・実行状態の上限であり、ライブラリ全体の保存件数の上限ではありません。
