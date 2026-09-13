# 保存と検索の設定

ホストの設定で、保存先・検索表現・予算を選べます。アプリから使う `write`、`search`、`inspect`、`read`、`edit` の流れは共通です。

| 設定したいこと                 | 選択肢                 |
| ------------------------------ | ---------------------- |
| まず動かす、テストで使う       | 既定の `MemoryStorage` |
| ローカルのファイルに残す       | `SqliteStorage`        |
| ベクトルによる候補も取得する   | `embedding`            |
| 候補取得の方式を実装する       | `candidateProvider`    |
| 利用状態モデル・増幅・関係重み | `activation`           |
| 候補・グラフ・探索の上限       | `retrieval`            |

## SQLite に保存する

`atom-memory/sqlite` の `SqliteStorage` にファイルパスを渡します。本文、関係、不変版、出典を同じデータベースに保存します。

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

スコープ内のID順ページングとメタデータのprefix検索は索引を使います。キャッシュの整理で原文・索引の全メタデータを走査しないため、保存量が増えても無関係な本文を読み込まずに済みます。

SQLiteのpurgeは、全履歴の出典・生成入力とlegacy linksを逆引きします。新しい検証済み契約の通常関連は本文消去に使いません。新旧の判定と未完了時の停止・再開は[移行](/migration)を参照してください。旧DBでは依存索引を一度移行し、原記録を再採番しません。新旧writerの同時運用はサポートしません。

既定の同期モードは `FULL` です。再取得できる原文の大量取り込みでは、`new SqliteStorage(path, { synchronous: 'NORMAL' })` としてディスク同期をまとめられます。原文側のキューを削除する前、または処理済み位置を永続化する前に、必ず `storage.flush()` を呼びます。flushは先行するWAL書き込みをFULLコミットで同期し、失敗時は例外を返します。flush前にホストの電源が失われると直近の書き込みを失う場合があるため、このモードは未確認の原文を再処理できる取り込みだけに使います。

`LocalAuthority` はプロセス内の認証を試すための実装です。再起動をまたいで同じクライアントの参照や cursor を使うアプリでは、ホストが安定した認証ハンドルを解決する `Authorizer` を実装します。保存と認証の寿命を合わせて設計してください。

## 埋め込みを設定する

`MemoryHost` の `embedding` にエンコーダーを一度設定します。検索時の通常引数は引き続きテキストです。設定する `EmbeddingProvider` は次の情報を持ちます。

| フィールド                       | ホストが指定する内容                             |
| -------------------------------- | ------------------------------------------------ |
| `id`                             | エンコーダーの版と変換設定を識別する名前         |
| `dimensions`                     | 出力ベクトルの次元                               |
| `tokenizer`                      | 埋め込み入力の消費量を数えるカウンター           |
| `networkCallsPerCall`            | 一回の `embed` で使う通信回数                    |
| `embed(texts, signal, purpose?)` | 入力順にベクトルを返す処理。キャンセルを伝搬する |

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

保存直後は語彙から検索でき、`prepareIndex` がcurrent headをcursor付きで走査して埋め込み索引を更新します。大量の投入では `cursor` をホストのジョブに持たせて処理を続けます。変更後のheadだけを追う継続処理は `updateIndex` がsequence 0の変更フィードから行います。検索結果の `diagnostics.index` で反映待ちを確認できます。

検索表現は各Atom自身の本文だけです。役割付きリンクは検索表現へ本文を暗黙に連結せず、候補確定後の構造ランキングで一度だけ使います。同一入力・同一設定の埋め込みは、認証と権限を含むキーで再利用します。エンコーダーの版や変換を変えたら設定も更新してください。次元が同じでも、互換でない検索信号は `MODEL_SPACE_MISMATCH` になります。

## 候補の探し方と規模

埋め込みなしの既定は本文語彙を使うprovider、埋め込みありの既定は語彙とベクトルを組み合わせるproviderです。providerは認可済みの保存内容から候補の `PinnedRef` を返すだけで、候補の最終スコアや構造伝播は行いません。`ExactCandidateProvider` は明示した場合だけ使う有限走査の基準です。

