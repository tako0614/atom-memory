# 保存と検索の設定

ホストの設定で、保存先・検索表現・予算を選べます。アプリから使う `write`、`search`、`inspect`、`read`、`edit` の流れは共通です。

| 設定したいこと               | 選択肢                 |
| ---------------------------- | ---------------------- |
| まず動かす、テストで使う     | 既定の `MemoryStorage` |
| ローカルのファイルに残す     | `SqliteStorage`        |
| ベクトルによる候補も取得する | `embedding`            |
| 候補取得の方式を実装する     | `candidateProvider`    |
| 失効した生成表現を作り直す   | `generator`            |

## SQLite に保存する

`atom-memory/sqlite` の `SqliteStorage` にファイルパスを渡します。本文、関係、不変版、出典、履歴の構成を同じデータベースに保存します。

```ts runnable
import { MemoryHost, LocalAuthority } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';

const storage = new SqliteStorage('notes.sqlite');
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'support-app',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const memory = new MemoryHost({ storage, authority }).connect({
  auth,
  writePolicy: 'notes',
  actor: { type: 'human' },
});
try {
  const rule = await memory.write('招待リンクの有効期限は24時間です。');
  console.log((await memory.inspect(rule.ref)).atom.text);
} finally {
  storage.close();
}
```

このファイルは終了後も残ります。テストでファイルを作りたくない場合は `':memory:'` を指定します。SQLite は WAL と短い同期トランザクションを使い、モデル応答待ちの間はトランザクションを保持しません。

既定の同期モードは `FULL` です。再取得できる原文の大量取り込みでは、`new SqliteStorage(path, { synchronous: 'NORMAL' })` としてディスク同期をまとめられます。原文側のキューを削除する前、または処理済み位置を永続化する前に、必ず `storage.flush()` を呼びます。flushは先行するWAL書き込みをFULLコミットで同期し、失敗時は例外を返します。flush前にホストの電源が失われると直近の書き込みを失う場合があるため、このモードは未確認の原文を再処理できる取り込みだけに使います。

`LocalAuthority` はプロセス内の認証を試すための実装です。再起動をまたいで同じクライアントの参照や cursor を使うアプリでは、ホストが安定した認証ハンドルを解決する `Authorizer` を実装します。保存と認証の寿命を合わせて設計してください。

## 埋め込みを設定する

`MemoryHost` の `embedding` にエンコーダーを一度設定します。検索時の通常引数は引き続きテキストです。設定する `EmbeddingProvider` は次の情報を持ちます。

| フィールド             | ホストが指定する内容                             |
| ---------------------- | ------------------------------------------------ |
| `id`                   | エンコーダーの版と変換設定を識別する名前         |
| `dimensions`           | 出力ベクトルの次元                               |
| `tokenizer`            | 埋め込み入力の消費量を数えるカウンター           |
| `networkCallsPerCall`  | 一回の `embed` で使う通信回数                    |
| `embed(texts, signal)` | 入力順にベクトルを返す処理。キャンセルを伝搬する |

設定済みの `embedding` と認証を使い、次のように索引を準備します。

```ts
const host = new MemoryHost({ authority, embedding });
const binding = {
  auth,
  writePolicy: 'notes',
  actor: { type: 'human' as const },
};
const memory = host.connect(binding);
await memory.write('招待リンクの有効期限は24時間です。');

const prepared = await host.prepareIndex(binding, { limit: 100 });
if (prepared.cursor) {
  await host.prepareIndex(binding, { limit: 100, cursor: prepared.cursor });
}
const page = await memory.search('招待リンクの期限');
```

保存直後は語彙から検索でき、`prepareIndex` が埋め込み索引を更新します。大量の投入では `cursor` をホストのジョブに持たせて処理を続けます。検索結果の `diagnostics.index` で反映待ちを確認できます。

検索表現には本文と順序付きの役割・参照先本文を使います。同一入力・同一設定の埋め込みは、認証と権限を含むキーで再利用します。エンコーダーの版や変換を変えたら設定も更新してください。次元が同じでも、互換でない検索信号は `MODEL_SPACE_MISMATCH` になります。

## 候補の探し方と規模

既定の方式は `local-exact-lexical-vector-v1` です。語彙の一致と、利用可能な互換ベクトルの cosine を使って候補を評価します。走査した範囲を採点してから関連度順にページを返します。

一回の走査は既定10,000件までです。それより大きい対象は部分探索となり、cursor で先を探索できます。最初のページだけで全データの上位結果を確定できるわけではないため、`diagnostics.traversal` と `scanned` を確認してください。[ローカル測定](/acceptance)に件数別の結果があります。

`candidateProvider` に独自の `CandidateProvider` を渡すと、同じ取得処理を search・read・Writer で共有できます。プロバイダーには許可された資料への `CandidateAccess`、共有予算、キャンセル信号が渡されます。

大量の原文をローカルDBで扱う場合は、`candidateProvider: new LexicalCandidateProvider()` を選べます。本文の語彙一致を保存層で絞ってから有限の候補を採点するため、無関係な先頭IDだけで走査予算を使い切ることを避けます。認可と読取snapshotは同じhostの`CandidateAccess.page`を通ります。本文を入口にする近似方式なので、関係先の本文だけが一致する候補まで完全に拾う保証はなく、`approximate=true`を返します。埋め込みが有効な場合は既定の完全走査方式へ戻ります。