取得上限の `maxScan` は `HostOptions.retrieval` で設定し、候補providerへ渡します。操作予算の一部を候補取得と評価計算に割り当てるため、上限に達したところで停止することがあります。候補は結果返却前に固定し、cursorはその結果の次ページです。未探索領域の続きではありません。`approximate` と `scanned` を確認し、大量のデータには語彙・ベクトルで候補を絞るproviderを選びます。`complete` は全コーパスの網羅を保証しません。

`candidateProvider` に独自の `CandidateProvider` を渡すと、同じ取得処理を search・read・Writer で共有できます。プロバイダーには許可された資料への `CandidateAccess`、共有予算、キャンセル信号が渡されます。

大量の原文をローカルDBで扱う場合は、本文の語彙一致を保存層で絞るproviderを選べます。保存層は認可済みの候補参照だけを返し、Engineが各revisionを再読して本文・鮮度・policyを検証します。本文を入口にする近似方式なので、関係先の本文だけが一致する候補まで完全に拾う保証はなく、`approximate=true` を返します。埋め込みがある場合は語彙候補とベクトル候補をCoreの同じ評価規則へ渡します。

組み込みproviderは埋め込みの有無に応じて語彙または語彙＋ベクトルの候補参照を返します。`ExactCandidateProvider` は有限の全走査を行う明示的な基準実装です。大規模な ANN やリモート索引を導入する場合は、参照の正確さ、認可、通信の計数、読取状態の整合性をそのアダプターで検証します。providerが返す score や本文は採用されません。`StorageAdapter` 自体は同期ローカル保存の契約です。

## 古い生成物を更新する

`read` / `search` の `stale` をアプリのWriterへ渡します。ライブラリは生成器や取得計画の再実行を持ちません。[Agent側の例](/runtime#小さなwriter例)を参照してください。

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

クライアントの候補予算は既定10,000件、本文転送は4MiBです。各呼出しの `budget` で変更できます。cursorは既定5分、確定した派生物の監査ではない一時traceは既定1時間・1,024件、ベクトルcacheは既定5分・512件です。`HostOptions` で対応する上限を設定します。

管理操作 `purge` は対象と依存物の閲覧を拒否し、関連ベクトルとcursorを無効化します。Memory/SQLiteの保持snapshotも失効します。SQLiteの物理ページ回収と外部ログの削除は保存先の運用です。

保存adapterの任意の `retainSnapshot(at, until)` / `retainedSnapshot(token)` はホストが明示して使う保存機能です。保持期間や構成の採用はライブラリが決めず、MemoryClientが自動で履歴snapshotへ切り替わることもありません。

## 継続して差分を索引へ反映する

Atom MemoryはJavaScriptライブラリです。サーバー、常駐worker、AIモデル、外部データ取得、課金管理は起動しません。呼び出す時期と回数はアプリケーションが決めます。

```js
// 履歴の取り込みと、新しいデータの両方に同じAPIを使う。
const source = await memory.write('資料の本文', { idempotencyKey: 'document:42:v1' });
// 必要なら既存のWriter／自分のagentで memory.edit(...) を行う。

// 今できたAtomを優先する場合。参照は同じbindingで発行したものを使う。
await host.indexAtoms([source.ref], binding, { limit: 64 });

// 既存履歴と、その後の改訂を有限量ずつ進める。進捗は保存層に残る。
const progress = await host.updateIndex(binding, { limit: 32 });
console.log(progress.indexed, progress.processed, progress.pending);
// pendingなら、アプリの次のジョブで同じ呼び出しを繰り返す。
```

`updateIndex` はSQLite／MemoryStorageのコミット順の変更フィードを使います。同一コミット内の複数Atomも、再起動・エンコーダー失敗・ページ境界をまたいで進められます。変更されたAtomの現在headだけを、そのAtom自身の本文から再計算します。リンク先の改訂や所属の追加だけで、本文が変わらない親を再エンコードしません。新しい表現設定では別の進捗として履歴を準備します。purgeは対象のベクトルも消し、無関係な索引を維持します。

これは意味を判断して説明を書き換えるAPIではありません。分解・再集約・説明の改訂はWriterが通常の `edit` で行い、索引はその受理済みの結果を扱います。外付けの所属が増えただけで親と全祖先を書き換えることもありません。

エンコーダーは `embed(texts, signal, purpose)` の第三引数で `'document'` と `'query'` を区別できます。第三引数を使わない既存の実装も動きます。文脈・`thought`・観測はquery側、Atomの検索表現はdocument側です。空間IDにはモデルの版・前処理・次元を含めてください。

SQLiteでベクトル候補も有限に絞る場合は、語彙・ベクトル候補を返すproviderを指定します。Coreは実ベクトルと保存本文を再読して初期活性を計算し、通常の関係探索を行います。非公開policyや過去版は候補の上限を適用する前に除外します。これは近似検索であり、`approximate=true`です。全世界の完全な上位候補や、百万件での応答性能を保証するものではありません。

## 候補とベクトルの設定を分ける

候補providerは入口を決め、取得後の[ランキング](/ranking)は共通です。providerの返却値は `PinnedRef[]` であり、スコア・本文・関係の重みを返す契約ではありません。Coreは保存層からrevisionを再読し、本文80%・語彙20%とモデルの利用状態から初期活性を作って関係伝播を評価します。`maxScan`、`maxNodes`、`maxEdges` と `maxEvaluationWork` で候補取得・グラフ評価を打ち切り、結果返却前に順位を確定します。cursorで探索範囲を無限に広げることはありません。

利用状態は `HostOptions.activation` で宣言します。既定の `adaptiveUse()` は初期半減期7日、最大半減期365日で、受理イベントの間隔に応じて状態を更新します。最大増幅0.3、伝播0.5、関係ごとの重みは従来の評価規則を維持します。主体・policy・revisionごとの状態は、成功したモデル応答後にホストが `recordUse(refs, binding, { eventId })` を呼んだときだけ更新されます。`read` や候補探索だけでは増えません。`activation.halfLifeMs` はありません。設定を変える場合は[移行](/migration)のモデルIDと状態失効規則を確認してください。

独自モデルは `AvailabilityModel<S extends Json>` を実装して `activation.model` に渡します。

```ts
import { MemoryHost, adaptiveUse } from 'atom-memory';

const model = adaptiveUse({
  initialHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
  maxHalfLifeMs: 365 * 24 * 60 * 60 * 1000,
});
const host = new MemoryHost({ activation: { model } });
```

`adaptiveUse` の状態は `{ mass, updatedAt, halfLifeMs }` です。受理イベントでは、現在の半減期で減衰したmassへ1を加え（上限1,000,000）、保持率に応じて半減期を初期値ぶん伸ばし（既定の上限365日、設定した `maxHalfLifeMs` があればその値）、`value` は現在時刻までmassを減衰させます。以前の0.6状態は読み出し時に正確に解釈され、readや再送では書き換えません。次の新しい受理イベントでだけ新形式へ書き換えます。

モデルの `id` は設定の意味とパラメータを含む識別子です。同じ意味の関数を再生成してもIDが同じなら状態を継続できます。IDが変わった状態は `STATE_INVALIDATED` となり、対象のscopeで `host.resetUse(binding)` を明示してから再開します。モデルのコールバックは同期的かつ純粋で、JSON状態は1 KiB以下、非有限値・Promise・例外はエラーです。ライブラリはscope、dedup、原子性、purgeを管理します。

ベクトルの設定は評価規則から独立しています。v3の表現とStorageの再利用条件、`StorageAdapter` の旧 `indexEntries` 境界は[移行](/migration)を参照してください。

### 索引の準備状態

`prepareIndex` の `pending: false` は、そのcurrent-head走査がcursorの終端へ到達したことを示します。`updateIndex` の `pending: false` は、その呼出しで処理したsequence 0起点の変更フィードに続きがないことを示します。旧索引メタデータが互換しない候補を調べた場合は `pending` として報告されます。提供中の全policy scopeを処理し、各scopeの永続checkpointが意図した終端へ到達してから、ホストはv3意味検索を準備済みと扱います。一つの呼出し、一つのチャンネル、または候補の存在だけでは全体の準備完了を証明できません。`complete`、`approximate`、`coverageCertified: false` もコーパス全体の網羅性を認証しません。