同梱の検索はローカルの完全走査を基準とする実装です。大規模な ANN やリモート索引を導入する場合は、取得品質、認可、通信の計数、読取状態の整合性をそのアダプターで検証します。`StorageAdapter` 自体は同期ローカル保存の契約です。

## 関係が変わった説明を作り直す

`generator` にはサービスAPIもローカルモデルも接続できます。`id`、`tokenizer`、出力上限、通信回数と `generate(input, signal)` を設定します。既定のreadはLLMを呼びません。

派生物を作るときのsearch・inspectの対象と取得条件を、SDKが宣言的な計画として記録します。所属が変わった後は、今回の読取状態で計画を先頭から実行します。古いreceiptの入力一覧は監査用に残し、現在の構成へ戻すためには使いません。

次の例では、要約を保存した後にルールを追加し、そのルールが生成器へ届くことを確認できます。

<<< ../examples/regeneration.mjs

```text output:regeneration.mjs
追加したルールが再生成の入力に入りました。
```

生成器の `input.sources` は選び直した内容、`input.atoms` はその役割付き関係と出典、`input.receipt` は新しい入力記録です。`previous` は古い表現であり、現在の原資料として扱いません。生成結果は認証・入力・設定に束縛した一時cacheへ保存し、元のAtomやreceiptは書き換えません。

再取得は既定10,000候補と同じ実行の総予算で制限します。探索の途中なら生成器を呼ばず、利用可能な資料と `pending / acquisition-incomplete` を返します。生成中に依存する版や検索範囲が変われば `STATE_INVALIDATED` になります。blobを入力とする再生成は `pending / unsupported-input` です。必要範囲を `inspect` で読み、ホストの入力アダプターから扱ってください。旧データの計画追加は [移行](/migration)にあります。

## 長い原資料を読む

長文や非テキストの原資料は、入力アダプターが `host.ingestBlob` から保存できます。`inspect` の範囲指定で必要な部分を取得します。

```ts runnable
import { MemoryHost, LocalAuthority, type ClientBinding } from 'atom-memory';

const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'document-importer',
  readPolicies: ['notes'],
  writePolicies: ['notes'],
  canIngestSource: true,
});
const host = new MemoryHost({ authority });
const binding: ClientBinding = {
  auth,
  writePolicy: 'notes',
  actor: { type: 'input-adapter' },
};
const memory = host.connect(binding);
const document = await host.ingestBlob(
  new TextEncoder().encode('招待手順の原文。リンクの有効期限は24時間です。'),
  'text/plain',
  binding,
);
const detail = await memory.inspect(document.ref, {
  depth: 0,
  range: { start: 0, bytes: 48 },
});
console.log(detail.range?.text);
if (detail.cursor) {
  const next = await memory.inspect(document.ref, {
    depth: 0,
    range: { start: 0, bytes: 48 },
    cursor: detail.cursor,
  });
  console.log(next.range?.text);
}
```

範囲は UTF-8 の境界を保ちます。非テキストでは `range.base64`、全体の大きさは `range.totalBytes` で受け取ります。継続時は同じ範囲設定と cursor を渡します。

## 保持期間と上限

| 対象                                        | 既定値・上限                             |
| ------------------------------------------- | ---------------------------------------- |
| 一つの Atom                                 | 本文64KiB、参照・出典各128件             |
| 一回の確定                                  | 256 Atom、要求2MiB                       |
| 候補走査                                    | 10,000件                                 |
| 継続する入力 manifest                       | 10,000版                                 |
| cursor                                      | 5分                                      |
| 一時的な読取 trace                          | 1,024件・1時間                           |
| 埋め込み cache                              | 512件・5分                               |
| 保持した履歴                                | 30日。構成の読取はページ・実行予算で制限 |
| snapshot保持機能がないadapterの履歴manifest | 256 Atom                                 |

`MemoryHost` の `maxScan`、`cursorTtlMs`、`traceMaxEntries`、`traceTtlMs`、`cacheMaxEntries`、`cacheTtlMs`、`historyMaxAtoms`、`historyRetentionMs` で対応する値を設定できます。各実行の予算は [API](/api#共通の戻り値と診断)と [ハーネス](/runtime#予算を設定する)で調整します。

確定した版と出典 manifest は保存先に残ります。このローカル実装は旧版を自動 GC しないため、保存容量・バックアップ・物理削除はホストで管理します。`MemoryStorage` の保持はそのインスタンスの寿命まで、`SqliteStorage` の保持はDBの再オープン後も有効です。保持期間は閲覧の期限であり、期限到達時に物理容量が回収される保証ではありません。

管理操作 `purge` は対象と依存物の閲覧を拒否し、派生 cache・索引・cursor を無効化します。snapshotは構成を事前列挙しないため、削除で関係が欠けたことを「当時の完全な構成」と誤認しないよう、この実装では **purge時に既存の保持snapshotをすべて失効**させます。無関係な履歴も `HISTORY_EXPIRED` になります。SQLite の物理ページ回収や外部ログの削除も、保存先の運用に含めてください。

独自adapterは、snapshot読取とは別に `retainSnapshot(at, until)` と `retainedSnapshot(token)` で、指定した版と関係を期限まで保持する契約を実装できます。保持の確定は短い書込トランザクションに参加します。両方のメソッドがなければ、ホストは明示した構成計画に従って有限のmanifestを保存し、予算不足では後継の採用も失敗させます。
